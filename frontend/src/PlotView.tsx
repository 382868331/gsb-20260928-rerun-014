import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type { PlotSpec } from "./types";

export function isPlotSpec(v: unknown): v is PlotSpec {
  return !!v && typeof v === "object" && Array.isArray((v as PlotSpec).series);
}

export function PlotView({ spec }: { spec: PlotSpec }) {
  const x = (spec.x ?? []) as number[];
  const rows = x.length
    ? x.map((xv, i) => {
        const row: Record<string, unknown> = { x: xv };
        spec.series.forEach((s) => (row[s.name] = (s.y as unknown[])[i]));
        return row;
      })
    : ((spec.series[0]?.y ?? []) as unknown[]).map((yv, i) => {
        const row: Record<string, unknown> = { x: i };
        spec.series.forEach((s) => (row[s.name] = (s.y as unknown[])[i]));
        return row;
      });
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea"];
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="x" type="number" domain={["auto", "auto"]} />
      <YAxis />
      <Tooltip />
      <Legend />
    </>
  );
  return (
    <div className="plot">
      {spec.title && <div className="plot-title">{spec.title}</div>}
      <ResponsiveContainer width="100%" height={260}>
        {spec.chart === "scatter" ? (
          <ScatterChart>
            {axes}
            {spec.series.map((s, i) => (
              <Scatter key={s.name} name={s.name} data={rows}
                dataKey={s.name} fill={colors[i % colors.length]} />
            ))}
          </ScatterChart>
        ) : spec.chart === "bar" ? (
          <BarChart data={rows}>
            {axes}
            {spec.series.map((s, i) => (
              <Bar key={s.name} name={s.name} dataKey={s.name}
                fill={colors[i % colors.length]} />
            ))}
          </BarChart>
        ) : (
          <LineChart data={rows}>
            {axes}
            {spec.series.map((s, i) => (
              <Line key={s.name} name={s.name} dataKey={s.name} dot={false}
                stroke={colors[i % colors.length]} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
