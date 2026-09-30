import { useNotebook } from "../store/useNotebook";

export function NotebookPage({ onEditUnit }: { onEditUnit: (id: string) => void }) {
  const activeId = useNotebook((s) => s.activeId);
  const experiment = useNotebook((s) => (s.activeId ? s.experiments[s.activeId!] : undefined));
  const experiments = useNotebook((s) => s.experiments);
  const selectExperiment = useNotebook((s) => s.selectExperiment);
  const addUnit = useNotebook((s) => s.addUnit);
  const removeUnit = useNotebook((s) => s.removeUnit);
  const recomputeAll = useNotebook((s) => s.recomputeAll);
  const snapshot = useNotebook((s) => s.snapshot);
  const branch = useNotebook((s) => s.branch);

  if (!activeId || !experiment) return null;
  const parent = experiment.parentId ? experiments[experiment.parentId] : null;
  const orderIndex = new Map(experiment.executionOrder.map((id, i) => [id, i]));

  return (
    <div className="page">
      <div className="header-row">
        <button onClick={() => selectExperiment(null)}>← 实验列表</button>
        <h1>{experiment.name}</h1>
      </div>
      <p className="hint">
        {parent ? <>支线（来自 {parent.name}），修改只影响本支线。</> : "根实验。"}
        按拓扑次序执行；修改输入后仅重算受影响的下游单元。
      </p>

      <div className="toolbar">
        <button onClick={() => addUnit("input")}>添加输入单元</button>
        <button onClick={() => addUnit("formula")}>添加计算单元</button>
        <button onClick={recomputeAll}>全部重算</button>
        <button
          onClick={() => {
            const label = prompt("快照名称（留空使用时间戳）", "");
            snapshot(label ?? undefined);
          }}
        >
          保存快照
        </button>
        <button onClick={() => branch(experiment.id, `${experiment.name} 支线`)}>从此实验分出支线</button>
      </div>

      <table className="unit-table">
        <thead>
          <tr>
            <th>执行次序</th>
            <th>名称</th>
            <th>类型</th>
            <th>输入 / 表达式</th>
            <th>当前结果</th>
            <th>状态 / 错误定位</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {experiment.units.map((unit) => {
            const result = experiment.results[unit.id];
            return (
              <tr key={unit.id} className={result?.status === "error" ? "row-error" : ""}>
                <td>{orderIndex.has(unit.id) ? orderIndex.get(unit.id)! + 1 : "—"}</td>
                <td>{unit.name}</td>
                <td>{unit.kind === "input" ? "输入" : "计算"}</td>
                <td className="mono">{unit.kind === "input" ? unit.value : unit.expression}</td>
                <td className="mono">{result?.status === "ok" ? result.value : "—"}</td>
                <td>
                  {result?.status === "ok" ? (
                    <span className="ok-text">成功</span>
                  ) : result?.status === "error" ? (
                    <span className="error-text" title={result.error}>{result.error}</span>
                  ) : (
                    "待计算"
                  )}
                </td>
                <td className="nowrap">
                  <button onClick={() => onEditUnit(unit.id)}>编辑</button>
                  <button className="danger" onClick={() => removeUnit(unit.id)}>删除</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {experiment.units.length === 0 && <p className="hint">还没有单元，先添加一个输入单元。</p>}
    </div>
  );
}
