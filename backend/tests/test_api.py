"""端到端流程：直接调用路由函数（TestClient 与本环境 starlette 不兼容）。"""
import pytest

from app import main, store
from app.models import CellUpdate, RunRequest
from app.seed import DEMO_ID


@pytest.fixture(autouse=True)
def fresh_demo(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    main._notebooks.clear()
    main.startup()
    yield


def by_name(nb):
    return {c["name"]: c for c in nb["cells"]}


def test_demo_failure_fix_edit_and_cycle_flow():
    # 1) 初始 demo：ratio 除零失败，report 被跳过，分叉其余分支正常
    nb = main.get_notebook(DEMO_ID)
    cells = by_name(nb)
    assert cells["summary"]["deps"] == ["peaks", "trend"]  # 分叉汇合
    assert nb["cycle"] is None

    res = main.run_notebook(DEMO_ID, RunRequest())
    rep = res["report"]
    assert "ratio" in rep["failed"] and "report" in rep["skipped"]
    assert {"raw", "trend", "peaks", "summary", "chart"} <= set(rep["ran"])
    cells = by_name(res["notebook"])
    assert cells["ratio"]["result"] is None
    assert cells["ratio"]["version"] == 0  # 失败不留伪成功
    assert cells["report"]["status"] == "stale"

    # 2) 修复参数：只重跑受影响的 ratio、report
    main.update_cell(DEMO_ID, cells["ratio"]["id"],
                     CellUpdate(params={"denominator": 2}))
    res = main.run_notebook(DEMO_ID, RunRequest())
    assert set(res["report"]["ran"]) == {"ratio", "report"}
    assert not res["report"]["failed"] and not res["report"]["skipped"]

    # 3) 修改 raw：分叉链与 chart 全部过期，仅重算受影响部分
    cells = by_name(res["notebook"])
    main.update_cell(DEMO_ID, cells["raw"]["id"],
                     CellUpdate(params={"n": 40, "seed": 1}))
    nb = main.get_notebook(DEMO_ID)
    stale = {c["name"] for c in nb["cells"] if c["status"] == "stale"}
    assert stale == {"raw", "trend", "peaks", "summary", "ratio", "report",
                     "chart"}
    res = main.run_notebook(DEMO_ID, RunRequest())
    assert set(res["report"]["ran"]) == stale
    chart = by_name(res["notebook"])["chart"]
    assert chart["result"]["chart"] == "line"
    assert len(chart["result"]["series"]) == 2  # 绘图沿用结果关系

    # 4) 再次运行：一切最新，无需重算（持久化后重开亦如此）
    res = main.run_notebook(DEMO_ID, RunRequest())
    assert not res["report"]["ran"] and not res["report"]["failed"]

    # 5) 制造循环引用并定位
    cells = by_name(res["notebook"])
    main.update_cell(DEMO_ID, cells["trend"]["id"],
                     CellUpdate(code="result = inputs['summary']"))
    nb = main.get_notebook(DEMO_ID)
    cyc = nb["cycle"]
    assert cyc and cyc[0] == cyc[-1]
    assert {"trend", "summary"} <= set(cyc)
    res = main.run_notebook(DEMO_ID, RunRequest())
    assert res["report"]["cycle"] == cyc
