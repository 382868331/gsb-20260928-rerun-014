import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useStore } from "./store";
import type { Cell } from "./types";
import { isPlotSpec, PlotView } from "./PlotView";

const STATUS_LABEL: Record<Cell["status"], string> = {
  fresh: "最新",
  stale: "过期",
  error: "失败",
};

function ResultPreview({ cell }: { cell: Cell }) {
  if (cell.status === "error")
    return <pre className="error">{cell.error}</pre>;
  if (cell.result == null)
    return <div className="muted">尚无结果</div>;
  if (cell.kind === "plot" && isPlotSpec(cell.result))
    return <PlotView spec={cell.result} />;
  const text = JSON.stringify(cell.result, null, 1);
  return <pre className="result">{text.length > 800 ? text.slice(0, 800) + " …" : text}</pre>;
}

export function CellCard({ cell }: { cell: Cell }) {
  const { updateCell, deleteCell } = useStore();
  const [code, setCode] = useState(cell.code);
  const [params, setParams] = useState(JSON.stringify(cell.params, null, 2));
  const [paramsErr, setParamsErr] = useState<string | null>(null);
  const dirty = code !== cell.code ||
    params !== JSON.stringify(cell.params, null, 2);

  const save = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(params || "{}");
    } catch {
      setParamsErr("参数不是合法 JSON");
      return;
    }
    setParamsErr(null);
    await updateCell(cell.id, { code, params: parsed });
  };

  return (
    <div className={`cell cell-${cell.status}`}>
      <div className="cell-head">
        <span className="cell-name">{cell.name}</span>
        <span className="cell-kind">{cell.kind === "plot" ? "绘图" : "计算"}</span>
        <span className={`badge badge-${cell.status}`}>
          {STATUS_LABEL[cell.status]}
        </span>
        <span className="muted">v{cell.version}</span>
        {cell.deps.length > 0 && (
          <span className="muted">依赖: {cell.deps.join(", ")}</span>
        )}
        <button className="icon" title="删除单元"
          onClick={() => deleteCell(cell.id)}>
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        className="code"
        value={code}
        spellCheck={false}
        rows={Math.max(3, code.split("\n").length)}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="params-row">
        <span className="muted">参数</span>
        <input
          value={params}
          onChange={(e) => setParams(e.target.value)}
          spellCheck={false}
        />
        {dirty && <button onClick={save}>保存修改</button>}
        {paramsErr && <span className="error-text">{paramsErr}</span>}
      </div>
      <ResultPreview cell={cell} />
    </div>
  );
}
