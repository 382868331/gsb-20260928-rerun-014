import type {
  Experiment,
  InputConstraint,
  JointGroup,
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

/** 输入单元在某情景下的有效确定值（参数覆盖优先，否则共享默认值）。 */
export function effectiveInputText(exp: Experiment, sc: Scenario, unitId: string): string {
  if (Object.prototype.hasOwnProperty.call(sc.params, unitId)) return sc.params[unitId];
  return exp.units.find((u) => u.id === unitId)?.value ?? "";
}

export interface RangeComputation {
  ranges: Record<string, UnitRange>;
  totalCombos: number;
  truncated: boolean;
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
  const walk = (si: number): boolean => {
    if (count >= MAX_COMBOS) return false;
    if (si === sources.length) {
      count += 1;
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

  return { ranges, totalCombos, truncated };
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
    params: { ...sc.params },
    unitNames: Object.fromEntries(exp.units.map((u) => [u.id, u.name])),
    ranges,
    totalCombos,
    truncated,
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
