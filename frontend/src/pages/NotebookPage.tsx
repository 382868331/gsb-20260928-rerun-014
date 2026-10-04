import { useMemo, useState } from "react";
import { useNotebook } from "../store/useNotebook";
import { historicalExpression, pendingUnitIds, scenarioFormulaVersion } from "../core/scenarios";
import { analyzeScenarioRanges, compareAcceptedScenarios, compareScenarioRanges, formatWorld as formatWorldForExp } from "../core/ranges";
import type { Experiment, InputConstraint, Scenario, UnitRange, UnitResult } from "../core/types";

function formatRange(range?: UnitRange): string {
  if (!range || range.min === null || range.max === null) return "无法判断";
  const label = range.status === "proven" ? "已证实" : "可能";
  return `${label} [${range.min}, ${range.max}]`;
}

function RangePanel({ exp, sc }: { exp: Experiment; sc: Scenario }) {
  const otherScenarios = exp.scenarioOrder.map((id) => exp.scenarios[id]).filter((item) => item && item.id !== sc.id);
  const [compareId, setCompareId] = useState(otherScenarios[0]?.id ?? "");
  const crossComparison = useMemo(
    () => (compareId ? compareAcceptedScenarios(exp, sc.id, compareId) : []),
    [exp, sc.id, compareId],
  );
  const updateInputConstraint = useNotebook((s) => s.updateInputConstraint);
  const addJointObservation = useNotebook((s) => s.addJointObservation);
  const updateJointObservation = useNotebook((s) => s.updateJointObservation);
  const removeJointObservation = useNotebook((s) => s.removeJointObservation);
  const analysis = analyzeScenarioRanges(exp, sc);
  const comparison = compareScenarioRanges(exp, sc);
  const inputs = exp.units.filter((u) => u.kind === "input");
  const formulas = exp.units.filter((u) => u.kind === "formula");
  const constraintOf = (id: string): InputConstraint => sc.inputConstraints?.[id] ?? { mode: "point", text: sc.params[id] ?? exp.units.find((u) => u.id === id)?.value ?? "" };

  return (
    <section className="range-panel">
      <h2>输入范围与联合观测：{sc.name}</h2>
      <p className="hint">有限候选且关联完整时给出已证实范围；区间只报告基于端点/样本的可能范围。真实边界组合和缺失依据会直接列出。</p>
      <div className="range-grid">
        {inputs.map((input) => {
          const constraint = constraintOf(input.id);
          return (
            <label key={input.id} className="range-input">
              <span>{input.name}</span>
              <select value={constraint.mode} onChange={(e) => updateInputConstraint(input.id, { ...constraint, mode: e.target.value as InputConstraint["mode"] })}>
                <option value="point">确定值</option>
                <option value="finite">有限候选</option>
                <option value="interval">区间</option>
              </select>
              <input
                value={constraint.text}
                placeholder={constraint.mode === "finite" ? "1, 2, 3" : constraint.mode === "interval" ? "0..10" : "数字"}
                onChange={(e) => updateInputConstraint(input.id, { ...constraint, text: e.target.value })}
              />
            </label>
          );
        })}
      </div>

      <div className="toolbar">
        <button type="button" onClick={addJointObservation}>添加联合观测</button>
      </div>
      {(sc.jointObservations ?? []).map((obs, index) => (
        <div key={obs.id} className="observation-row" style={{ ["--input-count" as string]: inputs.length }}>
          <input value={obs.name} onChange={(e) => updateJointObservation(obs.id, { name: e.target.value })} />
          {inputs.map((input) => (
            <input
              key={input.id}
              aria-label={`${obs.name} ${input.name}`}
              placeholder={`${input.name}：留空则用其区间约束`}
              value={obs.values[input.id] ?? ""}
              onChange={(e) => updateJointObservation(obs.id, { values: { ...obs.values, [input.id]: e.target.value } })}
            />
          ))}
          <button type="button" className="tiny danger" onClick={() => removeJointObservation(obs.id)}>删除观测 {index + 1}</button>
        </div>
      ))}

      {analysis.globalReasons.length > 0 && <div className="result-error">{analysis.globalReasons.map((reason) => <p key={reason}>{reason}</p>)}</div>}
      {otherScenarios.length > 0 && (
        <div className="toolbar">
          <label className="hint">与情景比较
            <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
              {otherScenarios.map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {crossComparison.length > 0 && (
        <table className="range-table">
          <thead><tr><th>单元</th><th>{sc.name}</th><th>{exp.scenarios[compareId]?.name}</th><th>差异来源</th></tr></thead>
          <tbody>
            {crossComparison.map((row) => {
              const unit = exp.units.find((u) => u.id === row.unitId)!;
              const sources = [
                row.formulaRevision ? "公式修订/版本不同" : "",
                row.parameterDifference ? "输入约束不同" : "",
                row.uncertainty ? "参数不确定性未消除" : "",
              ].filter(Boolean).join("、") || "无差异";
              return <tr key={row.unitId}><td>{unit.name}</td><td>{formatRange(row.left)}</td><td>{formatRange(row.right)}</td><td>{sources}</td></tr>;
            })}
          </tbody>
        </table>
      )}
      <table className="range-table">
        <thead><tr><th>单元</th><th>已接受公式</th><th>预览公式</th><th>差异归因</th><th>边界依据 / 缺口</th></tr></thead>
        <tbody>
          {comparison.map((row) => {
            const unit = exp.units.find((u) => u.id === row.unitId)!;
            const accepted = analysis.ranges[row.unitId];
            const pendingRange = row.pending;
            const causes = [
              row.formulaRevision ? "公式修订" : "",
              accepted?.status !== "proven" || pendingRange?.status !== "proven" ? "参数不确定性" : "",
            ].filter(Boolean).join("、") || "输入与公式均未变化";
            return (
              <tr key={row.unitId}>
                <td>{unit.name}</td>
                <td>{formatRange(accepted)}<div className="hint">最小：{formatWorldForExp(exp, accepted?.minWorld)}<br />最大：{formatWorldForExp(exp, accepted?.maxWorld)}</div></td>
                <td>{pendingRange ? <>{formatRange(pendingRange)}<div className="hint">最小：{formatWorldForExp(exp, pendingRange.minWorld)}<br />最大：{formatWorldForExp(exp, pendingRange.maxWorld)}</div></> : "无单独预览"}</td>
                <td>{causes}</td>
                <td>{[...(accepted?.reasons ?? []), ...(pendingRange?.reasons ?? [])].join("；") || `枚举 ${accepted?.worldCount ?? 0} 个真实输入组合`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {formulas.length === 0 && <p className="hint">添加计算单元后显示范围。</p>}
    </section>
  );
}

function ResultCell({
  result,
  pending,
  acceptedVersion,
  pendingVersion,
  baselineExpression,
  previewExpression,
}: {
  result?: UnitResult;
  pending?: UnitResult;
  acceptedVersion: number;
  pendingVersion?: number;
  baselineExpression: string;
  previewExpression: string;
}) {
  if (pending) {
    const source = pendingVersion && pendingVersion !== acceptedVersion
      ? `v${acceptedVersion} → v${pendingVersion}`
      : "上游变化";
    return (
      <div className="cell-pending">
        {pending.status === "ok" ? (
          <span className="mono pending-value">{pending.value}</span>
        ) : (
          <span className="error-text" title={pending.error}>{pending.error}</span>
        )}
        <div className="pending-tag">相对本情景基线预览（{source}）</div>
        <div className="hint mono">基线：{baselineExpression || "（空）"} → 预览：{previewExpression || "（空）"}</div>
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
  const ranges = analyzeScenarioRanges(exp, sc);

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
          const acceptedVersion = scenarioFormulaVersion(exp, sc, unit.id, "accepted");
          const pendingVersion = sc.pendingFormulaVersions?.[unit.id];
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
                <>
                  <ResultCell
                    result={result}
                    pending={pending}
                    acceptedVersion={acceptedVersion}
                    pendingVersion={pendingVersion}
                    baselineExpression={historicalExpression(exp, unit.id, acceptedVersion)}
                    previewExpression={historicalExpression(exp, unit.id, pendingVersion ?? unit.version)}
                  />
                  <div className={`range-badge range-${ranges.ranges[unit.id]?.status ?? "unknown"}`}>{formatRange(ranges.ranges[unit.id])}</div>
                </>
              )}
              <div className="cell-meta">
                {unit.kind === "formula" && (
                  <span className="hint">
                    {orderIndex.has(unit.id) ? `#${orderIndex.get(unit.id)! + 1}` : result?.errorKind === "cycle" ? "环中" : "阻塞"}
                    <span> · 已接受 v{acceptedVersion}</span>
                    {isPendingUnit && <span className="pending-badge"> · 最新 v{unit.version} 待处理</span>}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {active && <RangePanel exp={exp} sc={sc} />}
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
