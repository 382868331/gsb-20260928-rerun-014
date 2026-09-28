# 科研计算笔记本（依赖图 + 结果版本化）

受限计算单元组成的科学计算笔记本：单元通过 `inputs["前序单元"]` 引用数据，
保存输入、参数与结果版本；修改后自动标记下游过期，重算只执行受影响部分；
循环引用可定位；失败单元不残留伪成功结果；笔记本关闭重开可完整还原；
绘图单元复用同一套结果关系。

## 启动

```bash
# 后端（FastAPI，端口 8000）
.venv/bin/python -m uvicorn app.main:app --reload --app-dir backend

# 前端（Vite，端口 5173，已代理 /api）
cd frontend && npm run dev

# 后端测试（10 个，覆盖图算法、沙箱、引擎、持久化、端到端流程）
.venv/bin/python -m pytest backend/tests -q
```

## 核心设计

- 依赖解析（`backend/app/sandbox.py`）：AST 分析代码中的 `inputs["x"]` /
  `inputs.x` 自动得到依赖，无需手动连线。
- 图算法（`backend/app/graph.py`）：DFS 三色标记定位循环（返回环路径
  `a -> b -> a`），Kahn 拓扑排序决定执行顺序，反向边传播过期。
- 版本与重算（`backend/app/engine.py`）：每个成功单元 `version` 自增并记录
  `input_versions`；编辑代码或参数后，本单元与所有传递下游标记为过期；
  重算时拓扑序中只执行非最新单元，跳过因上游失败而无法计算的单元。
- 失败语义：单元失败时 `status=error`、`result=None`、版本不自增；下游保持
  过期并被跳过，绝不沿用上一次或伪造的结果。
- 持久化（`backend/app/store.py`）：每次变更原子写入 `data/notebooks/*.json`，
  重开页面从磁盘还原单元代码、参数、结果、版本与状态。
- 沙箱：AST 白名单禁止 import、`open/eval/exec/getattr`、类定义、with、
  私有名/属性（`_` 前缀）；只注入 `np`、`math`、`inputs`、`params`，内置
  函数白名单，5 秒超时；单元无法读取本机其他文件。
- 绘图：`kind=plot` 单元返回 `{chart, x, series}` 规格，前端用 recharts
  渲染；它与计算单元一样有依赖、版本、过期与失败语义。

## 演示路径（页面一键“重置演示”可随时复原）

演示笔记本 `demo`：`raw` 分叉为 `trend`（滑动平均）与 `peaks`（峰值统计），
在 `summary` 汇合，再经 `ratio -> report`；另有 `chart` 绘图单元引用 raw/trend。

1. 打开页面点“重算过期单元”：`ratio` 因 `denominator=0` 除零失败，
   `report` 被跳过且无结果，其余分支与 `chart` 正常成功——观察运行报告。
2. 把 `ratio` 参数改为 `{"denominator": 2}` 保存并重算：报告显示只重跑
   `ratio`、`report`，`raw` 等单元仍是 v1。
3. 修改 `raw` 参数（如 `n: 40`）：整条分叉链与 chart 变“过期”（DAG 中
   橙色边框/动画边），重算时只跑这 7 个受影响单元。
4. 把 `trend` 代码改成 `result = inputs["summary"]`：形成
   `trend -> summary -> trend` 环，顶部红条定位环，环内单元判为错误。
5. 关闭页面重开：所有代码、参数、结果与版本原样还原。
