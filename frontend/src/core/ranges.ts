import { runGraph } from "./engine";
import { effectiveUnits } from "./scenarios";
import type {
  Experiment,
  InputConstraint,
  JointObservation,
  RangeUnknownKind,
  RangeWorld,
  Scenario,
  UnitRange,
} from "./types";

interface ParsedConstraint {
  values: number[];
  finite: boolean;
  invalid?: string;
}

interface InputGroup {
  id: string;
  name: string;
  alternatives: Record<string, number>[];
  exact: boolean;
}

export interface RangeAnalysisOptions {
  maxWorlds?: number;
  formulaIds?: string[];
}

const finiteNumber = (raw: string): number | null => {
  const v = Number(raw.trim());
  return Number.isFinite(v) ? v : null;
};

export function parseConstraint(raw: InputConstraint | undefined, fallback: string): ParsedConstraint {
  const source = raw?.text ?? fallback;
  if (!raw || raw.mode === "point") {
    const v = finiteNumber(raw?.text ?? fallback);
    return v === null ? { values: [], finite: true, invalid: `输入 "${source}" 不是有效数字` } : { values: [v], finite: true };
  }
  if (raw.mode === "finite") {
    const parts = source.split(/[,，\s]+/).filter(Boolean);
    const values: number[] = [];
    for (const part of parts) {
      const v = finiteNumber(part);
      if (v === null) return { values: [], finite: true, invalid: `候选值 "${part}" 不是有效数字` };
      values.push(v);
    }
    if (values.length === 0) return { values: [], finite: true, invalid: "候选值为空" };
    return { values: [...new Set(values)], finite: true };
  }
  const match = source.match(/^\s*([^.\s]+)\s*(?:\.\.|\-|~|至|到)\s*([^.\s]+)\s*$/);
  if (!match) return { values: [], finite: false, invalid: `区间 "${source}" 应写作 最小值..最大值` };
  const min = finiteNumber(match[1]);
  const max = finiteNumber(match[2]);
  if (min === null || max === null) return { values: [], finite: false, invalid: `区间 "${source}" 的端点不是有效数字` };
  if (min > max) return { values: [], finite: false, invalid: `区间 "${source}" 的最小值大于最大值` };
  return { values: [min, max], finite: false };
}

function cartesian(groups: InputGroup[]): Record<string, number>[] {
  let rows: Record<string, number>[] = [{}];
  for (const group of groups) {
    const next: Record<string, number>[] = [];
    for (const left of rows) for (const right of group.alternatives) next.push({ ...left, ...right });
    rows = next;
  }
  return rows;
}

function endpointRows(keys: string[], endpoints: number[][], index = 0): Record<string, number>[] {
  if (index === keys.length) return [{}];
  return endpoints[index].flatMap((v) =>
    endpointRows(keys, endpoints, index + 1).map((row) => ({ ...row, [keys[index]]: v })),
  );
}

export interface ScenarioRangeResult {
  ranges: Record<string, UnitRange>;
  worlds: RangeWorld[];
  status: "proven" | "possible" | "unknown";
  globalReasons: string[];
}

