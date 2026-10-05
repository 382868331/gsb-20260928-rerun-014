export type UnitKind = "input" | "formula";

/**
 * 输入约束：未设置时按确定值（参数覆盖或共享默认值）处理。
 * candidates: 有限候选值，可枚举穷尽；interval: 连续区间，按 samples 个采样点估计（结果记为可能范围）。
 */
export type InputConstraint =
  | { kind: "candidates"; values: number[] }
  | { kind: "interval"; min: number; max: number; samples: number };

/**
 * 联合观测组：组内输入来自同一次观测，取值只能按行整体出现，
 * 不能把互相关联的值任意拼成不存在的组合。rows 每列与 unitIds 顺序对应。
 */
export interface JointGroup {
  id: string;
  unitIds: string[];
  rows: number[][];
}

/**
 * 线性关系约束：对相关输入施加线性（不）等式，如 "a + 2*b <= 10"。
 * 只接受线性形式；含变量相乘/相除/乘方等非线性形式时无法证明，相关单元记为无法判断。
 */
export interface LinearRelation {
  id: string;
  /** 关系原文：左侧与右侧均为输入名的线性组合，中间为 <=、>=、=、<、> 之一。 */
  expression: string;
}

/**
 * 分段取值条件：目标输入的允许取值随依据输入分段切换——
 * 依据输入 < 阈值时目标只能取 lower 中的值，否则只能取 upper 中的值。
 */
export interface PiecewiseCondition {
  id: string;
  /** 依据输入（分段条件看它的取值）。 */
  driverId: string;
  threshold: number;
  /** 被限制的目标输入。 */
  targetId: string;
  /** 依据输入 < 阈值时目标允许取值。 */
  lower: number[];
  /** 依据输入 >= 阈值时目标允许取值。 */
  upper: number[];
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
  /** 输入约束（区间/候选集）；派生情景继承派生时的约束，之后各自独立更新。 */
  inputConstraints?: Record<string, InputConstraint>;
  /** 联合观测组：声明哪些输入来自同一次联合观测。 */
  jointGroups?: JointGroup[];
  /** 线性关系约束：进一步收紧相关输入的可行组合。 */
  linearRelations?: LinearRelation[];
  /** 分段取值条件：目标输入的允许集合随依据输入分段切换。 */
  piecewiseConditions?: PiecewiseCondition[];
  /** 已接受的当前结果：unitId -> 结果（结果体内容寻址存放在实验级 resultStore）。 */
  results: Record<string, UnitResult>;
  /** 已接受结果对应的内容键，用于结果仓引用计数。 */
  resultKeys: Record<string, string>;
  /** 公式改版后尚未接受的预览结果；接受前旧结果继续保留。 */
  pending: Record<string, UnitResult>;
  /** pending 结果在结果仓中的暂存键（pn: 前缀）。 */
  pendingKeys: Record<string, string>;
  /** 本次预览中各公式单元的目标版本；未列出的下游公式沿用自己的基线版本。 */
  pendingFormulaVersions?: Record<string, number>;
  /** 预览图的拓扑次序，不覆盖已接受图的来源信息。 */
  pendingExecutionOrder?: string[];
  /** 本次预览检测到的环。 */
  pendingCycleUnitIds?: string[];
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

/** 单个单元的范围结论。 */
export interface UnitRange {
  unitId: string;
  /** proven=已证实（组合枚举穷尽）；possible=可能（含区间采样或被截断）；indeterminate=无法判断。 */
  status: "proven" | "possible" | "indeterminate";
  min?: number;
  max?: number;
  /** 取得下界/上界的真实输入组合（输入单元名 -> 取值）。 */
  minWitness?: Record<string, number>;
  maxWitness?: Record<string, number>;
  /** 成功求值的组合数。 */
  evaluated: number;
  /** 求值失败（如除零）的组合数与原因。 */
  failed: number;
  failureReasons?: string[];
  /** 无法判断时的原因（引用环 / 缺少联合观测 / 上游无法判断等）。 */
  reason?: string;
}

/** 一次范围分析报告：按当时的输入约束与公式版本计算，保存后可独立解释。 */
export interface RangeReport {
  id: string;
  name: string;
  createdAt: number;
  scenarioId: string;
  scenarioName: string;
  /** 分析视图：已接受基线或待接受预览。 */
  target: "accepted" | "pending";
  /** 分析时各公式单元使用的版本。 */
  formulaVersions: Record<string, number>;
  /** 分析时的输入约束与参数覆盖快照。 */
  inputConstraints: Record<string, InputConstraint>;
  jointGroups: JointGroup[];
  linearRelations: LinearRelation[];
  piecewiseConditions: PiecewiseCondition[];
  params: Record<string, string>;
  unitNames: Record<string, string>;
  ranges: Record<string, UnitRange>;
  totalCombos: number;
  truncated: boolean;
  /** 通过联合约束过滤后的可行组合数（旧报告可能缺失）。 */
  feasibleCombos?: number;
}

export interface Experiment {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 共享单元定义（公式与版本对所有情景一致）。 */
  units: ComputeUnit[];
  /** 公式历史表达式：unitId -> version -> expression，用于让旧情景继续按旧版计算。 */
  formulaHistory?: Record<string, Record<number, string>>;
  scenarios: Record<string, Scenario>;
  scenarioOrder: string[];
  activeScenarioId: string | null;
  /** 实验级结果仓：内容键 -> 结果 + 引用情景。删除情景不破坏其他情景沿用的记录。 */
  resultStore: Record<string, CachedResult>;
  /** 保存的范围分析报告：按保存时的输入约束与公式版本解释，后续修改不影响旧报告。 */
  reports?: RangeReport[];
}

export interface NotebookState {
  experiments: Record<string, Experiment>;
  rootId: string | null;
  activeId: string | null;
}
