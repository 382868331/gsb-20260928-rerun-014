import type {
  Experiment,
  InputConstraint,
  JointGroup,
  RangeReport,
  Scenario,
  UnitRange,
} from "./types";
import type { ConstraintScheme, LinearOp } from "./types";
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

interface ComboSource {
  unitIds: string[];
  rows: number[][];
}

/** 情景当前采用的约束方案（未采用或 id 失效时为 null）。 */
export function adoptedScheme(sc: Scenario): ConstraintScheme | null {
  if (!sc.adoptedSchemeId) return null;
  return (sc.constraintSchemes ?? []).find((s) => s.id === sc.adoptedSchemeId) ?? null;
}

const EQ_EPS = 1e-9;

function compareOp(lhs: number, op: LinearOp, rhs: number): boolean {
  if (op === "<=") return lhs <= rhs + EQ_EPS;
  if (op === ">=") return lhs >= rhs - EQ_EPS;
  return Math.abs(lhs - rhs) <= EQ_EPS;
}

/** 校验约束方案：引用的输入必须存在且为输入单元，系数/右端/取值必须为有效数字。 */
export function validateConstraintScheme(
  scheme: ConstraintScheme,
  unitById: Map<string, { kind: string; name: string }>,
): string[] {
  const errors: string[] = [];
  const refName = (id: string) => unitById.get(id)?.name ?? id;
  const checkUnit = (id: string): string | null => {
    const u = unitById.get(id);
    if (!u) return `引用了不存在的单元 ${id}`;
    if (u.kind !== "input") return `"${u.name}" 不是输入单元，不能参与约束`;
    return null;
  };
  for (const rel of scheme.linear) {
    if (rel.terms.length === 0) errors.push(`线性关系 ${rel.id} 没有任何项`);
    if (!Number.isFinite(rel.rhs)) errors.push(`线性关系 ${rel.id} 的右端不是有效数字`);
    for (const t of rel.terms) {
      const bad = checkUnit(t.unitId);
      if (bad) errors.push(`线性关系 ${rel.id} ${bad}`);
      else if (!Number.isFinite(t.coef)) errors.push(`线性关系 ${rel.id} 中 "${refName(t.unitId)}" 的系数不是有效数字`);
    }
  }
  for (const pw of scheme.piecewise) {
    const bad = checkUnit(pw.unitId);
    if (bad) errors.push(`分段取值 ${bad}`);
    if (pw.clauses.length === 0) errors.push(`分段取值（${refName(pw.unitId)}）没有任何分段`);
    for (const clause of pw.clauses) {
      const values = (clause.values ?? []).filter((v) => Number.isFinite(v));
      if (values.length === 0) errors.push(`分段取值（${refName(pw.unitId)}）存在空取值段`);
      if (clause.when) {
        const badWhen = checkUnit(clause.when.unitId);
        if (badWhen) errors.push(`分段取值条件 ${badWhen}`);
        else if (!Number.isFinite(clause.when.value)) errors.push("分段取值条件的比较值不是有效数字");
      }
    }
  }
  return errors;
}

