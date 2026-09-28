import { useEffect } from "react";
import {
  AlertTriangle, Play, Plus, RotateCcw, LineChart, Calculator, Zap,
} from "lucide-react";
import { useStore } from "./store";
import { CellCard } from "./CellCard";
import { GraphView } from "./GraphView";

export function App() {
  const { notebook, report, error, load, run, addCell, resetDemo } = useStore();
  useEffect(() => {
    load();
  }, [load]);

  if (!notebook)
    return <div className="loading">正在还原笔记本…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>{notebook.title}</h1>
          <div className="muted">运行次数 {notebook.run_count} · 结果与单元版本均已持久化</div>
        </div>
        <div className="actions">
          <button onClick={() => run(false)}>
            <Play size={15} /> 重算过期单元
          </button>
          <button onClick={() => run(true)}>
            <Zap size={15} /> 强制全部重算
          </button>
          <button onClick={() => addCell("compute")}>
            <Plus size={15} /> <Calculator size={15} /> 计算单元
          </button>
          <button onClick={() => addCell("plot")}>
            <Plus size={15} /> <LineChart size={15} /> 绘图单元
          </button>
          <button onClick={resetDemo} title="恢复演示数据">
            <RotateCcw size={15} /> 重置演示
          </button>
        </div>
      </header>

      {notebook.cycle && (
        <div className="banner banner-error">
          <AlertTriangle size={16} />
          检测到循环引用：{notebook.cycle.join(" → ")}
        </div>
      )}
      {error && (
        <div className="banner banner-error">
          <AlertTriangle size={16} /> {error}
        </div>
      )}
      {report && (
        <div className="banner banner-report">
          本次执行：运行 {report.ran.length}（{report.ran.join(", ") || "无"}）·
          失败 {report.failed.length}（{report.failed.join(", ") || "无"}）·
          跳过 {report.skipped.length}（{report.skipped.join(", ") || "无"}）
        </div>
      )}

      <main className="main">
        <section className="cells">
          {notebook.cells.map((c) => (
            <CellCard key={c.id} cell={c} />
          ))}
        </section>
        <aside className="side">
          <div className="panel">
            <h2>依赖图</h2>
            <div className="legend">
              <span><i className="dot fresh" />最新</span>
              <span><i className="dot stale" />过期</span>
              <span><i className="dot error" />失败</span>
            </div>
            <GraphView notebook={notebook} />
          </div>
          <div className="panel help">
            <h2>使用说明</h2>
            <ul>
              <li>用 <code>inputs["单元名"]</code> 引用前面单元的结果，依赖自动识别。</li>
              <li><code>params["键"]</code> 取参数；可用 <code>np</code> 与 <code>math</code>。</li>
              <li>结果赋值给 <code>result</code>；绘图单元返回 chart 规格。</li>
              <li>保存修改会把下游结果标为过期，重算只跑受影响部分。</li>
              <li>沙箱禁止 import、open 与私有属性，无法读取本机文件。</li>
            </ul>
          </div>
        </aside>
      </main>
    </div>
  );
}
