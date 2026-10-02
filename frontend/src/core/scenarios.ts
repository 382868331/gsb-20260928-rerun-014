import type { CachedResult, ComputeUnit, Experiment, FormulaRevision, Scenario, UnitResult } from "./types";
import { affectedDownstream, buildGraph, runGraph, type RunOutcome } from "./engine";

/** 取公式某一已发布版本；历史缺失时用当前表达式补位（兼容旧持久化数据）。 */
export function formulaAt(unit: ComputeUnit, version: number): FormulaRevision {
  const found = unit.revisions?.find((r) => r.version === version);
  return found ?? { version, expression: unit.expression ?? "" };
}

/**
 * 情景物化后的单元：
 * - target "accepted"：input 用情景参数覆盖；formula 用该情景已接受版本的表达式。
 *   因此未接受改版的情景，参数重算/重开后仍按旧公式出结果。
 * - target "pending"：formula 一律用全局最新表达式，用于生成预览（预览绝不回写正式结果）。
 */
export function effectiveUnits(exp: Experiment, sc: Scenario, target: "accepted" | "pending" = "accepted"): ComputeUnit[] {
  return exp.units.map((u) => {
    if (u.kind === "input") {
      return Object.prototype.hasOwnProperty.call(sc.params, u.id)
        ? { ...u, value: sc.params[u.id] }
        : { ...u };
    }
    const acceptedVersion = sc.acceptedFormulaVersions[u.id] ?? u.version;
    if (target === "pending" && acceptedVersion < u.version) {
      // 该情景尚未接受的公式在预览中用最新版；已接受的仍用自己的基线版本。
      return { ...u };
    }
    const rev = formulaAt(u, acceptedVersion);
    return { ...u, version: rev.version, expression: rev.expression };
  });
}

/** 情景中公式已接受但晚于/异于当前发布版时不做处理；返回该情景当前生效（已接受）的公式单元。 */
export function acceptedUnit(exp: Experiment, sc: Scenario, unitId: string): ComputeUnit | undefined {
  const unit = exp.units.find((u) => u.id === unitId);
  if (!unit || unit.kind !== "formula") return unit;
  const rev = formulaAt(unit, sc.acceptedFormulaVersions[unitId] ?? unit.version);
  return { ...unit, version: rev.version, expression: rev.expression };
}

/**
 * 结果内容键：input 看输入文本；formula 看表达式版本 + 各上游结果键。
 * 同样的定义与上游只产生同一条记录，天然跨情景共享；定义/参数变了键必然变，
 * 因此旧成功记录不可能被误接到新输入。
 */
export function resultKey(unit: ComputeUnit, depIds: string[], keys: Record<string, string>): string {
  if (unit.kind === "input") return `in|${unit.id}|${unit.value ?? ""}`;
  const depPart = depIds.map((d) => `${d}=${keys[d] ?? "?"}`).join(";");
  return `fo|${unit.id}|v${unit.version}|${unit.expression ?? ""}|${depPart}`;
}

function attach(store: Record<string, CachedResult>, key: string, result: UnitResult, scenarioId: string) {
  const existing = store[key];
  if (existing) {
    if (!existing.refIds.includes(scenarioId)) existing.refIds.push(scenarioId);
  } else {
    store[key] = { key, result: { ...result }, refIds: [scenarioId] };
  }
}

function release(store: Record<string, CachedResult>, key: string | undefined, scenarioId: string) {
  if (!key) return;
  const rec = store[key];
  if (!rec) return;
  rec.refIds = rec.refIds.filter((id) => id !== scenarioId);
  if (rec.refIds.length === 0) delete store[key];
}

export interface ScenarioRun {
  results: Record<string, UnitResult>;
  keys: Record<string, string>;
  order: string[];
  cycleUnitIds: string[];
}