export function analyzeScenarioRanges(
  exp: Experiment,
  sc: Scenario,
  target: "accepted" | "pending" = "accepted",
  options: RangeAnalysisOptions = {},
): ScenarioRangeResult {
  const maxWorlds = options.maxWorlds ?? 256;
  const units = effectiveUnits(exp, sc, target);
  const inputs = units.filter((u) => u.kind === "input");
  const constraints = sc.inputConstraints ?? {};
  const parsed = new Map<string, ParsedConstraint>();
  const fallback = new Map<string, string>();
  for (const input of inputs) {
    const fb = sc.params[input.id] ?? input.value ?? "";
    fallback.set(input.id, fb);
    parsed.set(input.id, parseConstraint(constraints[input.id], fb));
  }

  const globalReasons: string[] = [];
  for (const [id, p] of parsed) if (p.invalid) globalReasons.push(`${nameOf(exp, id)}：${p.invalid}`);

  const uncertain = new Set([...parsed].filter(([, p]) => !p.invalid && (p.values.length > 1 || !p.finite)).map(([id]) => id));
  const observations = sc.jointObservations ?? [];
  const observedKeys = new Set(observations.flatMap((o) => Object.keys(o.values)));
  const unassigned = [...uncertain].filter((id) => !observedKeys.has(id));
  let relationUnknown = false;
  if (unassigned.length > 1) {
    relationUnknown = true;
    globalReasons.push(`${unassigned.map((id) => nameOf(exp, id)).join("、")} 缺少联合关系，不能任意交叉拼值`);
  }
  if (observations.some((o) => Object.keys(o.values).length === 0)) {
    globalReasons.push("存在没有输入值的联合观测");
  }

  const jointAlternatives: Record<string, number>[] = [];
  let jointHasInterval = false;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const keys = Object.keys(obs.values);
    const rows: Record<string, number>[] = [];
    for (const tupleText of [obs.values]) {
      const tuple: Record<string, number> = {};
      const intervalKeys: string[] = [];
      const intervalEndpoints: number[][] = [];
      for (const key of keys) {
        const direct = finiteNumber(tupleText[key] ?? "");
        const constraint = parsed.get(key);
        if (direct !== null) tuple[key] = direct;
        else if (constraint && !constraint.finite && !constraint.invalid) {
          intervalKeys.push(key);
          intervalEndpoints.push(constraint.values);
        }
      }
      if (intervalKeys.length === 0) rows.push(tuple);
      else {
        jointHasInterval = true;
        if (intervalKeys.length > 1) {
          relationUnknown = true;
          globalReasons.push(`${intervalKeys.map((id) => nameOf(exp, id)).join("、")} 在同一观测中都是区间，缺少区间内联动依据`);
        }
        for (const endpoint of endpointRows(intervalKeys, intervalEndpoints)) rows.push({ ...tuple, ...endpoint });
      }
    }
    jointAlternatives.push(...rows);
  }

  const exactGroups: InputGroup[] = [];
  const sampledGroups: InputGroup[] = [];
  if (jointAlternatives.length > 0) {
    const jointGroup: InputGroup = { id: "joint-observations", name: "联合观测", alternatives: jointAlternatives, exact: !jointHasInterval };
    (jointHasInterval ? sampledGroups : exactGroups).push(jointGroup);
  }

  for (const id of unassigned) {
    const p = parsed.get(id)!;
    const group: InputGroup = {
      id,
      name: nameOf(exp, id),
      exact: p.finite,
      alternatives: (p.finite ? p.values : p.values).map((v) => ({ [id]: v })),
    };
    (p.finite ? exactGroups : sampledGroups).push(group);
  }

  const sampled = sampledGroups.length > 0;
  const groups = [...exactGroups, ...sampledGroups];
  let assignments = cartesian(groups);
  if (assignments.length > maxWorlds) {
    assignments = assignments.slice(0, maxWorlds);
    globalReasons.push(`组合数超过 ${maxWorlds}，仅展示前 ${maxWorlds} 个样本`);
  }

  const baseValues = new Map<string, number>();
  for (const input of inputs) {
    const p = parsed.get(input.id)!;
    if (!p.invalid && p.values.length === 1) baseValues.set(input.id, p.values[0]);
  }
  const worlds: RangeWorld[] = assignments.map((values, index) => ({
    label: `样本 ${index + 1}`,
    values: Object.fromEntries([...baseValues, ...Object.entries(values)]),
  }));
  if (worlds.length === 0) worlds.push({ label: "确定输入", values: Object.fromEntries(baseValues) });

  const allFormulaIds = units.filter((u) => u.kind === "formula").map((u) => u.id);
  const formulaIds = options.formulaIds ?? allFormulaIds;
  const collected = new Map<string, { values: number[]; worlds: Map<number, RangeWorld>; kinds: Set<RangeUnknownKind>; reasons: Set<string> }>();
  for (const id of formulaIds) collected.set(id, { values: [], worlds: new Map(), kinds: new Set(), reasons: new Set() });

  for (const world of worlds) {
    const materialized = units.map((u) => (u.kind === "input" ? { ...u, value: String(world.values[u.id] ?? "") } : u));
    const outcome = runGraph(materialized);
    for (const id of formulaIds) {
      const result = outcome.results[id];
      const bucket = collected.get(id)!;
      if (!result) continue;
      if (result.status === "ok" && typeof result.value === "number") {
        bucket.values.push(result.value);
        if (!bucket.worlds.has(result.value)) bucket.worlds.set(result.value, world);
      } else if (result.errorKind === "cycle") {
        bucket.kinds.add("cycle");
        bucket.reasons.add(result.error ?? "检测到引用环");
      } else if (result.errorKind === "eval" && result.error?.includes("零")) {
        bucket.kinds.add("division");
        bucket.reasons.add("部分输入导致除数为零");
      } else if (result.errorKind) {
        bucket.kinds.add(result.errorKind);
        bucket.reasons.add(result.error ?? "计算失败");
      }
    }
  }

  const ranges: Record<string, UnitRange> = {};
  for (const id of formulaIds) {
    const bucket = collected.get(id)!;
    const min = bucket.values.length ? Math.min(...bucket.values) : null;
    const max = bucket.values.length ? Math.max(...bucket.values) : null;
    const kinds = [...bucket.kinds];
    if (relationUnknown) kinds.push("relation");
    const status: UnitRange["status"] = bucket.values.length === 0
      ? "unknown"
      : relationUnknown || sampled || kinds.length > 0
        ? "possible"
        : "proven";
    ranges[id] = {
      unitId: id,
      status,
      min,
      max,
      minWorld: min === null ? undefined : bucket.worlds.get(min),
      maxWorld: max === null ? undefined : bucket.worlds.get(max),
      worldCount: worlds.length,
      unknownKinds: kinds,
      reasons: [...bucket.reasons, ...(relationUnknown ? ["缺少联合关系，边界不能证实"] : [])],
    };
  }

  const hasUnknownFormula = Object.values(ranges).some((r) => r.status === "unknown");
  return {
    ranges,
    worlds,
    status: hasUnknownFormula ? "unknown" : relationUnknown || sampled ? "possible" : "proven",
    globalReasons,
  };
}

