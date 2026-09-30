export type CellType = 'input' | 'formula';

export interface Cell {
  id: string;
  /** 用户可见的变量名，作为其他单元引用的标识 */
  name: string;
  type: CellType;
  /** input 单元为原始数值文本；formula 单元为表达式 */
  expr: string;
}

export type CellStatus = 'clean' | 'error' | 'stale' | 'skipped' | 'pending';

export interface CellResult {
  status: CellStatus;
  /** status === 'clean' 时的成功值 */
  value: number | null;
  /** 错误信息（编译错误、运行错误、引用错误、上游错误等） */
  error: string | null;
  /** 产生该结果时单元内容的指纹，用于重开后判断结果是否仍对应当前输入 */
  fingerprint: string | null;
  /** 本次求值实际依赖的上游单元 id（拓扑计算后用于增量传播） */
  deps: string[];
}

export interface CellWithResult {
  cell: Cell;
  result: CellResult;
}

export interface RunReport {
  results: Record<string, CellResult>;
  /** 本次真正执行过的单元 id（含执行失败的单元） */
  executed: string[];
  /** 检测到的所有环（每个环为单元 id 序列，首尾相同） */
  cycles: string[][];
}

export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  results: Record<string, CellResult>;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExperimentSummary {
  id: string;
  title: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  cellCount: number;
  cleanCount: number;
  errorCount: number;
}

export const pendingResult = (fingerprint: string | null = null): CellResult => ({
  status: 'pending',
  value: null,
  error: null,
  fingerprint,
  deps: [],
});

export const skippedResult = (
  error: string,
  fingerprint: string | null,
  deps: string[],
): CellResult => ({
  status: 'skipped',
  value: null,
  error,
  fingerprint,
  deps,
});

export const errorResult = (
  error: string,
  fingerprint: string | null,
  deps: string[] = [],
): CellResult => ({
  status: 'error',
  value: null,
  error,
  fingerprint,
  deps,
});

export const cleanResult = (value: number, fingerprint: string, deps: string[]): CellResult => ({
  status: 'clean',
  value,
  error: null,
  fingerprint,
  deps,
});
