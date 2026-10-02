import { useNotebook } from "../store/useNotebook";
import { acceptedUnit, pendingUnitIds } from "../core/scenarios";
import type { Experiment, Scenario, UnitResult } from "../core/types";

function ResultCell({
  result,
  pending,
  baselineVersion,
}: {
  result?: UnitResult;
  pending?: UnitResult;
  baselineVersion?: number;
}) {
  if (pending) {
    return (
      <div className="cell-pending">
        {pending.status === "ok" ? (
          <span className="mono pending-value">{pending.value}</span>
        ) : (
          <span className="error-text" title={pending.error}>{pending.error}</span>
        )}
        <div className="pending-tag">
          新版本预览（待接受）{baselineVersion !== undefined ? ` · 相对已接受 v${baselineVersion}` : ""}
        </div>
      </div>
    );
  }
  if (result?.status === "ok") return <span className="mono">{result.value}</span>;
  if (result?.status === "error") {
    return <span className="error-text" title={result.error}>{result.error}</span>;
  }
  return <span className="hint">待计算</span>;
}

function ScenarioColumn({ exp, sc, active }: { exp: Experiment; sc: Scenario; active: boolean }) {
  const selectScenario = useNotebook((s) => s.selectScenario);
  const updateScenarioParam = useNotebook((s) => s.updateScenarioParam);
  const acceptScenarioUpdate = useNotebook((s) => s.acceptScenarioUpdate);
  const discardScenarioUpdate = useNotebook((s) => s.discardScenarioUpdate);
  const removeScenario = useNotebook((s) => s.removeScenario);
  const pendingIds = new Set(pendingUnitIds(exp, sc));
  const orderIndex = new Map(sc.executionOrder.map((id, i) => [id, i]));

  return (
    <div className={`scenario-col ${active ? "scenario-active" : ""}`}>
      <div className="scenario-head">
        <button className="link" onClick={() => selectScenario(sc.id)} title="切换到该情景编辑参数">
          <strong>{sc.name}</strong>
        </button>
        {exp.scenarioOrder.length > 1 && (
          <button
            className="danger tiny"
            onClick={() => {
              if (confirm(`删除情景 “${sc.name}”？其他情景沿用的结果不受影响。`)) removeScenario(sc.id);
            }}
          >
            删除
          </button>
        )}
      </div>
      <div className="scenario-rows">
        {exp.units.map((unit) => {
          const result = sc.results[unit.id];
          const pending = sc.pending[unit.id];
          const isPendingUnit = pendingIds.has(unit.id);
          const acceptedVersion = unit.kind === "formula"
            ? (sc.acceptedFormulaVersions[unit.id] ?? unit.version)
            : undefined;
          const acceptedExpr = unit.kind === "formula"
            ? acceptedUnit(exp, sc, unit.id)?.expression
            : undefined;
          return (
            <div
              key={unit.id}
              className={`scenario-cell ${result?.status === "error" && !pending ? "cell-error" : ""} ${pending ? "cell-has-pending" : ""}`}
            >
              {unit.kind === "input" ? (
                <input
                  className="param-input mono"
                  value={sc.params[unit.id] ?? unit.value ?? ""}
                  disabled={!active}
                  title={active ? "编辑该情景下的参数" : "点击情景名切换后可编辑参数"}
                  onChange={(e) => updateScenarioParam(unit.id, e.target.value)}
                />
              ) : (
                <ResultCell result={result} pending={pending} baselineVersion={acceptedVersion} />
              )}
              <div className="cell-meta">
                {unit.kind === "formula" && (
                  <span className="hint">
                    {orderIndex.has(unit.id) ? `#${orderIndex.get(unit.id)! + 1}` : result?.errorKind === "cycle" ? "环中" : "阻塞"}
                    {!isPendingUnit && <span> · 按 v{acceptedVersion} 计算</span>}
                    {isPendingUnit && (
                      <span className="pending-badge"> · 已接受 v{acceptedVersion}，v{unit.version} 待处理</span>
                    )}
                  </span>
                )}
              </div>
              {unit.kind === "formula" && !pending && (
                <div className="cell-source hint mono" title="参与该情景计算的公式表达式（该情景已接受版本）">
                  {acceptedExpr || "（空表达式）"}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {Object.keys(sc.pending).length > 0 && (
        <div className="pending-bar">
          <button className="tiny" onClick={() => acceptScenarioUpdate(sc.id)}>接受新结果</button>
          <button className="tiny ghost" onClick={() => discardScenarioUpdate(sc.id)}>保持旧版</button>
        </div>
      )}
    </div>
  );
}

export function NotebookPage({ onEditUnit }: { onEditUnit: (id: string) => void }) {
  const activeId = useNotebook((s) => s.activeId);
  const experiment = useNotebook((s) => (s.activeId ? s.experiments[s.activeId!] : undefined));
  const experiments = useNotebook((s) => s.experiments);
  const selectExperiment = useNotebook((s) => s.selectExperiment);
  const addUnit = useNotebook((s) => s.addUnit);
  const removeUnit = useNotebook((s) => s.removeUnit);
  const recomputeAll = useNotebook((s) => s.recomputeAll);
  const addScenario = useNotebook((s) => s.addScenario);
  const acceptAllScenarioUpdates = useNotebook((s) => s.acceptAllScenarioUpdates);
  const snapshot = useNotebook((s) => s.snapshot);
  const branch = useNotebook((s) => s.branch);

  if (!activeId || !experiment) return null;
  const parent = experiment.parentId ? experiments[experiment.parentId] : null;
  const scenarios = experiment.scenarioOrder.map((id) => experiment.scenarios[id]).filter(Boolean);
  const pendingScenarios = scenarios.filter((sc) => Object.keys(sc.pending).length > 0).length;

  return (
    <div className="page wide">
      <div className="header-row">
        <button onClick={() => selectExperiment(null)}>← 实验列表</button>
        <h1>{experiment.name}</h1>
      </div>
      <p className="hint">
        {parent ? <>支线（来自 {parent.name}）。</> : "根实验。"}
        公式在情景间共享、参数各自独立；引用环只阻塞环及其下游，独立常量照常计算。
      </p>

      <div className="toolbar">
        <button onClick={() => addUnit("input")}>添加输入单元</button>
        <button onClick={() => addUnit("formula")}>添加计算单元</button>
        <button onClick={recomputeAll}>全部重算</button>
        <button onClick={() => addScenario()}>派生参数情景</button>
        {pendingScenarios > 0 && (
          <button onClick={acceptAllScenarioUpdates}>全部接受新结果（{pendingScenarios}）</button>
        )}
        <button
          onClick={() => snapshot(prompt("快照名称（留空使用时间戳）", "") ?? undefined)}
        >
          保存快照
        </button>
        <button onClick={() => branch(experiment.id, `${experiment.name} 支线`)}>分出支线</button>
      </div>

      <div className="scenario-grid">
        <div className="scenario-col scenario-def-col">
          <div className="scenario-head"><strong>单元 / 共享公式</strong></div>
          <div className="scenario-rows">
            {experiment.units.map((unit) => (
              <div key={unit.id} className="scenario-cell def-cell">
                <div>
                  <button className="link" onClick={() => onEditUnit(unit.id)}>{unit.name}</button>
                  <span className="meta"> {unit.kind === "input" ? "输入（默认值）" : `公式 v${unit.version}`}</span>
                </div>
                <div className="mono def-expr" title={unit.kind === "formula" ? unit.expression : undefined}>
                  {unit.kind === "input" ? `默认 ${unit.value}` : unit.expression || "（空表达式）"}
                </div>
                <button className="danger tiny" onClick={() => removeUnit(unit.id)}>删除单元</button>
              </div>
            ))}
          </div>
        </div>

        {scenarios.map((sc) => (
          <ScenarioColumn key={sc.id} exp={experiment} sc={sc} active={sc.id === experiment.activeScenarioId} />
        ))}
      </div>

      {experiment.units.length === 0 && <p className="hint">还没有单元，先添加一个输入单元。</p>}
    </div>
  );
}
