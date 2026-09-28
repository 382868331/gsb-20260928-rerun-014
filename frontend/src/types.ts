export type CellKind = "compute" | "plot";
export type CellStatus = "fresh" | "stale" | "error";

export interface Cell {
  id: string;
  name: string;
  kind: CellKind;
  code: string;
  params: Record<string, unknown>;
  deps: string[];
  status: CellStatus;
  version: number;
  input_versions: Record<string, number>;
  result: unknown;
  error: string | null;
  computed_at: number | null;
}

export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  run_count: number;
  cycle: string[] | null;
}

export interface RunReport {
  ran: string[];
  failed: string[];
  skipped: string[];
  cycle: string[] | null;
  errors: Record<string, string>;
}

export interface RunResponse {
  notebook: Notebook;
  report: RunReport;
}

export interface PlotSpec {
  chart: "line" | "scatter" | "bar";
  title?: string;
  x?: unknown[];
  series: { name: string; y: unknown[] }[];
}
