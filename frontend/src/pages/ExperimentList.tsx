import { useState } from "react";
import { useNotebook } from "../store/useNotebook";

export function ExperimentList() {
  const experiments = useNotebook((s) => s.experiments);
  const createExperiment = useNotebook((s) => s.createExperiment);
  const selectExperiment = useNotebook((s) => s.selectExperiment);
  const branch = useNotebook((s) => s.branch);
  const removeExperiment = useNotebook((s) => s.removeExperiment);
  const [name, setName] = useState("");

  const list = Object.values(experiments).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="page">
      <h1>科研计算笔记本</h1>
      <p className="hint">保存一次完整实验后，可从中分出不同参数的支线；各支线输入与结果独立保存。</p>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          createExperiment(name);
          setName("");
        }}
      >
        <input placeholder="新实验名称" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">新建实验</button>
      </form>
      <ul className="experiment-list">
        {list.map((exp) => {
          const parent = exp.parentId ? experiments[exp.parentId] : null;
          const errorCount = exp.scenarioOrder.reduce(
            (count, scenarioId) => count + Object.values(exp.scenarioResults[scenarioId] ?? {}).filter((r) => r.status === "error").length,
            0,
          );
          return (
            <li key={exp.id} className="experiment-card">
              <div className="experiment-main">
                <button className="link" onClick={() => selectExperiment(exp.id)}>
                  <strong>{exp.name}</strong>
                </button>
                <div className="meta">
                  {parent ? <span>分叉自：{parent.name}</span> : <span>根实验</span>}
                  <span>{exp.units.length} 个单元</span>
                  <span>{exp.scenarioOrder.length} 个情景</span>
                  {errorCount > 0 && <span className="error-text">{errorCount} 个错误</span>}
                </div>
              </div>
              <div className="experiment-actions">
                <button onClick={() => branch(exp.id, `${exp.name} 支线`)}>分出支线</button>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`删除实验 "${exp.name}"？`)) removeExperiment(exp.id);
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
