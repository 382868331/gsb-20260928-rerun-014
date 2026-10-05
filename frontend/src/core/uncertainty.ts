import type {
  Experiment,
  InputConstraint,
  JointGroup,
  LinearRelation,
  PiecewiseCondition,
  RangeReport,
  Scenario,
  UnitRange,
} from "./types";
import { evaluate } from "./evaluator";
import {
  affectedDownstream,
  buildGraph,
  cycleMembership,
  findCycles,
  topologicalOrder,
} from "./engine";
import { effectiveUnits, scenarioFormulaVersion } from "./scenarios";
import { uid } from "./storage";

/** 组合枚举上限：超过则截断，范围降级为“可能”。 */
export const MAX_COMBOS = 20000;
/** 区间未显式给采样点数时的默认采样点数（含端点）。 */
export const DEFAULT_INTERVAL_SAMPLES = 5;
/** 线性关系判定时的零容差。 */
const REL_EPS = 1e-9;

interface ComboSource {
  unitIds: string[];
  rows: number[][];
}

function intervalRows(min: number, max: number, samples: number): number[][] {
  const n = Math.max(2, Math.floor(samples));
  if (n === 2) return [[min], [max]];
  const step = (max - min) / (n - 1);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push([i === n - 1 ? max : min + step * i]);
  return rows;
}

function constraintRows(c: InputConstraint): number[][] | string {
  if (c.kind === "candidates") {
    const values = (c.values ?? []).filter((v) => Number.isFinite(v));
    if (values.length === 0) return "候选集为空";
    return values.map((v) => [v]);
  }
  if (!Number.isFinite(c.min) || !Number.isFinite(c.max)) return "区间端点不是有效数字";
  if (c.min > c.max) return "区间下界大于上界";
  const samples = Number.isFinite(c.samples) && c.samples >= 2 ? c.samples : DEFAULT_INTERVAL_SAMPLES;
  return intervalRows(c.min, c.max, samples);
}
/** 线性形式：各输入名 -> 系数，加常数项。 */
interface LinearForm {
  coef: Map<string, number>;
  constant: number;
}

function formConstant(v: number): LinearForm {
  return { coef: new Map(), constant: v };
}

function addForm(a: LinearForm, b: LinearForm, sign: 1 | -1): LinearForm {
  const coef = new Map(a.coef);
  for (const [name, c] of b.coef) coef.set(name, (coef.get(name) ?? 0) + sign * c);
  return { coef, constant: a.constant + sign * b.constant };
}

function scaleForm(a: LinearForm, k: number): LinearForm {
  const coef = new Map<string, number>();
  for (const [name, c] of a.coef) coef.set(name, c * k);
  return { coef, constant: a.constant * k };
}

function isConstForm(a: LinearForm): boolean {
  return [...a.coef.values()].every((c) => c === 0);
}

/**
 * 解析线性形式：数字、输入名、+ - * / 与括号。
 * 变量相乘/相除、除以变量、乘方等一律视为非线性并抛错——
 * 非线性关系无法通过组合过滤证明边界，由上层记为无法判断。
 */
