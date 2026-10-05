import type { ConstraintScheme, Experiment, LinearOp, LinearRelation } from "../core/types";
import { effectiveInputText } from "../core/uncertainty";
import { uid } from "../core/storage";
import { useNotebook } from "../store/useNotebook";

/** 约束方案编辑器：线性关系 + 分段取值，支持多方案与明确采用。 */
export function SchemeEditor({ exp, scenarioId }: { exp: Experiment; scenarioId: string }) {
  const sc = exp.scenarios[scenarioId];
  const setConstraintSchemes = useNotebook((s) => s.setConstraintSchemes);
  const adoptConstraintScheme = useNotebook((s) => s.adoptConstraintScheme);
  const schemes = sc.constraintSchemes ?? [];
  const inputs = exp.units.filter((u) => u.kind === "input");
  const nameOf = (id: string) => exp.units.find((u) => u.id === id)?.name ?? id;
  const update = (next: ConstraintScheme[]) => setConstraintSchemes(next);
  const patchScheme = (id: string, patch: Partial<ConstraintScheme>) =>
    update(schemes.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const parseTerms = (text: string): LinearRelation["terms"] | null => {
    const terms: LinearRelation["terms"] = [];
    for (const piece of text.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = piece.match(/^([+-]?\d*\.?\d+)?\s*\*?\s*(.+)$/);
      if (!m) return null;
      const coef = m[1] === undefined || m[1] === "" ? 1 : Number(m[1]);
      const unit = inputs.find((u) => u.name === m[2].trim());
      if (!unit || !Number.isFinite(coef)) return null;
      terms.push({ unitId: unit.id, coef });
    }
    return terms.length > 0 ? terms : null;
  };

  const fmtTerms = (rel: LinearRelation) =>
    rel.terms.map((t) => t.coef + "*" + nameOf(t.unitId)).join(", ");

  const fmtClauses = (s: ConstraintScheme, unitId: string) =>
    (s.piecewise.find((p) => p.unitId === unitId)?.clauses ?? [])
      .map((c) => (c.when ? nameOf(c.when.unitId) + " " + c.when.op + " " + c.when.value + ": " : "") + c.values.join(", "))
      .join("\n");

  const parseClauses = (text: string) => {
    const clauses: ConstraintScheme["piecewise"][number]["clauses"] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(?:(.+?)\s*(<=|>=|==)\s*(-?\d*\.?\d+)\s*:\s*)?(.+)$/);
      if (!m) return null;
      const values = m[4].split(/[,，\s]+/).map(Number).filter((v) => Number.isFinite(v));
      if (values.length === 0) return null;
      if (m[1] !== undefined) {
        const condUnit = inputs.find((u) => u.name === m[1].trim());
        if (!condUnit) return null;
        clauses.push({ when: { unitId: condUnit.id, op: m[2] as LinearOp, value: Number(m[3]) }, values });
      } else {
        clauses.push({ values });
      }
    }
    return clauses.length > 0 ? clauses : null;
  };

  if (inputs.length === 0) return <p className="hint">还没有输入单元，无法定义约束方案。</p>;
  return (
    <div>
      {schemes.map((s) => (
        <div key={s.id} className="joint-group">
          <div className="joint-head">
            <input
              key={s.id + "name"}
              className="mono"
              defaultValue={s.name}
              onBlur={(e) => patchScheme(s.id, { name: e.target.value.trim() || s.name })}
            />
            {sc.adoptedSchemeId === s.id ? (
              <>
                <span className="range-badge range-proven">采用中</span>
                <button className="tiny" onClick={() => adoptConstraintScheme(null)}>取消采用</button>
              </>
            ) : (
              <button className="tiny" onClick={() => adoptConstraintScheme(s.id)}>采用此方案</button>
            )}
            <button className="danger tiny" onClick={() => update(schemes.filter((x) => x.id !== s.id))}>删除方案</button>
          </div>
          {s.linear.map((rel) => (
            <div key={rel.id} className="constraint-row">
              <input
                key={rel.id + "t" + rel.terms.length}
                className="mono"
                defaultValue={fmtTerms(rel)}
                placeholder="如 2*a, -1*b"
                onBlur={(e) => {
                  const terms = parseTerms(e.target.value);
                  if (terms) patchScheme(s.id, { linear: s.linear.map((r) => (r.id === rel.id ? { ...r, terms } : r)) });
                }}
              />
              <select
                value={rel.op}
                onChange={(e) => patchScheme(s.id, { linear: s.linear.map((r) => (r.id === rel.id ? { ...r, op: e.target.value as LinearOp } : r)) })}
              >
                <option value="<=">≤</option>
                <option value=">=">≥</option>
                <option value="==">=</option>
              </select>
              <input
                key={rel.id + "rhs"}
                className="mono interval-input"
                defaultValue={String(rel.rhs)}
                onBlur={(e) => {
                  const rhs = Number(e.target.value);
                  if (Number.isFinite(rhs)) patchScheme(s.id, { linear: s.linear.map((r) => (r.id === rel.id ? { ...r, rhs } : r)) });
                }}
              />
              <button className="danger tiny" onClick={() => patchScheme(s.id, { linear: s.linear.filter((r) => r.id !== rel.id) })}>删除</button>
            </div>
          ))}
          <button
            className="tiny"
            onClick={() => patchScheme(s.id, {
              linear: [...s.linear, { id: uid("lr"), terms: [{ unitId: inputs[0].id, coef: 1 }], op: "<=", rhs: 0 }],
            })}
          >
            添加线性关系
          </button>
          {s.piecewise.map((pw) => (
            <div key={pw.unitId} className="constraint-row">
              <span className="mono constraint-name">{nameOf(pw.unitId)} 分段取值</span>
              <textarea
                key={pw.unitId + s.id}
                rows={2}
                className="mono joint-rows"
                defaultValue={fmtClauses(s, pw.unitId)}
                placeholder="每行一段，如：1, 2, 5 或 b >= 2: 10, 20"
                onBlur={(e) => {
                  const clauses = parseClauses(e.target.value);
                  if (clauses) {
                    patchScheme(s.id, {
                      piecewise: s.piecewise.map((p) => (p.unitId === pw.unitId ? { ...p, clauses } : p)),
                    });
                  }
                }}
              />
              <button
                className="danger tiny"
                onClick={() => patchScheme(s.id, { piecewise: s.piecewise.filter((p) => p.unitId !== pw.unitId) })}
              >
                删除
              </button>
            </div>
          ))}
          <div className="constraint-row">
            <span className="hint">分段取值：</span>
            {inputs.filter((u) => !s.piecewise.some((p) => p.unitId === u.id)).map((u) => (
              <button
                key={u.id}
                className="tiny"
                onClick={() => patchScheme(s.id, {
                  piecewise: [...s.piecewise, { unitId: u.id, clauses: [{ values: [Number(effectiveInputText(exp, sc, u.id)) || 0] }] }],
                })}
              >
                +{u.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        className="tiny"
        onClick={() => update([...schemes, {
          id: uid("cs"),
          name: "方案 " + (schemes.length + 1),
          linear: [],
          piecewise: [],
        }])}
      >
        添加约束方案
      </button>
    </div>
  );
}
