export type UnitKind = "input" | "formula";

/**
 * 公式的一个已发布版本。共享公式每次改版都追加一条记录，
 * 因此停留在旧已接受版本的情景仍能用当时的表达式计算，
 * 结果可以追溯到精确的公式版本。
 */
export interface FormulaRevision {
  version: number;
  expression: string;
}

/**
 * 计算单元定义（被持久化的“输入侧”内容）。
 * input: value 是数字输入；formula: expression 引用其他单元名，如 a + b * 2。
 */
export interface ComputeUnit {
  id: string;
  name: string;
  kind: UnitKind;
  /** input 单元的共享默认输入值；情景可在 params 中覆盖。字符串保留编辑原文。 */
  value?: string;
  /** formula 单元的表达式。 */
  expression?: string;
  /** 定义版本号：公式内容每次变更 +1，用于区分新旧结果并支持逐情景接受。 */
  version: number;
  /** 公式的版本历史（仅 formula）：包含从首版到当前版本的全部表达式。 */
  revisions?: FormulaRevision[];
  note?: string;
}

export type UnitStatus = "idle" | "ok" | "error";

/**
 * 单元结果（“输出侧”内容）。失败时 status=error 且 value 为空，
 * 绝不能继续把上一版成功值当作当前值。
 */
export interface UnitResult {
  unitId: string;
  status: UnitStatus;
  value: number | null;
  error?: string;
  /** 错误类别：定义错误 / 引用环 / 上游失败 / 求值错误，便于定位与 UI 区分。 */
  errorKind?: "definition" | "cycle" | "upstream" | "eval";
  /** 该结果对应的表达式/输入指纹，用于判断结果是否与当前定义一致。 */
  revision: string;
}

/**
 * 参数情景：从同一本笔记本派生的一组参数覆盖。
 * 公式定义在实验内共享，情景只保存自己的参数、已接受结果与待处理（pending）预览。
 */
export interface Scenario {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  /** 参数覆盖：input 单元 id -> 输入文本；未覆盖则使用共享默认值。 */
  params: Record<string, string>;
  /** 已接受的当前结果：unitId -> 结果（结果体内容寻址存放在实验级 resultStore）。 */
  results: Record<string, UnitResult>;
  /** 已接受结果对应的内容键，用于结果仓引用计数。 */
  resultKeys: Record<string, string>;
  /** 公式改版后尚未接受的预览结果；接受前旧结果继续保留。 */
  pending: Record<string, UnitResult>;
  /** pending 结果在结果仓中的暂存键（pn: 前缀）。 */
  pendingKeys: Record<string, string>;
  /** 每个公式单元已接受的版本号；低于单元当前版本即存在待处理改版。 */
  acceptedFormulaVersions: Record<string, number>;
  /** 可执行单元的拓扑次序（环及其下游无唯一位置，不在其中）。 */
  executionOrder: string[];
  /** 本次运行检测到的环（成员 id 列表）。 */
  cycleUnitIds: string[];
}

/** 内容寻址的结果记录：相同定义+上游结果只存一份，多情景共享。 */
export interface CachedResult {
  key: string;
  result: UnitResult;
  /** 正在沿用该记录的情景 id；删除情景只解除引用。 */
  refIds: string[];
}

export interface Experiment {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 共享单元定义（公式与版本对所有情景一致）。 */
  units: ComputeUnit[];
  scenarios: Record<string, Scenario>;
  scenarioOrder: string[];
  activeScenarioId: string | null;
  /** 实验级结果仓：内容键 -> 结果 + 引用情景。删除情景不破坏其他情景沿用的记录。 */
  resultStore: Record<string, CachedResult>;
}

export interface NotebookState {
  experiments: Record<string, Experiment>;
  rootId: string | null;
  activeId: string | null;
}
