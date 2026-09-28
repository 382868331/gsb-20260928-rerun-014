import pytest

from app import engine
from app.models import Notebook
from app.sandbox import SandboxError, run_cell
from app.seed import build_demo


def make_nb():
    return Notebook(id="t", title="t")


def test_basic_run_and_versions():
    nb = make_nb()
    engine.add_cell(nb, "a", "compute", "result = params['x'] * 2", {"x": 3})
    engine.add_cell(nb, "b", "compute", "result = inputs['a'] + 1", {})
    rep = engine.run_notebook(nb)
    assert rep.ran == ["a", "b"]
    a, b = nb.cells
    assert a.result == 6 and b.result == 7
    assert a.version == 1 and b.version == 1
    assert b.input_versions == {"a": 1}
    assert a.status == b.status == "fresh"


def test_edit_marks_dependents_stale_and_partial_rerun():
    nb = make_nb()
    engine.add_cell(nb, "a", "compute", "result = 1", {})
    engine.add_cell(nb, "b", "compute", "result = inputs['a'] + 1", {})
    engine.add_cell(nb, "c", "compute", "result = inputs['b'] + 1", {})
    engine.add_cell(nb, "solo", "compute", "result = 99", {})
    engine.run_notebook(nb)
    b_id = nb.cells[1].id
    engine.update_cell(nb, b_id, code="result = inputs['a'] + 10")
    status = {c.name: c.status for c in nb.cells}
    assert status == {"a": "fresh", "b": "stale", "c": "stale",
                      "solo": "fresh"}
    rep = engine.run_notebook(nb)
    assert rep.ran == ["b", "c"]  # a 与 solo 不重跑
    assert nb.cells[2].result == 12
    assert nb.cells[1].version == 2


def test_forked_dependencies_join():
    nb = build_demo()
    nb.cells[4].params = {"denominator": 2}  # 修复 ratio
    rep = engine.run_notebook(nb)
    assert set(rep.ran) == {"raw", "trend", "peaks", "summary", "ratio",
                            "report", "chart"}
    by_name = {c.name: c for c in nb.cells}
    assert by_name["summary"].deps == ["peaks", "trend"]
    assert by_name["chart"].kind == "plot"
    assert by_name["chart"].result["chart"] == "line"


def test_failure_leaves_no_result_and_blocks_downstream():
    nb = build_demo()  # ratio 的 denominator 为 0
    rep = engine.run_notebook(nb)
    by_name = {c.name: c for c in nb.cells}
    assert "ratio" in rep.failed
    assert "report" in rep.skipped
    assert by_name["ratio"].status == "error"
    assert by_name["ratio"].result is None
    assert by_name["ratio"].version == 0  # 失败不产生伪成功版本
    assert by_name["report"].status == "stale"
    assert by_name["report"].result is None
    # 修复后只重跑受影响部分
    engine.update_cell(nb, by_name["ratio"].id, params={"denominator": 2})
    rep2 = engine.run_notebook(nb)
    assert set(rep2.ran) == {"ratio", "report"}
    assert by_name["ratio"].status == "fresh"
    assert by_name["raw"].version == 1  # 未受影响单元不重跑


def test_cycle_detection_and_location():
    nb = make_nb()
    engine.add_cell(nb, "x", "compute", "result = inputs['y']", {})
    engine.add_cell(nb, "y", "compute", "result = inputs['x']", {})
    rep = engine.run_notebook(nb)
    assert rep.cycle is not None
    assert rep.cycle[0] == rep.cycle[-1]
    assert set(rep.cycle[:-1]) == {"x", "y"}
    assert all(c.status == "error" for c in nb.cells)
    assert all(c.result is None for c in nb.cells)


def test_missing_reference():
    nb = make_nb()
    engine.add_cell(nb, "a", "compute", "result = inputs['ghost']", {})
    rep = engine.run_notebook(nb)
    assert rep.failed == ["a"]
    assert "ghost" in rep.errors["a"]


def test_sandbox_blocks_file_and_import():
    with pytest.raises(SandboxError):
        run_cell("import os", {}, {})
    with pytest.raises(SandboxError):
        run_cell("open('/etc/passwd')", {}, {})
    with pytest.raises(SandboxError):
        run_cell("result = (1).__class__", {}, {})
    with pytest.raises(SandboxError):
        run_cell("eval('1+1')", {}, {})


def test_sandbox_allows_numpy_math():
    out = run_cell("result = float(np.mean([1, 2, 3])) + math.sqrt(4)",
                   {}, {})
    assert out == 4.0


def test_persistence_roundtrip(tmp_path, monkeypatch):
    from app import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    nb = build_demo()
    nb.cells[4].params = {"denominator": 2}
    engine.run_notebook(nb)
    store.save(nb)
    loaded = store.load(nb.id)
    assert loaded is not None
    assert loaded.model_dump() == nb.model_dump()
    # 重新打开后状态保留，再次运行无需重算
    rep = engine.run_notebook(loaded)
    assert rep.ran == [] and rep.failed == []
