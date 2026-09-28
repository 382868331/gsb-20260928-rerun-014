import { Background, Controls, Edge, Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Notebook } from "./types";

const COLORS: Record<string, string> = {
  fresh: "#16a34a",
  stale: "#d97706",
  error: "#dc2626",
};

export function GraphView({ notebook }: { notebook: Notebook }) {
  const cells = notebook.cells;
  const depth = new Map<string, number>();
  const resolve = (name: string, seen = new Set<string>()): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (seen.has(name)) return 0;
    seen.add(name);
    const cell = cells.find((c) => c.name === name);
    const d = cell && cell.deps.length
      ? 1 + Math.max(...cell.deps.map((x) => resolve(x, new Set(seen))))
      : 0;
    depth.set(name, d);
    return d;
  };
  cells.forEach((c) => resolve(c.name));
  const perLayer = new Map<number, number>();
  const nodes: Node[] = cells.map((c) => {
    const layer = depth.get(c.name) ?? 0;
    const idx = perLayer.get(layer) ?? 0;
    perLayer.set(layer, idx + 1);
    return {
      id: c.name,
      position: { x: layer * 220, y: idx * 90 },
      data: { label: `${c.name} · v${c.version}` },
      style: {
        border: `2px solid ${COLORS[c.status]}`,
        borderRadius: 8,
        padding: 6,
        fontSize: 12,
        background: "#fff",
      },
    };
  });
  const edges: Edge[] = cells.flatMap((c) =>
    c.deps
      .filter((d) => cells.some((x) => x.name === d))
      .map((d) => ({
        id: `${d}->${c.name}`,
        source: d,
        target: c.name,
        animated: c.status === "stale",
      })),
  );
  return (
    <div className="graph">
      <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
