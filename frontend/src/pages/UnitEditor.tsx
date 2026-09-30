import { useNotebook } from "../store/useNotebook";

export function UnitEditor({ unitId, onBack }: { unitId: string; onBack: () => void }) {
  const experiment = useNotebook((s) => (s.activeId ? s.experiments[s.activeId!] : undefined));
  const updateUnit = useNotebook((s) => s.updateUnit);
  const unit = experiment?.units.find((u) => u.id === unitId);
  const result = experiment?.results[unitId];

  if (!experiment || !unit) {
    return (
      <div className="page">
        <button onClick={onBack}>返回</button>
        <p>单元不存在。</p>
      </div>
    );
  }

  const otherNames = experiment.units.filter((u) => u.id !== unit.id).map((u) => u.name);

  return (
    <div className="page">
      <div className="header-row">
        <button onClick={onBack}>← 返回笔记本</button>
        <h1>编辑单元：{unit.name}</h1>
      </div>

      <div className="editor-form">
        <label>
          名称
          <input value={unit.name} onChange={(e) => updateUnit(unit.id, { name: e.target.value })} />
        </label>

        {unit.kind === "input" ? (
          <label>
            输入数值
            <input
              value={unit.value ?? ""}
              inputMode="decimal"
              onChange={(e) => updateUnit(unit.id, { value: e.target.value })}
            />
          </label>
        ) : (
          <label>
            表达式（可引用单元名，如 a + b * 2）
            <textarea
              rows={4}
              value={unit.expression ?? ""}
              onChange={(e) => updateUnit(unit.id, { expression: e.target.value })}
            />
          </label>
        )}

        <label>
          备注
          <input value={unit.note ?? ""} onChange={(e) => updateUnit(unit.id, { note: e.target.value })} />
        </label>
      </div>

      <div className={`result-panel ${result?.status === "error" ? "result-error" : ""}`}>
        {result?.status === "ok" && (
          <p>
            当前结果：<strong className="mono">{result.value}</strong>
          </p>
        )}
        {result?.status === "error" && (
          <p className="error-text">执行失败：{result.error}（上一版结果已失效，不再作为当前值）</p>
        )}
        {(!result || result.status === "idle") && <p>待计算</p>}
      </div>

      {unit.kind === "formula" && otherNames.length > 0 && (
        <p className="hint">可引用的单元：{otherNames.join("、")}</p>
      )}
    </div>
  );
}
