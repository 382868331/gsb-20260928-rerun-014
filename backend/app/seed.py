from __future__ import annotations

from . import engine
from .models import Notebook

DEMO_ID = "demo"


def build_demo() -> Notebook:
    nb = Notebook(id=DEMO_ID, title="演示：分叉依赖 + 中途失败 + 绘图")
    engine.add_cell(nb, "raw", "compute",
"""# 生成带噪声的正弦信号
n = params["n"]
x = np.linspace(0, 4 * math.pi, n)
rng = np.random.default_rng(params["seed"])
y = np.sin(x) + rng.normal(0, 0.15, n)
result = {"x": x, "y": y}
""", {"n": 60, "seed": 7})
    engine.add_cell(nb, "trend", "compute",
"""# 分支 A：滑动平均
window = params["window"]
y = np.asarray(inputs["raw"]["y"])
kernel = np.ones(window) / window
result = np.convolve(y, kernel, mode="same")
""", {"window": 7})
    engine.add_cell(nb, "peaks", "compute",
"""# 分支 B：峰值统计
y = np.asarray(inputs["raw"]["y"])
result = {"max": float(y.max()), "min": float(y.min()),
          "mean": float(y.mean())}
""", {})
    engine.add_cell(nb, "summary", "compute",
"""# 汇合：趋势末端与峰值
t = np.asarray(inputs["trend"])
result = {"trend_last": float(t[-1]), "max": inputs["peaks"]["max"]}
""", {})
    engine.add_cell(nb, "ratio", "compute",
"""# 演示中途失败：把 params.denominator 设为 0 会触发除零，
# 本单元标记为失败且不留结果，下游 report 会被跳过。
result = inputs["summary"]["max"] / params["denominator"]
""", {"denominator": 0})
    engine.add_cell(nb, "report", "compute",
"""result = {"ratio": inputs["ratio"], "n": params["precision"]}
""", {"precision": 3})
    engine.add_cell(nb, "chart", "plot",
"""# 绘图单元沿用同一套结果关系
result = {
    "chart": "line",
    "title": "raw vs trend",
    "x": inputs["raw"]["x"],
    "series": [
        {"name": "raw", "y": inputs["raw"]["y"]},
        {"name": "trend", "y": inputs["trend"]},
    ],
}
""", {})
    return nb