/** 运行一个情景，并把结果写入实验级内容寻址结果仓（按 target 写入正式区或预览区）。 */
export function runScenario(
  exp: Experiment,
  scenarioId: string,
  target: "accepted" | "pending",
  changedInputIds?: string[],
): ScenarioRun {
  const sc = exp.scenarios[scenarioId];
  const units = effectiveUnits(exp, sc, target);
  const graph = buildGraph(units);
  // 预览是在情景自己的已接受基线上推演新版本：上游沿用基线结果，受影响公式才重算，
  // 得到的是“相对于该情景自己的基线”的差异，而不是与全局最新值比较。
  const prev = sc.results;
  const outcome: RunOutcome = runGraph(units, changedInputIds, prev);

  const idToUnit = new Map(units.map((u) => [u.id, u]));
  const keys: Record<string, string> = target === "accepted" ? { ...sc.resultKeys } : {};
  const storedKeys: Record<string, string> = {};
  const results: Record<string, UnitResult> = {};
  const ordered = [...outcome.order, ...outcome.cycleIds, ...outcome.blockedIds];

  if (target === "accepted") {
    // 释放本次重算单元的旧引用；沿用单元保留原键。
    for (const id of outcome.executed) release(exp.resultStore, sc.resultKeys[id], scenarioId);
  }

  for (const id of ordered) {
    const r = outcome.results[id];
    if (!r) continue;
    results[id] = r;
    if (target === "accepted" && !outcome.executed.includes(id) && sc.resultKeys[id]) {
      keys[id] = sc.resultKeys[id];
      storedKeys[id] = sc.resultKeys[id];
      attach(exp.resultStore, keys[id], r, scenarioId);
      continue;
    }
    const key = resultKey(idToUnit.get(id)!, graph.deps.get(id) ?? [], keys);
    keys[id] = key;
    const storedKey = target === "pending" ? toPendingKey(key) : key;
    storedKeys[id] = storedKey;
    attach(exp.resultStore, storedKey, r, scenarioId);
  }

  return {
    results,
    keys: storedKeys,
    order: outcome.order,
    cycleUnitIds: outcome.cycle ?? [],
  };
}

/**
 * 预览在情景自己的已接受基线上推演：把每个“晚于该情景基线”的公式视为编辑点，
 * 其结果（含被新公式波及的下游）即为待接受预览；未改版公式继续沿用基线。
 * 预览只写 pending 区，绝不触碰该情景的正式结果。
 */
export function refreshPending(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  // 先解除上一轮暂存引用。
  for (const id of Object.keys(sc.pending)) release(exp.resultStore, sc.pendingKeys[id], scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};

  const changedIds = pendingUnitIds(exp, sc);
  if (changedIds.length === 0) return;

  const units = effectiveUnits(exp, sc, "pending");
  const graph = buildGraph(units);
  const affected = affectedDownstream(changedIds, graph);
  const run = runScenario(exp, scenarioId, "pending", changedIds);
  for (const id of affected) {
    if (!run.results[id]) continue;
    sc.pending[id] = run.results[id];
    sc.pendingKeys[id] = run.keys[id];
  }
}

/**
 * 接受整个情景的待处理改版：在新公式版本上做一次完整正式运行，结果仓按内容自动共享；
 * 不同版本的内容键不同，成功记录绝不会跨版本混接。旧正式结果与 pending 暂存均解除引用。
 */
export function acceptPending(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  if (pendingUnitIds(exp, sc).length === 0) return;
  for (const id of Object.keys(sc.pending)) release(exp.resultStore, sc.pendingKeys[id], scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};
  // 正式视图切到最新版本后，旧公式版本对应的 revision 全部失配，全量重算最稳妥。
  sc.acceptedFormulaVersions = {};
  for (const u of exp.units) if (u.kind === "formula") sc.acceptedFormulaVersions[u.id] = u.version;
  const allIds = exp.units.map((u) => u.id);
  const run = runScenario(exp, scenarioId, "accepted", allIds);
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  sc.cycleUnitIds = run.cycleUnitIds;
}

/** 放弃待处理预览：只解除暂存记录引用，已接受结果不受影响。 */
export function discardPending(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  for (const id of Object.keys(sc.pending)) release(exp.resultStore, sc.pendingKeys[id], scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};
}

/** 生成预览结果的暂存键。 */
export function toPendingKey(key: string): string {
  return `pn:${key}`;
}

/** 删除情景：只解除引用；其他情景沿用的成功/错误记录保留。 */
export function detachScenario(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  if (!sc) return;
  for (const key of Object.values(sc.resultKeys)) release(exp.resultStore, key, scenarioId);
  for (const key of Object.values(sc.pendingKeys)) release(exp.resultStore, key, scenarioId);
}

/** 某公式单元在情景中是否有尚未接受的改版。 */
export function isUnitPending(exp: Experiment, sc: Scenario, unitId: string): boolean {
  const unit = exp.units.find((u) => u.id === unitId);
  if (!unit || unit.kind !== "formula") return false;
  return (sc.acceptedFormulaVersions[unitId] ?? unit.version) < unit.version;
}

/** 情景中存在待处理改版的公式单元。 */
export function pendingUnitIds(exp: Experiment, sc: Scenario): string[] {
  return exp.units.filter((u) => isUnitPending(exp, sc, u.id)).map((u) => u.id);
}