function nameOf(exp: Experiment, id: string): string {
  return exp.units.find((u) => u.id === id)?.name ?? id;
}

export function formatWorld(exp: Experiment, world: RangeWorld | undefined): string {
  if (!world) return "缺少依据";
  return Object.entries(world.values).map(([id, value]) => `${nameOf(exp, id)}=${value}`).join(", ");
}

export interface RangeComparison {
  unitId: string;
  accepted: UnitRange;
  pending?: UnitRange;
  formulaRevision: boolean;
  parameterUncertainty: boolean;
}

export interface ScenarioRangeComparisonRow {
  unitId: string;
  left: UnitRange;
  right: UnitRange;
  formulaRevision: boolean;
  parameterDifference: boolean;
  uncertainty: boolean;
}

export function compareScenarioRanges(exp: Experiment, sc: Scenario): RangeComparison[] {
  const accepted = analyzeScenarioRanges(exp, sc, "accepted");
  const pendingIds = new Set([...Object.keys(sc.pending), ...Object.keys(sc.pendingFormulaVersions ?? {})]);
  const pending = analyzeScenarioRanges(exp, sc, "pending", { formulaIds: [...pendingIds] });
  return exp.units.filter((u) => u.kind === "formula").map((unit) => {
    const acceptedVersion = sc.acceptedFormulaVersions[unit.id] ?? unit.version;
    const pendingVersion = sc.pendingFormulaVersions?.[unit.id] ?? unit.version;
    return {
      unitId: unit.id,
      accepted: accepted.ranges[unit.id],
      pending: pending.ranges[unit.id],
      formulaRevision: acceptedVersion !== pendingVersion,
      parameterUncertainty: accepted.status !== "proven" || pending.status !== "proven",
    };
  });
}

export function compareAcceptedScenarios(exp: Experiment, leftId: string, rightId: string): ScenarioRangeComparisonRow[] {
  const leftSc = exp.scenarios[leftId];
  const rightSc = exp.scenarios[rightId];
  if (!leftSc || !rightSc) return [];
  const left = analyzeScenarioRanges(exp, leftSc, "accepted");
  const right = analyzeScenarioRanges(exp, rightSc, "accepted");
  const parameterSignature = (sc: Scenario) => JSON.stringify({
    params: sc.params,
    constraints: sc.inputConstraints ?? {},
    observations: sc.jointObservations ?? [],
  });
  const parameterDifference = parameterSignature(leftSc) !== parameterSignature(rightSc);
  return exp.units.filter((u) => u.kind === "formula").map((unit) => {
    const leftRange = left.ranges[unit.id];
    const rightRange = right.ranges[unit.id];
    const leftVersion = leftSc.acceptedFormulaVersions[unit.id] ?? unit.version;
    const rightVersion = rightSc.acceptedFormulaVersions[unit.id] ?? unit.version;
    return {
      unitId: unit.id,
      left: leftRange,
      right: rightRange,
      formulaRevision: leftVersion !== rightVersion,
      parameterDifference,
      uncertainty: leftRange.status !== "proven" || rightRange.status !== "proven",
    };
  });
}
