import type { CachedResult, ComputeUnit, Experiment, Scenario, UnitResult } from "./types";
import { buildGraph, runGraph, unitRevision, type RunOutcome } from "./engine";

/** 情景物化后的单元：input 用情景参数覆盖，formula 共享定义不变。 */
export function effectiveUnits(exp: Experiment, sc: Scenario): ComputeUnit[] {
  return exp.units.map((u) =>
    u.kind === "input" && Object.prototype.hasOwnProperty.call(sc.params, u.id)
      ? { ...u, value: sc.params[u.id] }
      : { ...u },
  );
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
  const units = effectiveUnits(exp, sc);
  const graph = buildGraph(units);
  const prev = target === "accepted" ? sc.results : {};
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
 * 接受整个情景的待处理改版：在新公式版本上做一次正式运行，结果仓按内容自动共享；
 * 旧正式结果与 pending 暂存均解除引用。部分接受的粒度是“情景”。
 */
export function acceptPending(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  const pendingIds = Object.keys(sc.pending);
  for (const id of pendingIds) release(exp.resultStore, sc.pendingKeys[id], scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};
  const run = runScenario(exp, scenarioId, "accepted", pendingIds);
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  sc.cycleUnitIds = run.cycleUnitIds;
  for (const u of exp.units) if (u.kind === "formula") sc.acceptedFormulaVersions[u.id] = u.version;
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

