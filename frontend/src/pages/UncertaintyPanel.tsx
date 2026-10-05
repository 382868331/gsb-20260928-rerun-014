import { useState } from "react";
import type { Experiment, InputConstraint, JointGroup, LinearRelation, PiecewiseCondition, RangeReport, UnitRange } from "../core/types";
import { compareScenarios, computeScenarioRanges, effectiveInputText } from "../core/uncertainty";
import { pendingUnitIds } from "../core/scenarios";
import { uid } from "../core/storage";
import { useNotebook } from "../store/useNotebook";

function fmtNum(v: number | undefined): string {
  return v === undefined ? "—" : String(Math.round(v * 1e6) / 1e6);
}

function fmtWitness(w?: Record<string, number>): string {
  if (!w) return "—";
  const parts = Object.entries(w).map(([k, v]) => k + "=" + fmtNum(v));
  return parts.length > 0 ? parts.join(", ") : "—";
}

function statusLabel(r: UnitRange): string {
  if (r.status === "proven") return "已证实";
  if (r.status === "possible") return "可能";
  return "无法判断";
}

function RangeTable({ exp, ranges, title, totalCombos, truncated, feasibleCombos, infeasibleCombos }: {
  exp: Experiment;
  ranges: Record<string, UnitRange>;
  title: string;
  totalCombos: number;
  truncated: boolean;
  feasibleCombos?: number;
  infeasibleCombos?: number;
}) {
  const nameOf = (id: string) => exp.units.find((u) => u.id === id)?.name ?? id;
  return (
    <div className="range-block">
      <h3>{title}</h3>
      <p className="hint">
        共枚举 {totalCombos} 个输入组合{truncated ? "（超出上限已截断，范围降级为可能）" : ""}。
        {infeasibleCombos !== undefined && infeasibleCombos > 0 &&
          " 其中 " + infeasibleCombos + " 个组合被线性关系/分段条件排除，可行组合 " + (feasibleCombos ?? 0) + " 个。"}
      </p>
      <table className="unit-table">
        <thead>
          <tr>
            <th>单元</th><th>结论</th><th>范围</th><th>下界组合</th><th>上界组合</th><th>失败/原因</th>
          </tr>
        </thead>
        <tbody>
          {exp.units.map((u) => {
            const r = ranges[u.id];
            if (!r) return null;
            return (
              <tr key={u.id} className={r.status === "indeterminate" ? "row-error" : ""}>
                <td className="mono">{nameOf(u.id)}</td>
                <td>
                  <span className={"range-badge range-" + r.status}>{statusLabel(r)}</span>
                </td>
                {r.status === "indeterminate" ? (
                  <td colSpan={4} className="error-text">{r.reason}</td>
                ) : (
                  <>
                    <td className="mono">[{fmtNum(r.min)}, {fmtNum(r.max)}]</td>
                    <td className="mono">{fmtWitness(r.minWitness)}</td>
                    <td className="mono">{fmtWitness(r.maxWitness)}</td>
                    <td className="hint">
                      {r.failed > 0
                        ? r.failed + " 个组合失败：" + (r.failureReasons ?? []).join("；")
                        : "无"}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConstraintEditor({ exp, scenarioId }: { exp: Experiment; scenarioId: string }) {
  const sc = exp.scenarios[scenarioId];
  const setInputConstraint = useNotebook((s) => s.setInputConstraint);
  const inputs = exp.units.filter((u) => u.kind === "input");
  if (inputs.length === 0) return <p className="hint">还没有输入单元。</p>;
  return (
    <div className="constraint-grid">
      {inputs.map((u) => {
        const c = sc.inputConstraints?.[u.id];
        const kind = c?.kind ?? "value";
        return (
          <div key={u.id + kind} className="constraint-row">
            <span className="mono constraint-name">{u.name}</span>
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value;
                if (k === "value") setInputConstraint(u.id, null);
                else if (k === "candidates") setInputConstraint(u.id, { kind: "candidates", values: [Number(effectiveInputText(exp, sc, u.id)) || 0] });
                else setInputConstraint(u.id, { kind: "interval", min: 0, max: 1, samples: 5 });
              }}
            >
              <option value="value">确定值</option>
              <option value="candidates">候选集</option>
              <option value="interval">区间</option>
            </select>
            {kind === "value" && (
              <span className="hint">当前值 {effectiveInputText(exp, sc, u.id) || "（空）"}</span>
            )}
            {c?.kind === "candidates" && (
              <input
                key={scenarioId + u.id + "cand"}
                className="mono"
                defaultValue={c.values.join(", ")}
                placeholder="逗号分隔，如 1, 2, 5"
                onBlur={(e) => {
                  const values = e.target.value.split(/[,，\s]+/).map(Number).filter((v) => Number.isFinite(v));
                  const next: InputConstraint = { kind: "candidates", values };
                  setInputConstraint(u.id, next);
                }}
              />
            )}
            {c?.kind === "interval" && (
              <span className="interval-fields">
                <input
                  key={scenarioId + u.id + "min"}
                  className="mono interval-input"
                  defaultValue={String(c.min)}
                  onBlur={(e) => {
                    const min = Number(e.target.value);
                    if (Number.isFinite(min)) setInputConstraint(u.id, { ...c, min });
                  }}
                />
                <span>~</span>
                <input
                  key={scenarioId + u.id + "max"}
                  className="mono interval-input"
                  defaultValue={String(c.max)}
                  onBlur={(e) => {
                    const max = Number(e.target.value);
                    if (Number.isFinite(max)) setInputConstraint(u.id, { ...c, max });
                  }}
                />
                <span>采样</span>
                <input
                  key={scenarioId + u.id + "n"}
                  className="mono interval-input tiny-input"
                  defaultValue={String(c.samples)}
                  onBlur={(e) => {
                    const samples = Math.max(2, Math.floor(Number(e.target.value)) || 5);
                    setInputConstraint(u.id, { ...c, samples });
                  }}
                />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function JointGroupEditor({ exp, scenarioId }: { exp: Experiment; scenarioId: string }) {
  const sc = exp.scenarios[scenarioId];
  const setJointGroups = useNotebook((s) => s.setJointGroups);
  const groups = sc.jointGroups ?? [];
  const inputs = exp.units.filter((u) => u.kind === "input");

  const update = (next: JointGroup[]) => setJointGroups(next);

  return (
    <div>
      {groups.map((g) => (
        <div key={g.id} className="joint-group">
          <div className="joint-head">
            <span>联合观测组：</span>
            {inputs.map((u) => (
              <label key={u.id} className="joint-check">
                <input
                  type="checkbox"
                  checked={g.unitIds.includes(u.id)}
                  onChange={(e) => {
                    const unitIds = e.target.checked
                      ? [...g.unitIds, u.id]
                      : g.unitIds.filter((id) => id !== u.id);
                    update(groups.map((x) => (x.id === g.id ? { ...g, unitIds, rows: [] } : x)));
                  }}
                />
                <span className="mono">{u.name}</span>
              </label>
            ))}
            <button className="danger tiny" onClick={() => update(groups.filter((x) => x.id !== g.id))}>删除组</button>
          </div>
          <textarea
            key={g.id + g.unitIds.join(".")}
            rows={3}
            className="mono joint-rows"
            placeholder={"每行一次联合观测，列顺序同上方勾选，如：\n1, 2\n3, 4"}
            defaultValue={g.rows.map((r) => r.join(", ")).join("\n")}
            onBlur={(e) => {
              const rows = e.target.value
                .split("\n")
                .map((line) => line.split(/[,，\s]+/).filter(Boolean).map(Number))
                .filter((r) => r.length > 0 && r.every(Number.isFinite));
              update(groups.map((x) => (x.id === g.id ? { ...g, rows } : x)));
            }}
          />
          {g.unitIds.length > 0 && g.rows.length === 0 && (
            <p className="error-text">该组还没有观测数据，相关单元将无法判断。</p>
          )}
        </div>
      ))}
      <button
        className="tiny"
        onClick={() => update([...groups, { id: uid("jg"), unitIds: [], rows: [] }])}
      >
        添加联合观测组
      </button>
    </div>
  );
}

function LinearRelationEditor({ exp, scenarioId }: { exp: Experiment; scenarioId: string }) {
  const sc = exp.scenarios[scenarioId];
  const setLinearRelations = useNotebook((s) => s.setLinearRelations);
  const relations = sc.linearRelations ?? [];
  const update = (next: LinearRelation[]) => setLinearRelations(next);
  return (
    <div>
      {relations.map((rel) => (
        <div key={rel.id} className="constraint-row">
          <input
            key={rel.id + rel.expression}
            className="mono relation-input"
            defaultValue={rel.expression}
            placeholder="如 a + 2*b <= 10（只支持线性关系）"
            onBlur={(e) => {
              const expression = e.target.value.trim();
              if (expression === rel.expression) return;
              update(relations.map((x) => (x.id === rel.id ? { ...x, expression } : x)));
            }}
          />
          <button className="danger tiny" onClick={() => update(relations.filter((x) => x.id !== rel.id))}>删除</button>
        </div>
      ))}
      <button
        className="tiny"
        onClick={() => update([...relations, { id: uid("lr"), expression: "" }])}
      >
        添加线性关系
      </button>
      <p className="hint">只接受线性形式；非线性关系无法证明，相关单元将记为无法判断。</p>
    </div>
  );
}

function PiecewiseEditor({ exp, scenarioId }: { exp: Experiment; scenarioId: string }) {
  const sc = exp.scenarios[scenarioId];
  const setPiecewiseConditions = useNotebook((s) => s.setPiecewiseConditions);
  const conditions = sc.piecewiseConditions ?? [];
  const inputs = exp.units.filter((u) => u.kind === "input");
  const update = (next: PiecewiseCondition[]) => setPiecewiseConditions(next);
  const parseValues = (text: string) => text.split(/[,，\s]+/).map(Number).filter((v) => Number.isFinite(v));
  if (inputs.length === 0) return <p className="hint">还没有输入单元。</p>;
  return (
    <div>
      {conditions.map((pw) => {
        const patch = (part: Partial<PiecewiseCondition>) =>
          update(conditions.map((x) => (x.id === pw.id ? { ...x, ...part } : x)));
        return (
          <div key={pw.id} className="constraint-row piecewise-row">
            <span>当</span>
            <select value={pw.driverId} onChange={(e) => patch({ driverId: e.target.value })}>
              {inputs.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <span>&lt;</span>
            <input
              key={pw.id + "th" + pw.threshold}
              className="mono interval-input tiny-input"
              defaultValue={String(pw.threshold)}
              onBlur={(e) => {
                const threshold = Number(e.target.value);
                if (Number.isFinite(threshold)) patch({ threshold });
              }}
            />
            <span>时，</span>
            <select value={pw.targetId} onChange={(e) => patch({ targetId: e.target.value })}>
              {inputs.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <span>只能取</span>
            <input
              key={pw.id + "lo" + pw.lower.join(".")}
              className="mono"
              defaultValue={pw.lower.join(", ")}
              placeholder="如 1, 2"
              onBlur={(e) => patch({ lower: parseValues(e.target.value) })}
            />
            <span>；否则只能取</span>
            <input
              key={pw.id + "up" + pw.upper.join(".")}
              className="mono"
              defaultValue={pw.upper.join(", ")}
              placeholder="如 3, 4"
              onBlur={(e) => patch({ upper: parseValues(e.target.value) })}
            />
            <button className="danger tiny" onClick={() => update(conditions.filter((x) => x.id !== pw.id))}>删除</button>
          </div>
        );
      })}
      <button
        className="tiny"
        onClick={() => update([...conditions, {
          id: uid("pw"),
          driverId: inputs[0].id,
          threshold: 0,
          targetId: inputs[0].id,
          lower: [0],
          upper: [0],
        }])}
      >
        添加分段取值条件
      </button>
    </div>
  );
}

function ReportCard({ exp, report }: { exp: Experiment; report: RangeReport }) {
  const removeReport = useNotebook((s) => s.removeReport);
  const [open, setOpen] = useState(false);
  const versionText = Object.entries(report.formulaVersions)
    .map(([id, v]) => (report.unitNames[id] ?? id) + " v" + v)
    .join("、");
  return (
    <div className="report-card">
      <div className="report-head">
        <button className="link" onClick={() => setOpen(!open)}>
          <strong>{report.name}</strong>
        </button>
        <span className="hint">
          {new Date(report.createdAt).toLocaleString()} · {report.scenarioName} ·
          {report.target === "pending" ? "预览视图" : "基线视图"}
        </span>
        <button className="danger tiny" onClick={() => removeReport(report.id)}>删除</button>
      </div>
      <p className="hint">
        历史快照（保存时的公式版本：{versionText || "无"}）；约束与联合观测已随报告冻结，
        后续改版或约束调整不影响本报告，也不代表当前结果。
      </p>
      {open && (
        <RangeTable
          exp={{ ...exp, units: exp.units.map((u) => ({ ...u, name: report.unitNames[u.id] ?? u.name })) }}
          ranges={report.ranges}
          title="保存时的范围"
          totalCombos={report.totalCombos}
          truncated={report.truncated}
          feasibleCombos={report.feasibleCombos}
        />
      )}
    </div>
  );
}

export function UncertaintyPanel({ exp }: { exp: Experiment }) {
  const saveRangeReport = useNotebook((s) => s.saveRangeReport);
  const adoptConstraintScheme = useNotebook((s) => s.adoptConstraintScheme);
  const scId = exp.activeScenarioId ?? exp.scenarioOrder[0];
  const sc = exp.scenarios[scId];
  const [compareA, setCompareA] = useState(exp.scenarioOrder[0] ?? "");
  const [compareB, setCompareB] = useState(exp.scenarioOrder[1] ?? exp.scenarioOrder[0] ?? "");

  // 范围、边界组合与情景比较在每次渲染时按各情景实际接受的公式版本与输入约束重算：
  // 接受/放弃改版、编辑约束或联合观测后必须立即同步失效，不能沿用旧区间。
  const accepted = sc ? computeScenarioRanges(exp, scId, "accepted") : null;
  const hasPending = sc ? pendingUnitIds(exp, sc).length > 0 : false;
  const pending = sc && hasPending ? computeScenarioRanges(exp, scId, "pending") : null;
  const comparisons = compareA && compareB && compareA !== compareB
    ? compareScenarios(exp, compareA, compareB)
    : [];

  if (!sc) return null;
  const scenarios = exp.scenarioOrder.map((id) => exp.scenarios[id]).filter(Boolean);

  return (
    <div className="uncertainty-panel">
      <h2>不确定性分析（当前情景：{sc.name}）</h2>
      <p className="hint">
        已证实 = 全部有效组合枚举穷尽；可能 = 含区间采样或枚举被截断；无法判断 = 引用环、全部组合除零/失败或缺少联合观测。
        联合观测组内的输入按行整体取值，不会拼出不存在的组合。
      </p>

      <h3>输入约束</h3>
      <ConstraintEditor exp={exp} scenarioId={scId} />

      <h3>联合观测</h3>
      <JointGroupEditor exp={exp} scenarioId={scId} />

      <h3>线性关系</h3>
      <LinearRelationEditor exp={exp} scenarioId={scId} />

      <h3>分段取值条件</h3>
      <PiecewiseEditor exp={exp} scenarioId={scId} />

      {accepted && (
        <RangeTable
          exp={exp}
          ranges={accepted.ranges}
          title={"已接受基线范围（" + sc.name + "）"}
          totalCombos={accepted.totalCombos}
          truncated={accepted.truncated}
          feasibleCombos={accepted.feasibleCombos}
          infeasibleCombos={accepted.infeasibleCombos}
        />
      )}
      {pending && (
        <RangeTable
          exp={exp}
          ranges={pending.ranges}
          title="待接受预览范围（新版本单独预览，接受前不影响基线）"
          totalCombos={pending.totalCombos}
          truncated={pending.truncated}
          feasibleCombos={pending.feasibleCombos}
          infeasibleCombos={pending.infeasibleCombos}
        />
      )}

      <div className="range-actions">
        <button className="tiny" onClick={() => saveRangeReport("accepted")}>保存基线范围报告</button>
        {hasPending && (
          <button className="tiny" onClick={() => saveRangeReport("pending")}>保存预览范围报告</button>
        )}
      </div>

      <h3>情景比较（按范围而非中点）</h3>
      {scenarios.length < 2 ? (
        <p className="hint">至少两个情景才能比较。</p>
      ) : (
        <>
          <div className="compare-selects">
            <select value={compareA} onChange={(e) => setCompareA(e.target.value)}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span>对比</span>
            <select value={compareB} onChange={(e) => setCompareB(e.target.value)}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {compareA !== compareB && (
            <p className="hint">
              约束方案比较后需明确采用一份：
              <button className="tiny" onClick={() => adoptConstraintScheme(compareA)}>
                采用 {exp.scenarios[compareA]?.name} 的约束方案
              </button>{" "}
              <button className="tiny" onClick={() => adoptConstraintScheme(compareB)}>
                采用 {exp.scenarios[compareB]?.name} 的约束方案
              </button>
              （只复制输入约束/联合观测/线性关系/分段条件到当前情景，公式版本仍各情景隔离）
            </p>
          )}
          {compareA === compareB ? (
            <p className="hint">请选择两个不同的情景。</p>
          ) : (
            <table className="unit-table">
              <thead>
                <tr><th>单元</th><th>差异来源</th><th>说明</th></tr>
              </thead>
              <tbody>
                {comparisons.map((c) => (
                  <tr key={c.unitId}>
                    <td className="mono">{c.name}</td>
                    <td>{c.attribution}</td>
                    <td className="hint">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3>已保存报告</h3>
      {(exp.reports ?? []).length === 0 && <p className="hint">还没有保存的报告。</p>}
      {(exp.reports ?? []).map((r) => <ReportCard key={r.id} exp={exp} report={r} />)}
    </div>
  );
}
