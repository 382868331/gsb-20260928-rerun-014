export type UnitKind = "input" | "formula";

/**
 * 计算单元定义（被持久化的“输入侧”内容）。
 * input: value 是数字输入；formula: expression 引用其他单元名，如 a + b * 2。
 */
export interface ComputeUnit {
  id: string;
  name: string;
  kind: UnitKind;
  /** input 单元的当前输入值（字符串以保留用户编辑原文，计算时解析）。 */
  value?: string;
  /** formula 单元的表达式。 */
  expression?: string;
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
  /** 该结果对应的表达式/输入指纹，用于判断结果是否与当前定义一致。 */
  revision: string;
  /** 产出该结果时实际使用的直接依赖，保存后仍可追溯。 */
  dependencyIds?: string[];
}

export interface ScenarioFormulaOverride {
  unitId: string;
  expression: string;
  /** 已接受版本；未接受的预览版本保存在 pendingFormulaRevision。 */
  acceptedAt: number;
  revision: number;
}

export interface PendingFormulaChange {
  unitId: string;
  oldExpression: string;
  newExpression: string;
  revision: number;
}

export interface Scenario {
  id: string;
  name: string;
  parentScenarioId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 仅保存参数输入差异；公式默认沿用共享定义，接受情景公式改动后才存这里。 */
  parameterValues: Record<string, string>;
  formulaOverrides: Record<string, ScenarioFormulaOverride>;
  /** 预览共享公式时临时保存候选表达式；拒绝后不影响 acceptedResults。 */
  pendingFormulaRevision: number | null;
}

export interface Experiment {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  units: ComputeUnit[];
  results: Record<string, UnitResult>;
  /** 本次保存时的执行次序，用于复盘与错误定位。 */
  executionOrder: string[];
  /** 当前笔记本的参数情景；首个为基线。 */
  scenarios: Record<string, Scenario>;
  scenarioOrder: string[];
  activeScenarioId: string | null;
  /** 已接受结果按 scenarioId/unitId 保存，情景间互不覆写。 */
  scenarioResults: Record<string, Record<string, UnitResult>>;
  scenarioOrders: Record<string, string[]>;
  /** 尚未接受的公式预览结果。 */
  previewResults: Record<string, Record<string, UnitResult>>;
  pendingFormulaChange: PendingFormulaChange | null;
  /** 笔记本公式当前版本号。 */
  formulaRevision: number;
  /** 已合并到共享定义的最高候选版本。 */
  sharedFormulaRevision: number;
}

export interface NotebookState {
  experiments: Record<string, Experiment>;
  rootId: string | null;
  activeId: string | null;
}
