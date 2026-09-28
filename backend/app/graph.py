from __future__ import annotations


def find_cycle(deps: dict[str, list[str]]) -> list[str] | None:
    """Return a cycle as a path [a, b, ..., a] or None."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in deps}
    stack: list[str] = []

    def dfs(node: str) -> list[str] | None:
        color[node] = GRAY
        stack.append(node)
        for dep in deps.get(node, []):
            if dep not in deps:
                continue
            if color[dep] == GRAY:
                idx = stack.index(dep)
                return stack[idx:] + [dep]
            if color[dep] == WHITE:
                found = dfs(dep)
                if found:
                    return found
        stack.pop()
        color[node] = BLACK
        return None

    for n in deps:
        if color[n] == WHITE:
            found = dfs(n)
            if found:
                return found
    return None


def topo_order(deps: dict[str, list[str]]) -> list[str]:
    """Kahn's algorithm; assumes acyclic. Dependencies come first."""
    indeg = {n: 0 for n in deps}
    dependents: dict[str, list[str]] = {n: [] for n in deps}
    for n, ds in deps.items():
        for d in ds:
            if d not in indeg:
                continue
            indeg[n] += 1
            dependents[d].append(n)
    ready = sorted([n for n, dg in indeg.items() if dg == 0])
    order: list[str] = []
    while ready:
        node = ready.pop(0)
        order.append(node)
        for m in sorted(dependents[node]):
            indeg[m] -= 1
            if indeg[m] == 0:
                ready.append(m)
    return order


def transitive_dependents(deps: dict[str, list[str]], names: list[str]) -> set[str]:
    """All nodes that directly or transitively depend on any of names."""
    dependents: dict[str, list[str]] = {n: [] for n in deps}
    for n, ds in deps.items():
        for d in ds:
            if d in dependents:
                dependents[d].append(n)
    seen: set[str] = set()
    stack = list(names)
    while stack:
        cur = stack.pop()
        for m in dependents.get(cur, []):
            if m not in seen:
                seen.add(m)
                stack.append(m)
    return seen
