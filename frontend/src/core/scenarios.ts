import type { CachedResult, ComputeUnit, Experiment, Scenario, UnitResult } from "./types";
import { affectedDownstream, buildGraph, runGraph, type RunOutcome } from "./engine";

export function scenarioFormulaVersion(
  exp: Experiment,
  sc: Scenario,
  unitId: string,
  target: "accepted" | "pending" = "accepted",
): number {
  if (target === "pending" && sc.pendingFormulaVersions?.[unitId] !== undefined) {
    return sc.pendingFormulaVersions![unitId];
  }
  const current = exp.units.find((u) => u.id === unitId)?.version;
  return sc.acceptedFormulaVersions[unitId] ?? current ?? 1;
}

export function historicalExpression(exp: Experiment, unitId: string, version: number): string {
  const historical = exp.formulaHistory?.[unitId]?.[version];
  if (historical !== undefined) return historical;
  const current = exp.units.find((u) => u.id === unitId);
  return current && current.version === version ? current.expression ?? "" : current?.expression ?? "";
}

/** 情景物化后的单元：input 用参数覆盖，formula 严格使用该情景在该视图下已接受/预览的版本。 */
export function effectiveUnits(
  exp: Experiment,
  sc: Scenario,
  target: "accepted" | "pending" = "accepted",
  versionOverrides: Record<string, number> = {},
): ComputeUnit[] {
  return exp.units.map((u) => {
    if (u.kind === "input") {
      return Object.prototype.hasOwnProperty.call(sc.params, u.id)
        ? { ...u, value: sc.params[u.id] }
        : { ...u };
    }
    const version = versionOverrides[u.id] ?? scenarioFormulaVersion(exp, sc, u.id, target);
    return { ...u, version, expression: historicalExpression(exp, u.id, version) };
  });
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
  pendingIds: string[] = target === "pending"
    ? [
        ...Object.keys(exp.scenarios[scenarioId].pending),
        ...(changedInputIds ?? []).filter((id) => exp.units.some((u) => u.id === id && u.kind === "formula")),
      ]
    : [],
): ScenarioRun {
  const sc = exp.scenarios[scenarioId];
  const pendingSet = new Set(pendingIds);
  const pendingVersionOverrides = Object.fromEntries(
    pendingIds.map((id) => [id, sc.pendingFormulaVersions?.[id] ?? exp.units.find((u) => u.id === id)?.version ?? 1]),
  );
  const units = effectiveUnits(exp, sc, target, target === "pending" ? pendingVersionOverrides : {});
  const graph = buildGraph(units);
  const prev = target === "accepted"
    ? sc.results
    : Object.fromEntries(Object.entries(sc.results).filter(([id]) => !pendingSet.has(id)));
  const outcome: RunOutcome = runGraph(units, changedInputIds, prev);

  const idToUnit = new Map(units.map((u) => [u.id, u]));
  const keys: Record<string, string> = target === "accepted"
    ? { ...sc.resultKeys }
    : Object.fromEntries(Object.entries(sc.resultKeys).filter(([id]) => !pendingSet.has(id)));
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
    if (!outcome.executed.includes(id) && (target === "accepted" ? sc.resultKeys[id] : !pendingSet.has(id) && sc.resultKeys[id])) {
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
  for (const [id, version] of Object.entries(sc.pendingFormulaVersions ?? {})) {
    sc.acceptedFormulaVersions[id] = version;
  }
  for (const id of pendingIds) {
    sc.acceptedFormulaVersions[id] = sc.pendingFormulaVersions?.[id] ?? exp.units.find((u) => u.id === id)?.version ?? sc.acceptedFormulaVersions[id] ?? 1;
  }
  const run = runScenario(exp, scenarioId, "accepted", pendingIds);
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  sc.cycleUnitIds = run.cycleUnitIds;
  sc.pending = {};
  sc.pendingKeys = {};
  sc.pendingFormulaVersions = {};
  sc.pendingExecutionOrder = [];
  sc.pendingCycleUnitIds = [];
}

/** 放弃待处理预览：只解除暂存记录引用，已接受结果不受影响。 */
export function discardPending(exp: Experiment, scenarioId: string): void {
  const sc = exp.scenarios[scenarioId];
  for (const id of Object.keys(sc.pending)) release(exp.resultStore, sc.pendingKeys[id], scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};
  sc.pendingFormulaVersions = {};
  sc.pendingExecutionOrder = [];
  sc.pendingCycleUnitIds = [];
}

/** 用共享定义的当前版本替换指定公式及其下游在某情景中的预览，其它未涉及预览保持原版本。 */
export function refreshPendingPreview(
  exp: Experiment,
  scenarioId: string,
  changedFormulaIds: string[] = [],
  changedInputIds: string[] = [],
  discoverOutdated = false,
): void {
  const sc = exp.scenarios[scenarioId];
  const previousPendingVersions = { ...(sc.pendingFormulaVersions ?? {}) };
  for (const key of Object.values(sc.pendingKeys)) release(exp.resultStore, key, scenarioId);
  sc.pending = {};
  sc.pendingKeys = {};
  sc.pendingFormulaVersions ??= {};
  sc.pendingFormulaVersions = {};
  const affectedFromLatest = discoverOutdated
    ? new Set(exp.units.filter((u) => u.kind === "formula").map((u) => u.id))
    : affectedDownstream(changedFormulaIds, buildGraph(exp.units));
  const affectedFormulaIds = new Set(
    exp.units.filter((u) => u.kind === "formula" && affectedFromLatest.has(u.id)).map((u) => u.id),
  );

  for (const id of affectedFormulaIds) {
    const latest = exp.units.find((u) => u.id === id);
    const acceptedVersion = scenarioFormulaVersion(exp, sc, id, "accepted");
    if (latest && acceptedVersion < latest.version) {
      sc.pendingFormulaVersions[id] = latest.version;
    } else {
      delete sc.pendingFormulaVersions[id];
    }
  }

  if (discoverOutdated) {
    for (const u of exp.units) {
      if (u.kind !== "formula") continue;
      const acceptedVersion = scenarioFormulaVersion(exp, sc, u.id, "accepted");
      if (acceptedVersion < u.version) {
        affectedFormulaIds.add(u.id);
        sc.pendingFormulaVersions[u.id] = u.version;
      }
    }
  }

  for (const id of Object.keys(sc.pendingFormulaVersions)) {
    const targetVersion = sc.pendingFormulaVersions[id];
    if (targetVersion !== undefined && targetVersion !== scenarioFormulaVersion(exp, sc, id, "accepted")) {
      affectedFormulaIds.add(id);
    }
  }
  for (const [id, version] of Object.entries(previousPendingVersions)) {
    if (!affectedFormulaIds.has(id) && version !== scenarioFormulaVersion(exp, sc, id, "accepted")) {
      affectedFormulaIds.add(id);
      sc.pendingFormulaVersions[id] = version;
    }
  }

  if (affectedFormulaIds.size === 0) return;
  const pendingIds = [...affectedFormulaIds];
  const run = runScenario(exp, scenarioId, "pending", [...changedInputIds, ...pendingIds], pendingIds);
  for (const [id, key] of Object.entries(run.keys)) {
    if (key.startsWith("pn:") && run.results[id]) {
      sc.pending[id] = run.results[id];
      sc.pendingKeys[id] = key;
    }
  }
  sc.pendingExecutionOrder = run.order;
  sc.pendingCycleUnitIds = run.cycleUnitIds;
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
  return (sc.acceptedFormulaVersions[unitId] ?? unit.version) < unit.version || sc.pending[unitId] !== undefined;
}

/** 情景中存在待处理改版的公式单元。 */
export function pendingUnitIds(exp: Experiment, sc: Scenario): string[] {
  return exp.units.filter((u) => isUnitPending(exp, sc, u.id)).map((u) => u.id);
}