/** 判断一个完整输入组合是否满足约束方案（线性关系 + 分段取值）。 */
export function comboSatisfiesScheme(assignment: Map<string, number>, scheme: ConstraintScheme): boolean {
  for (const rel of scheme.linear) {
    let sum = 0;
    for (const t of rel.terms) {
      const v = assignment.get(t.unitId);
      if (v === undefined) return false;
      sum += t.coef * v;
    }
    if (!compareOp(sum, rel.op, rel.rhs)) return false;
  }
  for (const pw of scheme.piecewise) {
    const v = assignment.get(pw.unitId);
    if (v === undefined) return false;
    const clause = pw.clauses.find((c) => {
      if (!c.when) return true;
      const other = assignment.get(c.when.unitId);
      return other !== undefined && compareOp(other, c.when.op, c.when.value);
    });
    if (!clause) return false;
    if (!clause.values.some((x) => Math.abs(x - v) <= EQ_EPS)) return false;
  }
  return true;
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

/** 输入单元在某情景下的有效确定值（参数覆盖优先，否则共享默认值）。 */
export function effectiveInputText(exp: Experiment, sc: Scenario, unitId: string): string {
  if (Object.prototype.hasOwnProperty.call(sc.params, unitId)) return sc.params[unitId];
  return exp.units.find((u) => u.id === unitId)?.value ?? "";
}

export interface RangeComputation {
  ranges: Record<string, UnitRange>;
  totalCombos: number;
  truncated: boolean;
  /** 被采用约束方案排除的组合数（未采用方案时为 0）。 */
  infeasible: number;
  /** 本次计算采用的约束方案名（未采用为 null）。 */
  schemeName: string | null;
}

export interface RangeOptions {
  /** 显式指定约束方案（null 表示强制不采用）；缺省按情景已采用的方案。 */
  scheme?: ConstraintScheme | null;
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
  options: RangeOptions = {},
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

  // 约束方案：显式指定优先，否则用情景已采用的方案。
  const scheme = options.scheme !== undefined ? options.scheme : adoptedScheme(sc);
  const schemeErrors = scheme ? validateConstraintScheme(scheme, unitById) : [];
  if (scheme && schemeErrors.length > 0) {
    const ranges: Record<string, UnitRange> = {};
    for (const u of units) {
      ranges[u.id] = {
        unitId: u.id,
        status: "indeterminate",
        evaluated: 0,
        failed: 0,
        reason: `约束方案 "${scheme.name}" 无效：${schemeErrors.join("；")}`,
      };
    }
    return { ranges, totalCombos: 0, truncated: false, infeasible: 0, schemeName: scheme.name };
  }

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
  let infeasible = 0;
  const walk = (si: number): boolean => {
    if (count >= MAX_COMBOS) return false;
    if (si === sources.length) {
      count += 1;
      if (scheme && !comboSatisfiesScheme(assignment, scheme)) {
        infeasible += 1;
        return true;
      }
      runCombo(assignment);
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

  // 采用了约束方案但没有任何可行组合：全部单元无法判断，不能给出伪边界。
  if (scheme && count > 0 && count === infeasible) {
    for (const u of units) {
      if (!reasons.has(u.id)) {
        reasons.set(u.id, `约束方案 "${scheme.name}" 下无可行组合（${infeasible} 个组合均被排除）`);
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

  return { ranges, totalCombos, truncated, infeasible, schemeName: scheme?.name ?? null };
}

/** 生成一份完整报告（含当时的约束与公式版本快照），可直接保存。 */
export function buildRangeReport(
  exp: Experiment,
  scenarioId: string,
  target: "accepted" | "pending" = "accepted",
  name?: string,
): RangeReport {
  const sc = exp.scenarios[scenarioId];
  const { ranges, totalCombos, truncated } = computeScenarioRanges(exp, scenarioId, target);
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
    adoptedScheme: adoptedScheme(sc) ? structuredClone(adoptedScheme(sc)) : null,
    params: { ...sc.params },
    unitNames: Object.fromEntries(exp.units.map((u) => [u.id, u.name])),
    ranges,
    totalCombos,
    truncated,
  };
}

export type Attribution = "参数不确定性" | "公式修订" | "参数与公式兼有" | "定义一致";

export interface SchemeComparison {
  /** null 表示“不采用任何方案”的对照。 */
  schemeId: string | null;
  name: string;
  adopted: boolean;
  result: RangeComputation;
}

/**
 * 比较同一情景下的各约束方案：逐方案独立重算范围（含“不采用方案”对照），
 * 便于看清每份方案对边界的收紧效果，再明确采用其中一份。
 */
export function compareConstraintSchemes(
  exp: Experiment,
  scenarioId: string,
  target: "accepted" | "pending" = "accepted",
): SchemeComparison[] {
  const sc = exp.scenarios[scenarioId];
  if (!sc) return [];
  const out: SchemeComparison[] = [{
    schemeId: null,
    name: "不采用方案",
    adopted: !sc.adoptedSchemeId,
    result: computeScenarioRanges(exp, scenarioId, target, { scheme: null }),
  }];
  for (const s of sc.constraintSchemes ?? []) {
    out.push({
      schemeId: s.id,
      name: s.name,
      adopted: sc.adoptedSchemeId === s.id,
      result: computeScenarioRanges(exp, scenarioId, target, { scheme: s }),
    });
  }
  return out;
}

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
  });
}

/** 情景级约束签名：采用的约束方案整体参与，方案不同即视为参数不确定性不同。 */
function schemeSignature(sc: Scenario): string {
  return JSON.stringify(adoptedScheme(sc) ?? null);
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
    const constraintsDiffer = paramsDiffer || schemeSignature(scA) !== schemeSignature(scB);

    const attribution: Attribution = formulasDiffer && constraintsDiffer
      ? "参数与公式兼有"
      : formulasDiffer
        ? "公式修订"
        : constraintsDiffer
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
