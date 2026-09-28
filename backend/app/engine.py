from __future__ import annotations

import time
import uuid

from .graph import find_cycle, topo_order, transitive_dependents
from .models import Cell, Notebook, RunReport
from .sandbox import (CellTimeout, SandboxError, extract_refs, run_cell,
                      to_jsonable, validate_code)


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def dep_map(nb: Notebook) -> dict[str, list[str]]:
    return {c.name: list(c.deps) for c in nb.cells}


def cell_by_id(nb: Notebook, cell_id: str) -> Cell | None:
    return next((c for c in nb.cells if c.id == cell_id), None)


def cell_by_name(nb: Notebook, name: str) -> Cell | None:
    return next((c for c in nb.cells if c.name == name), None)


def refresh_deps(cell: Cell) -> None:
    """Re-parse code and update the declared dependency list."""
    try:
        tree = validate_code(cell.code)
        refs = extract_refs(tree)
    except SandboxError:
        refs = set()
    cell.deps = sorted(refs)


def mark_stale_with_dependents(nb: Notebook, names: list[str]) -> None:
    affected = transitive_dependents(dep_map(nb), names)
    for c in nb.cells:
        if c.name in names or c.name in affected:
            c.status = "stale"
            c.error = None


def add_cell(nb: Notebook, name: str, kind: str, code: str,
             params: dict) -> Cell:
    if cell_by_name(nb, name):
        raise ValueError(f"单元名已存在: {name}")
    cell = Cell(id=new_id(), name=name, kind=kind, code=code, params=params)
    refresh_deps(cell)
    nb.cells.append(cell)
    mark_stale_with_dependents(nb, [name])
    return cell


def update_cell(nb: Notebook, cell_id: str, *, name=None, code=None,
                params=None) -> Cell:
    cell = cell_by_id(nb, cell_id)
    if cell is None:
        raise KeyError("单元不存在")
    old_name = cell.name
    changed = False
    if name is not None and name != cell.name:
        if cell_by_name(nb, name):
            raise ValueError(f"单元名已存在: {name}")
        cell.name = name
        changed = True
    if code is not None and code != cell.code:
        cell.code = code
        changed = True
    if params is not None and params != cell.params:
        cell.params = params
        changed = True
    if changed:
        refresh_deps(cell)
        # Renamed cell: dependents referencing old name lose their input.
        mark_stale_with_dependents(nb, [cell.name, old_name])
    return cell


def delete_cell(nb: Notebook, cell_id: str) -> None:
    cell = cell_by_id(nb, cell_id)
    if cell is None:
        raise KeyError("单元不存在")
    nb.cells = [c for c in nb.cells if c.id != cell_id]
    mark_stale_with_dependents(nb, [cell.name])


def notebook_cycle(nb: Notebook) -> list[str] | None:
    return find_cycle(dep_map(nb))


def run_notebook(nb: Notebook, force: bool = False,
                 only_ids: list[str] | None = None) -> RunReport:
    report = RunReport()
    cycle = notebook_cycle(nb)
    if cycle:
        report.cycle = cycle
        in_cycle = set(cycle)
        for c in nb.cells:
            if c.name in in_cycle:
                c.status = "error"
                c.error = "循环引用: " + " -> ".join(cycle)
                c.result = None
                report.errors[c.name] = c.error
        report.failed = [c.name for c in nb.cells if c.name in in_cycle]
        return report

    deps = dep_map(nb)
    order = topo_order(deps)
    by_name = {c.name: c for c in nb.cells}
    only = set(only_ids) if only_ids else None

    # Which cells need to run?
    if force:
        targets = set(order)
    else:
        targets = {n for n in order if by_name[n].status != "fresh"}
    if only is not None:
        selected = {by_name[cid].name for cid in only if cell_by_id(nb, cid)}
        # include stale upstream deps of the selection
        upstream: set[str] = set()
        stack = list(selected)
        while stack:
            cur = stack.pop()
            for d in deps.get(cur, []):
                if d not in upstream:
                    upstream.add(d)
                    stack.append(d)
        targets &= (selected | upstream)

    for name in order:
        if name not in targets:
            continue
        cell = by_name[name]
        blocked_by = [d for d in deps[name]
                      if d in by_name and by_name[d].status != "fresh"]
        missing = [d for d in deps[name] if d not in by_name]
        if missing:
            cell.status = "error"
            cell.result = None
            cell.error = "引用了不存在的数据: " + ", ".join(missing)
            report.failed.append(name)
            report.errors[name] = cell.error
            continue
        if blocked_by:
            cell.status = "stale"
            report.skipped.append(name)
            continue
        inputs = {d: by_name[d].result for d in deps[name]}
        try:
            value = run_cell(cell.code, inputs, cell.params)
        except (SandboxError, CellTimeout) as exc:
            cell.status = "error"
            cell.result = None
            cell.error = str(exc)
            report.failed.append(name)
            report.errors[name] = cell.error
            continue
        except Exception as exc:  # cell computation raised
            cell.status = "error"
            cell.result = None
            cell.error = f"{type(exc).__name__}: {exc}"
            report.failed.append(name)
            report.errors[name] = cell.error
            continue
        cell.result = to_jsonable(value)
        cell.version += 1
        cell.input_versions = {d: by_name[d].version for d in deps[name]}
        cell.status = "fresh"
        cell.error = None
        cell.computed_at = time.time()
        report.ran.append(name)

    if report.ran or report.failed:
        nb.run_count += 1
    return report