export function parseLinearForm(expression: string): LinearForm {
  const tokens: { type: "num" | "name" | "op" | "lp" | "rp"; value: string }[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "(") { tokens.push({ type: "lp", value: ch }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "rp", value: ch }); i++; continue; }
    if ("+-*/".includes(ch)) { tokens.push({ type: "op", value: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < expression.length && /[0-9.eE]/.test(expression[j])) j++;
      const raw = expression.slice(i, j);
      if (Number.isNaN(Number(raw))) throw new Error("无法解析数字 " + raw);
      tokens.push({ type: "num", value: raw });
      i = j;
      continue;
    }
    const m = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/.exec(expression.slice(i));
    if (m) {
      tokens.push({ type: "name", value: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error("含非线性或无法解析的符号 " + ch);
  }
  if (tokens.length === 0) throw new Error("关系式为空");
  let pos = 0;
  const peek = () => tokens[pos];

  function parseExpr(): LinearForm {
    let left = parseTerm();
    while (peek()?.type === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      const op = tokens[pos++].value;
      left = addForm(left, parseTerm(), op === "+" ? 1 : -1);
    }
    return left;
  }
  function parseTerm(): LinearForm {
    let left = parseFactor();
    while (peek()?.type === "op" && (peek()!.value === "*" || peek()!.value === "/")) {
      const op = tokens[pos++].value;
      const right = parseFactor();
      if (op === "*") {
        if (!isConstForm(left) && !isConstForm(right)) throw new Error("含变量相乘的非线性形式");
        left = isConstForm(left) ? scaleForm(right, left.constant) : scaleForm(left, right.constant);
      } else {
        if (!isConstForm(right)) throw new Error("含除以变量的非线性形式");
        if (right.constant === 0) throw new Error("关系式中除以零");
        left = scaleForm(left, 1 / right.constant);
      }
    }
    return left;
  }
  function parseFactor(): LinearForm {
    let sign: 1 | -1 = 1;
    if (peek()?.type === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      if (tokens[pos++].value === "-") sign = -1;
    }
    const base = parsePrimary();
    return sign === 1 ? base : scaleForm(base, -1);
  }
  function parsePrimary(): LinearForm {
    const t = peek();
    if (!t) throw new Error("关系式不完整");
    if (t.type === "num") { pos++; return formConstant(Number(t.value)); }
    if (t.type === "name") {
      pos++;
      const coef = new Map<string, number>();
      coef.set(t.value, 1);
      return { coef, constant: 0 };
    }
    if (t.type === "lp") {
      pos++;
      const v = parseExpr();
      if (peek()?.type !== "rp") throw new Error("缺少右括号");
      pos++;
      return v;
    }
    throw new Error("意外的符号 " + t.value);
  }

  const form = parseExpr();
  if (pos !== tokens.length) throw new Error("多余的符号 " + tokens[pos].value);
  return form;
}

type RelationOp = "<=" | ">=" | "=" | "<" | ">";

interface CompiledRelation {
  /** 输入单元 id -> 系数（已把右侧移到左侧）。 */
  coef: Map<string, number>;
  constant: number;
  op: RelationOp;
}

/** 解析 "lhs <= rhs" 形式的线性关系；非线性或引用未知输入时抛错。 */
export function parseLinearRelation(
  expression: string,
  inputIdByName: Map<string, string>,
): CompiledRelation {
  const m = /^(.*?)(<=|>=|=|<|>)(.*)$/.exec(expression);
  if (!m) throw new Error("缺少比较符（<=、>=、=、<、>）");
  const lhs = parseLinearForm(m[1]);
  const rhs = parseLinearForm(m[3]);
  const diff = addForm(lhs, rhs, -1);
  const coef = new Map<string, number>();
  for (const [name, c] of diff.coef) {
    if (c === 0) continue;
    const id = inputIdByName.get(name);
    if (!id) throw new Error("引用了不存在或非输入的单元 " + name);
    coef.set(id, (coef.get(id) ?? 0) + c);
  }
  return { coef, constant: diff.constant, op: m[2] as RelationOp };
}

function relationHolds(rel: CompiledRelation, assignment: Map<string, number>): boolean {
  let v = rel.constant;
  for (const [id, c] of rel.coef) v += c * (assignment.get(id) ?? 0);
  switch (rel.op) {
    case "<=": return v <= REL_EPS;
    case ">=": return v >= -REL_EPS;
    case "<": return v < -REL_EPS;
    case ">": return v > REL_EPS;
    default: return Math.abs(v) <= REL_EPS;
  }
}

interface CompiledPiecewise {
  driverId: string;
  threshold: number;
  targetId: string;
  lower: Set<number>;
  upper: Set<number>;
}

function piecewiseHolds(pw: CompiledPiecewise, assignment: Map<string, number>): boolean {
  const driver = assignment.get(pw.driverId);
  const target = assignment.get(pw.targetId);
  if (driver === undefined || target === undefined) return false;
  const allowed = driver < pw.threshold ? pw.lower : pw.upper;
  return allowed.has(target);
}


/** 输入单元在某情景下的有效确定值（参数覆盖优先，否则共享默认值）。 */
export function effectiveInputText(exp: Experiment, sc: Scenario, unitId: string): string {
  if (Object.prototype.hasOwnProperty.call(sc.params, unitId)) return sc.params[unitId];
  return exp.units.find((u) => u.id === unitId)?.value ?? "";
}

export interface RangeComputation {
  ranges: Record<string, UnitRange>;
  totalCombos: number;
  truncated: boolean;
  /** 通过线性关系与分段条件过滤后的可行组合数。 */
  feasibleCombos: number;
  /** 被联合约束过滤掉的组合数。 */
  infeasibleCombos: number;
}

/**
 * 枚举情景的有效输入组合并计算每个单元的取值范围。
 * - 联合观测组按行整体取值，不会拼出不存在的组合；
 * - 候选集/确定值可穷尽枚举，结果为“已证实”；
 * - 区间按采样点估计，结果为“可能”；
 * - 引用环、除零（全部组合失败）、缺少联合观测数据等记为“无法判断”。
 */
export function computeScenarioRanges(
  exp: Experiment,
  scenarioId: string,
  target: "accepted" | "pending" = "accepted",
): RangeComputation {
  const sc = exp.scenarios[scenarioId];
  const units = effectiveUnits(exp, sc, target);
  const graph = buildGraph(units);
  const cycles = findCycles(units, graph);
  const membership = cycleMembership(units, cycles);
  const cycleIds = new Set(membership.keys());
  const blockedIds = affectedDownstream([...cycleIds], graph);
  for (const id of cycleIds) blockedIds.delete(id);
  const order = topologicalOrder(units, graph, new Set([...cycleIds, ...blockedIds]));

  const unitById = new Map(units.map((u) => [u.id, u]));
  const nameOf = (id: string) => unitById.get(id)?.name ?? id;
  const reasons = new Map<string, string>();

  for (const id of cycleIds) reasons.set(id, `处于引用环：${membership.get(id)}`);
  for (const id of blockedIds) reasons.set(id, "上游处于引用环中，无法判断");

  // 定义级错误（直接引用自身、重名、引用不存在等）：该情景当前接受版本即无法判断。
  for (const [id, err] of graph.definitionErrors) {
    if (!reasons.has(id)) reasons.set(id, `定义错误：${err}`);
  }

  // 输入源：联合组 / 候选集 / 区间 / 确定值。
  const sources: ComboSource[] = [];
  const grouped = new Set<string>();
  for (const group of sc.jointGroups ?? []) {
    const memberIds = group.unitIds.filter((id) => unitById.get(id)?.kind === "input");
    if (memberIds.length === 0) continue;
    for (const id of memberIds) grouped.add(id);
    const rows = (group.rows ?? []).filter((r) => r.length === memberIds.length && r.every(Number.isFinite));
    if (rows.length === 0) {
      for (const id of memberIds) {
        if (!reasons.has(id)) reasons.set(id, `联合观测组缺少观测数据（${memberIds.map(nameOf).join("、")}）`);
      }
      continue;
    }
    sources.push({ unitIds: memberIds, rows });
  }

  const intervalInputIds = new Set<string>();
  for (const u of units) {
    if (u.kind !== "input" || grouped.has(u.id)) continue;
    const c = sc.inputConstraints?.[u.id];
    if (c) {
      const rows = constraintRows(c);
      if (typeof rows === "string") {
        if (!reasons.has(u.id)) reasons.set(u.id, `输入约束无效：${rows}`);
        continue;
      }
      if (c.kind === "interval") intervalInputIds.add(u.id);
      sources.push({ unitIds: [u.id], rows });
    } else {
      const raw = effectiveInputText(exp, sc, u.id).trim();
      const v = Number(raw);
      if (raw === "" || !Number.isFinite(v)) {
        if (!reasons.has(u.id)) reasons.set(u.id, raw === "" ? "输入为空" : `输入 "${raw}" 不是有效数字`);
        continue;
      }
      sources.push({ unitIds: [u.id], rows: [[v]] });
    }
  }

  // 线性关系与分段取值条件：编译为组合过滤器；无法证明的约束（非线性、引用未知、
  // 分段条件无效）按其涉及的输入向下游记为无法判断，绝不给出未证实的边界。
  const relationFilters: CompiledRelation[] = [];
  const piecewiseFilters: CompiledPiecewise[] = [];
  const inputIdByName = new Map(
    units.filter((u) => u.kind === "input").map((u) => [u.name, u.id] as const),
  );
  const markUnprovable = (involvedIds: string[], reason: string) => {
    const targets = involvedIds.length > 0
      ? affectedDownstream(involvedIds, graph)
      : new Set(units.map((u) => u.id));
    for (const id of targets) {
      if (!reasons.has(id)) reasons.set(id, reason);
    }
  };

  for (const rel of sc.linearRelations ?? []) {
    try {
      relationFilters.push(parseLinearRelation(rel.expression, inputIdByName));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const names = [...rel.expression.matchAll(/[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/g)].map((m) => m[0]);
      const involved = names.map((n) => inputIdByName.get(n)).filter((id): id is string => !!id);
      markUnprovable([...new Set(involved)], "联合约束无法证明：线性关系 \"" + rel.expression + "\" " + msg);
    }
  }

  for (const pw of sc.piecewiseConditions ?? []) {
    const driver = unitById.get(pw.driverId);
    const target = unitById.get(pw.targetId);
    const lower = (pw.lower ?? []).filter(Number.isFinite);
    const upper = (pw.upper ?? []).filter(Number.isFinite);
    const invalid = !driver || driver.kind !== "input" || !target || target.kind !== "input"
      || !Number.isFinite(pw.threshold) || lower.length === 0 || upper.length === 0;
    if (invalid) {
      const involved = [pw.driverId, pw.targetId].filter((id) => unitById.has(id));
      markUnprovable(involved, "联合约束无法证明：分段取值条件无效（依据/目标必须是输入单元，阈值有限且两段取值集非空）");
      continue;
    }
    piecewiseFilters.push({
      driverId: pw.driverId,
      threshold: pw.threshold,
      targetId: pw.targetId,
      lower: new Set(lower),
      upper: new Set(upper),
    });
  }

  const comboFeasible = (assignment: Map<string, number>): boolean =>
    relationFilters.every((rel) => relationHolds(rel, assignment))
    && piecewiseFilters.every((pw) => piecewiseHolds(pw, assignment));

  // 无法判断沿依赖向下游传播。
  for (const id of order) {
    const u = unitById.get(id)!;
    if (u.kind !== "formula" || reasons.has(id)) continue;
    const badDep = (graph.deps.get(id) ?? []).find((d) => reasons.has(d));
    if (badDep) reasons.set(id, `上游单元 "${nameOf(badDep)}" 无法判断`);
  }

  // 区间影响到的单元：范围只是采样估计。
  const intervalAffected = affectedDownstream([...intervalInputIds], graph);

  // 组合总数（用于截断判断）。
  let total = 1;
  for (const s of sources) total *= s.rows.length;
  const truncated = total > MAX_COMBOS;
  const totalCombos = truncated ? MAX_COMBOS : total;

  interface Acc {
    min: number;
    max: number;
    minW?: Record<string, number>;
    maxW?: Record<string, number>;
    evaluated: number;
    failed: number;
    failReasons: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  const accOf = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { min: Infinity, max: -Infinity, evaluated: 0, failed: 0, failReasons: new Map() };
      acc.set(id, a);
    }
    return a;
  };

  const runnable = order.filter((id) => !reasons.has(id));
  const inputIds = units.filter((u) => u.kind === "input").map((u) => u.id);

  const witnessOf = (assignment: Map<string, number>): Record<string, number> => {
    const w: Record<string, number> = {};
    for (const id of inputIds) {
      const v = assignment.get(id);
      if (v !== undefined) w[nameOf(id)] = v;
    }
    return w;
  };

  const noteFailure = (id: string, reason: string) => {
    const a = accOf(id);
    a.failed += 1;
    a.failReasons.set(reason, (a.failReasons.get(reason) ?? 0) + 1);
  };

  const runCombo = (assignment: Map<string, number>) => {
    const values = new Map<string, number>();
    const failedThisCombo = new Set<string>();
    for (const id of runnable) {
      const u = unitById.get(id)!;
      if (u.kind === "input") {
        const v = assignment.get(id);
        if (v === undefined) {
          failedThisCombo.add(id);
          noteFailure(id, "输入缺少取值");
        } else {
          values.set(id, v);
          const a = accOf(id);
          a.evaluated += 1;
          if (v < a.min) { a.min = v; a.minW = witnessOf(assignment); }
          if (v > a.max) { a.max = v; a.maxW = witnessOf(assignment); }
        }
        continue;
      }
      const failedDep = (graph.deps.get(id) ?? []).find((d) => failedThisCombo.has(d));
      if (failedDep) {
        failedThisCombo.add(id);
        noteFailure(id, `上游单元 "${nameOf(failedDep)}" 求值失败`);
        continue;
      }
      try {
        const v = evaluate(u.expression ?? "", (name) => {
          const t = graph.byName.get(name);
          if (!t) throw new Error(`引用了不存在的单元 "${name}"`);
          const val = values.get(t.id);
          if (val === undefined) throw new Error(`上游单元 "${name}" 尚未就绪`);
          return val;
        });
        values.set(id, v);
        const a = accOf(id);
        a.evaluated += 1;
        if (v < a.min) { a.min = v; a.minW = witnessOf(assignment); }
        if (v > a.max) { a.max = v; a.maxW = witnessOf(assignment); }
      } catch (e) {
        failedThisCombo.add(id);
        noteFailure(id, e instanceof Error ? e.message : String(e));
      }
    }
  };

  // 笛卡尔积枚举（联合组按行整体出现），超过上限即截断。
  const assignment = new Map<string, number>();
  let count = 0;
  let feasibleCombos = 0;
  let infeasibleCombos = 0;
  const walk = (si: number): boolean => {
    if (count >= MAX_COMBOS) return false;
    if (si === sources.length) {
      count += 1;
      // 联合约束过滤：只接受同时满足线性关系与分段条件的组合，
      // 被过滤的组合绝不参与边界与见证，避免拼出违反约束的伪边界。
      if (comboFeasible(assignment)) {
        feasibleCombos += 1;
        runCombo(assignment);
      } else {
        infeasibleCombos += 1;
      }
      return true;
    }
    const s = sources[si];
    for (const row of s.rows) {
      for (let i = 0; i < s.unitIds.length; i++) assignment.set(s.unitIds[i], row[i]);
      if (!walk(si + 1)) return false;
    }
    return true;
  };
  walk(0);

  // 约束不可行：枚举到的组合全部被线性关系/分段条件排除，任何边界都不可证实。
  const hasJointFilters = relationFilters.length + piecewiseFilters.length > 0;
  if (hasJointFilters && count > 0 && feasibleCombos === 0) {
    for (const u of units) {
      if (!reasons.has(u.id)) {
        reasons.set(u.id, "联合约束无可行组合：线性关系/分段条件排除了全部输入取值，边界无法证实");
      }
    }
  }

  const ranges: Record<string, UnitRange> = {};
  for (const u of units) {
    const reason = reasons.get(u.id);
    if (reason) {
      ranges[u.id] = { unitId: u.id, status: "indeterminate", evaluated: 0, failed: 0, reason };
      continue;
    }
    const a = acc.get(u.id);
    if (!a || a.evaluated === 0) {
      const top = a && a.failReasons.size > 0
        ? [...a.failReasons.entries()].sort((x, y) => y[1] - x[1])[0][0]
        : "没有可求值的组合";
      ranges[u.id] = {
        unitId: u.id,
        status: "indeterminate",
        evaluated: 0,
        failed: a?.failed ?? 0,
        reason: `全部组合均无法求值：${top}`,
        failureReasons: a ? [...a.failReasons.keys()] : [],
      };
      continue;
    }
    ranges[u.id] = {
      unitId: u.id,
      status: intervalAffected.has(u.id) || truncated ? "possible" : "proven",
      min: a.min,
      max: a.max,
      minWitness: a.minW,
      maxWitness: a.maxW,
      evaluated: a.evaluated,
      failed: a.failed,
      failureReasons: a.failReasons.size > 0 ? [...a.failReasons.keys()] : undefined,
    };
  }

  return { ranges, totalCombos, truncated, feasibleCombos, infeasibleCombos };
}

/** 生成一份完整报告（含当时的约束与公式版本快照），可直接保存。 */
export function buildRangeReport(
  exp: Experiment,
  scenarioId: string,
  target: "accepted" | "pending" = "accepted",
  name?: string,
): RangeReport {
  const sc = exp.scenarios[scenarioId];
  const { ranges, totalCombos, truncated, feasibleCombos } = computeScenarioRanges(exp, scenarioId, target);
  const formulaVersions: Record<string, number> = {};
  for (const u of exp.units) {
    if (u.kind === "formula") formulaVersions[u.id] = scenarioFormulaVersion(exp, sc, u.id, target);
  }
  return {
    id: uid("rp"),
    name: name?.trim() || `${sc.name} · ${target === "pending" ? "预览" : "基线"}范围报告`,
    createdAt: Date.now(),
    scenarioId,
    scenarioName: sc.name,
    target,
    formulaVersions,
    inputConstraints: structuredClone(sc.inputConstraints ?? {}),
    jointGroups: structuredClone(sc.jointGroups ?? []),
    linearRelations: structuredClone(sc.linearRelations ?? []),
    piecewiseConditions: structuredClone(sc.piecewiseConditions ?? []),
    params: { ...sc.params },
    unitNames: Object.fromEntries(exp.units.map((u) => [u.id, u.name])),
    ranges,
    totalCombos,
    truncated,
    feasibleCombos,
  };
}

export type Attribution = "参数不确定性" | "公式修订" | "参数与公式兼有" | "定义一致";

export interface UnitComparison {
  unitId: string;
  name: string;
  attribution: Attribution;
  a?: UnitRange;
  b?: UnitRange;
  /** 范围是否重叠（两边都有数值范围时）。 */
  overlap?: boolean;
  detail: string;
}

/** 某输入在情景下的约束签名：参数文本 + 输入约束 + 含该输入的联合观测行。 */
function inputSignature(exp: Experiment, sc: Scenario, unitId: string): string {
  const groups = (sc.jointGroups ?? []).filter((g) => g.unitIds.includes(unitId));
  return JSON.stringify({
    p: effectiveInputText(exp, sc, unitId),
    c: sc.inputConstraints?.[unitId] ?? null,
    g: groups.map((g) => ({ u: g.unitIds, r: g.rows })),
    lr: sc.linearRelations ?? [],
    pw: sc.piecewiseConditions ?? [],
  });
}

/**
 * 比较两个情景的公式单元范围：差异归因于参数不确定性还是公式修订，
 * 并给出范围重叠情况，而不是只比较两个中点。
 */
export function compareScenarios(exp: Experiment, scenarioAId: string, scenarioBId: string): UnitComparison[] {
  const scA = exp.scenarios[scenarioAId];
  const scB = exp.scenarios[scenarioBId];
  if (!scA || !scB) return [];
  const graph = buildGraph(exp.units);
  const rangesA = computeScenarioRanges(exp, scenarioAId, "accepted").ranges;
  const rangesB = computeScenarioRanges(exp, scenarioBId, "accepted").ranges;

  const ancestorsOf = (unitId: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(graph.deps.get(unitId) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const d of graph.deps.get(id) ?? []) stack.push(d);
    }
    return seen;
  };

  const fmt = (r?: UnitRange): string => {
    if (!r) return "无结果";
    if (r.status === "indeterminate") return `无法判断（${r.reason ?? "未知原因"}）`;
    const label = r.status === "proven" ? "已证实" : "可能";
    return `[${r.min}, ${r.max}]（${label}）`;
  };

  const comparisons: UnitComparison[] = [];
  for (const u of exp.units) {
    if (u.kind !== "formula") continue;
    const ancestors = ancestorsOf(u.id);
    const formulaIds = [u.id, ...ancestors].filter((id) => exp.units.find((x) => x.id === id)?.kind === "formula");
    const inputIds = [...ancestors].filter((id) => exp.units.find((x) => x.id === id)?.kind === "input");

    const formulasDiffer = formulaIds.some(
      (id) => scenarioFormulaVersion(exp, scA, id, "accepted") !== scenarioFormulaVersion(exp, scB, id, "accepted"),
    );
    const paramsDiffer = inputIds.some((id) => inputSignature(exp, scA, id) !== inputSignature(exp, scB, id));

    const attribution: Attribution = formulasDiffer && paramsDiffer
      ? "参数与公式兼有"
      : formulasDiffer
        ? "公式修订"
        : paramsDiffer
          ? "参数不确定性"
          : "定义一致";

    const a = rangesA[u.id];
    const b = rangesB[u.id];
    let overlap: boolean | undefined;
    if (a?.min !== undefined && a?.max !== undefined && b?.min !== undefined && b?.max !== undefined) {
      overlap = Math.max(a.min, b.min) <= Math.min(a.max, b.max);
    }
    const rangePart = overlap === undefined
      ? "至少一侧无法判断，不能比较范围"
      : overlap
        ? "范围有重叠"
        : "范围不重叠";
    comparisons.push({
      unitId: u.id,
      name: u.name,
      attribution,
      a,
      b,
      overlap,
      detail: `${scA.name} ${fmt(a)}；${scB.name} ${fmt(b)}；${rangePart}。差异来源：${attribution}。`,
    });
  }
  return comparisons;
}
