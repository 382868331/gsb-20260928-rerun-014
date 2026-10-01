import { useNotebook } from "../store/useNotebook";
import { activeOrder, activeResults } from "../core/scenarios";

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
  const addScenario = useNotebook((s) => s.addScenario);
  const selectScenario = useNotebook((s) => s.selectScenario);
  const removeScenario = useNotebook((s) => s.removeScenario);
  const acceptScenario = useNotebook((s) => s.acceptScenario);
  const rejectScenario = useNotebook((s) => s.rejectScenario);

  if (!activeId || !experiment) return null;
  const parent = experiment.parentId ? experiments[experiment.parentId] : null;
  const scenarios = experiment.scenarioOrder.map((id) => experiment.scenarios[id]);
  const activeScenario = experiment.scenarios[experiment.activeScenarioId ?? experiment.scenarioOrder[0]];
  const activeResultsMap = activeResults(experiment, activeScenario.id);
  const orderIndex = new Map(activeOrder(experiment, activeScenario.id).map((id, i) => [id, i]));

  return (
    <div className="page wide-page">
      <div className="header-row">
        <button onClick={() => selectExperiment(null)}>← 实验列表</button>
        <h1>{experiment.name}</h1>
      </div>
      <p className="hint">
        {parent ? <>支线（来自 {parent.name}），参数情景互相隔离。</> : "根实验。"}
        引用环只阻塞环及其下游；参数改动只重算当前情景，共享公式改动会预览所有情景。
      </p>

      <div className="toolbar">
        <button onClick={() => addUnit("input")}>添加输入单元</button>
        <button onClick={() => addUnit("formula")}>添加计算单元</button>
        <button onClick={recomputeAll}>全部重算</button>
        <button onClick={() => snapshot(prompt("快照名称（留空使用时间戳）", "") ?? undefined)}>保存快照</button>
        <button onClick={() => branch(experiment.id, `${experiment.name} 支线`)}>分出实验支线</button>
        <button onClick={() => addScenario(prompt("新参数情景名称", "") ?? "")}>派生参数情景</button>
        {activeScenario.id !== "baseline" && (
          <button className="secondary" onClick={() => {
            if (confirm(`删除参数情景 "${activeScenario.name}"？其他情景结果不受影响。`)) removeScenario(activeScenario.id);
          }}>
            删除当前情景
          </button>
        )}
      </div>

      {experiment.pendingFormulaChange && (
        <div className="preview-banner">
          共享公式正在预览：可逐个情景“接受新结果”，未处理情景继续保留旧版结果。
        </div>
      )}

      <div className="scenario-tabs">
        {scenarios.map((scenario) => {
          const pending = scenario.pendingFormulaRevision !== null;
          const errors = Object.values(activeResults(experiment, scenario.id)).filter((r) => r.status === "error").length;
          return (
            <button
              key={scenario.id}
              className={scenario.id === activeScenario.id ? "scenario-tab active-tab" : "scenario-tab"}
              onClick={() => selectScenario(scenario.id)}
              title={pending ? "该情景有公式预览待确认" : undefined}
            >
              {scenario.name}{pending ? " · 待确认" : ""}{errors > 0 ? ` · ${errors} 错` : ""}
            </button>
          );
        })}
      </div>

      {activeScenario.pendingFormulaRevision !== null && (
        <div className="preview-actions">
          <button onClick={() => acceptScenario(activeScenario.id)}>接受本情景新结果</button>
          <button className="secondary" onClick={() => rejectScenario(activeScenario.id)}>拒绝并保留旧公式</button>
        </div>
      )}

      <table className="unit-table scenario-table">
        <thead>
          <tr>
            <th>执行次序</th>
            <th>单元</th>
            <th>类型</th>
            <th>共享定义 / 当前参数</th>
            {scenarios.map((scenario) => (
              <th key={scenario.id}>
                {scenario.name}
                {scenario.pendingFormulaRevision !== null && <span className="pending-dot">待确认</span>}
              </th>
            ))}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {experiment.units.map((unit) => (
            <tr key={unit.id} className={activeResultsMap[unit.id]?.status === "error" ? "row-error" : ""}>
              <td>{orderIndex.has(unit.id) ? orderIndex.get(unit.id)! + 1 : "—"}</td>
              <td>{unit.name}</td>
              <td>{unit.kind === "input" ? "输入" : "计算"}</td>
              <td className="mono">{unit.kind === "input" ? unit.value : unit.expression}</td>
              {scenarios.map((scenario) => {
                const result = activeResults(experiment, scenario.id)[unit.id];
                const parameter = scenario.parameterValues[unit.id];
                return (
                  <td key={scenario.id} className="result-cell">
                    {result?.status === "ok" ? <span className="mono">{result.value}</span> : result?.status === "error" ? (
                      <span className="error-text" title={result.error}>错误</span>
                    ) : "—"}
                    {unit.kind === "input" && parameter !== undefined && <div className="param-pill">参数 {parameter}</div>}
                  </td>
                );
              })}
              <td className="nowrap">
                <button onClick={() => onEditUnit(unit.id)}>编辑</button>
                <button className="danger" onClick={() => removeUnit(unit.id)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {experiment.units.length === 0 && <p className="hint">还没有单元，先添加一个输入单元。</p>}
    </div>
  );
}
