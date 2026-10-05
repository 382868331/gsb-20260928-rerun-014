import { useState } from "react";
import type { Experiment, InputConstraint, JointGroup, RangeReport, UnitRange } from "../core/types";
import { compareScenarios, computeScenarioRanges, effectiveInputText } from "../core/uncertainty";
import { compareConstraintSchemes } from "../core/uncertainty";
import { pendingUnitIds } from "../core/scenarios";
import { uid } from "../core/storage";
import { useNotebook } from "../store/useNotebook";
import { SchemeEditor } from "./SchemeEditor";

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

function RangeTable({ exp, ranges, title, totalCombos, truncated, infeasible, schemeName }: {
  exp: Experiment;
  ranges: Record<string, UnitRange>;
  title: string;
  totalCombos: number;
  truncated: boolean;
  infeasible?: number;
  schemeName?: string | null;
}) {
  const nameOf = (id: string) => exp.units.find((u) => u.id === id)?.name ?? id;
  return (
    <div className="range-block">
      <h3>{title}</h3>
      <p className="hint">
        共枚举 {totalCombos} 个输入组合{truncated ? "（超出上限已截断，范围降级为可能）" : ""}。
        {schemeName
          ? `采用约束方案 "${schemeName}"，排除 ${infeasible ?? 0} 个不满足方案的组合；边界组合均满足该方案。`
          : ""}
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
        {report.adoptedScheme ? `保存时采用约束方案 "${report.adoptedScheme.name}"。` : "保存时未采用约束方案。"}
      </p>
      {open && (
        <RangeTable
          exp={{ ...exp, units: exp.units.map((u) => ({ ...u, name: report.unitNames[u.id] ?? u.name })) }}
          ranges={report.ranges}
          title="保存时的范围"
          totalCombos={report.totalCombos}
          truncated={report.truncated}
        />
      )}
    </div>
  );
}

export function UncertaintyPanel({ exp }: { exp: Experiment }) {
  const saveRangeReport = useNotebook((s) => s.saveRangeReport);
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
  const schemeComparisons = sc ? compareConstraintSchemes(exp, scId) : [];

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

      <h3>约束方案（线性关系 + 分段取值）</h3>
      <p className="hint">
        方案只作用于输入组合：满足全部线性关系与分段取值的组合才参与求界，
        边界组合必为可行组合；无可行组合或方案无效时记为无法判断并给出原因。
      </p>
      <SchemeEditor exp={exp} scenarioId={scId} />

      {schemeComparisons.length > 1 && (
        <>
          <h4>方案比较（同一情景、同一公式版本下逐方案重算）</h4>
          <table className="unit-table">
            <thead>
              <tr>
                <th>方案</th>
                {exp.units.filter((u) => u.kind === "formula").map((u) => <th key={u.id}>{u.name}</th>)}
                <th>排除组合</th>
              </tr>
            </thead>
            <tbody>
              {schemeComparisons.map((row) => (
                <tr key={row.schemeId ?? "none"}>
                  <td>{row.name}{row.adopted ? "（采用中）" : ""}</td>
                  {exp.units.filter((u) => u.kind === "formula").map((u) => {
                    const r = row.result.ranges[u.id];
                    return (
                      <td key={u.id} className="mono">
                        {!r || r.status === "indeterminate"
                          ? "无法判断"
                          : `[${fmtNum(r.min)}, ${fmtNum(r.max)}]（${statusLabel(r)}）`}
                      </td>
                    );
                  })}
                  <td className="mono">{row.result.infeasible}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {accepted && (
        <RangeTable
          exp={exp}
          ranges={accepted.ranges}
          title={"已接受基线范围（" + sc.name + "）"}
          totalCombos={accepted.totalCombos}
          truncated={accepted.truncated}
          infeasible={accepted.infeasible}
          schemeName={accepted.schemeName}
        />
      )}
      {pending && (
        <RangeTable
          exp={exp}
          ranges={pending.ranges}
          title="待接受预览范围（新版本单独预览，接受前不影响基线）"
          totalCombos={pending.totalCombos}
          truncated={pending.truncated}
          infeasible={pending.infeasible}
          schemeName={pending.schemeName}
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
