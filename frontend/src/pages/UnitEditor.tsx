import { useNotebook } from "../store/useNotebook";
import { acceptedUnit } from "../core/scenarios";

export function UnitEditor({ unitId, onBack }: { unitId: string; onBack: () => void }) {
  const experiment = useNotebook((s) => (s.activeId ? s.experiments[s.activeId!] : undefined));
  const updateUnit = useNotebook((s) => s.updateUnit);
  const unit = experiment?.units.find((u) => u.id === unitId);

  if (!experiment || !unit) {
    return (
      <div className="page">
        <button onClick={onBack}>返回</button>
        <p>单元不存在。</p>
      </div>
    );
  }

  const otherNames = experiment.units.filter((u) => u.id !== unit.id).map((u) => u.name);
  const activeSc = experiment.activeScenarioId ? experiment.scenarios[experiment.activeScenarioId] : undefined;
  const result = activeSc?.results[unitId];
  const pending = activeSc?.pending[unitId];
  const acceptedExpr = activeSc && unit.kind === "formula"
    ? acceptedUnit(experiment, activeSc, unitId)?.expression
    : undefined;
  const baselineVersion = activeSc?.acceptedFormulaVersions[unitId] ?? unit.version;

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

        {unit.kind === "formula" ? (
          <label>
            共享表达式（所有情景共用；保存后各情景生成待接受预览，可逐情景接受） 当前 v{unit.version}
            <textarea
              rows={4}
              value={unit.expression ?? ""}
              onChange={(e) => updateUnit(unit.id, { expression: e.target.value })}
            />
          </label>
        ) : (
          <p className="hint">
            输入单元的参数按情景设置：默认值 <strong className="mono">{unit.value}</strong> 仅用于派生新情景；
            请在笔记本页各情景列中修改参数。下面仍可调整共享默认值。
          </p>
        )}

        {unit.kind === "input" && (
          <label>
            共享默认输入值
            <input
              value={unit.value ?? ""}
              inputMode="decimal"
              onChange={(e) => updateUnit(unit.id, { value: e.target.value })}
            />
          </label>
        )}

        <label>
          备注
          <input value={unit.note ?? ""} onChange={(e) => updateUnit(unit.id, { note: e.target.value })} />
        </label>
      </div>

      {pending && (
        <div className="result-panel result-pending">
          {pending.status === "ok" ? (
            <p>
              新版本 v{unit.version} 预览结果（当前情景，相对于本情景已接受的 v{baselineVersion}）：
              <strong className="mono">{pending.value}</strong>
              ，已接受结果 {result?.status === "ok" ? <span className="mono">{result.value}</span> : "失败"} 仍保留，直到在笔记本页接受。
            </p>
          ) : (
            <p className="error-text">新表达式预览失败：{pending.error}；旧版结果继续保留。</p>
          )}
        </div>
      )}

      {unit.kind === "formula" && (
        <div className="result-panel">
          <p className="hint">
            当前情景参与计算的是已接受公式 <strong>v{baselineVersion}</strong>：
            <span className="mono"> {acceptedExpr || "（空表达式）"}</span>
            {baselineVersion < unit.version && "；全局最新版仅在上方预览，接受前不会改变结果。"}
          </p>
        </div>
      )}

      <div className={`result-panel ${result?.status === "error" ? "result-error" : ""}`}>
        {result?.status === "ok" && (
          <p>
            当前已接受结果：<strong className="mono">{result.value}</strong>
          </p>
        )}
        {result?.status === "error" && (
          <p className="error-text">执行失败：{result.error}（上一版结果已失效，不再作为当前值）</p>
        )}
        {(!result || result.status === "idle") && <p>待计算</p>}
      </div>

      <p className="hint">
        {unit.kind === "formula"
          ? `修改共享公式会为全部 ${experiment.scenarioOrder.length} 个情景生成预览；在笔记本页可只接受部分情景。受影响下游单元在各情景预览中标黄。`
          : "参数只在情景列内生效；一个情景形成引用环不会影响其他情景。"}
      </p>

      {unit.kind === "formula" && otherNames.length > 0 && (
        <p className="hint">可引用的单元：{otherNames.join("、")}</p>
      )}
    </div>
  );
}
