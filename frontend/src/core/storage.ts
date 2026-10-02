import type { ComputeUnit, Experiment, NotebookState, Scenario } from "./types";
import { runScenario } from "./scenarios";

export const STORAGE_KEY = "sci-compute-notebook:v2";
const LEGACY_KEY = "sci-compute-notebook:v1";

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 新建情景：可携带参数覆盖与已接受公式版本（派生时继承父情景当时的版本）。 */
export function makeScenario(
  name: string,
  params: Record<string, string>,
  parentId: string | null = null,
  createdAt = Date.now(),
  acceptedFormulaVersions: Record<string, number> = {},
): Scenario {
  return {
    id: uid("sc"),
    name,
    parentId,
    createdAt,
    params,
    results: {},
    resultKeys: {},
    pending: {},
    pendingKeys: {},
    acceptedFormulaVersions: { ...acceptedFormulaVersions },
    executionOrder: [],
    cycleUnitIds: [],
  };
}

/** 深拷贝实验，确保快照/支线与原实验完全隔离，后续改动互不影响。 */
export function cloneExperiment(exp: Experiment, overrides: Partial<Experiment>): Experiment {
  const clone: Experiment = {
    ...structuredClone(exp),
    ...overrides,
    units: overrides.units ? structuredClone(overrides.units) : structuredClone(exp.units),
    scenarios: {},
    scenarioOrder: overrides.scenarioOrder ? [...overrides.scenarioOrder] : [...exp.scenarioOrder],
    resultStore: {},
  };
  const sourceScenarios = overrides.scenarios ?? exp.scenarios;
  for (const [id, sc] of Object.entries(sourceScenarios)) {
    clone.scenarios[id] = structuredClone(sc);
  }
  clone.activeScenarioId = overrides.activeScenarioId ?? exp.activeScenarioId;
  return clone;
}

export function emptyNotebook(): NotebookState {
  return { experiments: {}, rootId: null, activeId: null };
}

/** 克隆/支线后重建结果仓：按各情景当前持有的内容键重新装载，引用关系重新计数。 */
export function rebuildResultStore(exp: Experiment): void {
  exp.resultStore = {};
  for (const sc of Object.values(exp.scenarios)) {
    for (const [uid2, key] of Object.entries(sc.resultKeys)) {
      const result = sc.results[uid2];
      if (!result) continue;
      const rec = exp.resultStore[key];
      if (rec) {
        if (!rec.refIds.includes(sc.id)) rec.refIds.push(sc.id);
      } else {
        exp.resultStore[key] = { key, result: { ...result }, refIds: [sc.id] };
      }
    }
    for (const [uid2, key] of Object.entries(sc.pendingKeys)) {
      const result = sc.pending[uid2];
      if (!result) continue;
      const rec = exp.resultStore[key];
      if (rec) {
        if (!rec.refIds.includes(sc.id)) rec.refIds.push(sc.id);
      } else {
        exp.resultStore[key] = { key, result: { ...result }, refIds: [sc.id] };
      }
    }
  }
}

/** 给实验确保有默认情景并完成一次运行（新建实验或旧数据迁移时使用）。 */
export function ensureDefaultScenario(exp: Experiment): string {
  if (exp.scenarioOrder.length === 0 || Object.keys(exp.scenarios).length === 0) {
    const sc = makeScenario("默认情景", {});
    exp.scenarios[sc.id] = sc;
    exp.scenarioOrder = [sc.id];
    exp.activeScenarioId = sc.id;
  }
  if (!exp.activeScenarioId || !exp.scenarios[exp.activeScenarioId]) {
    exp.activeScenarioId = exp.scenarioOrder[0];
  }
  const sc = exp.scenarios[exp.activeScenarioId!];
  if (Object.keys(sc.results).length === 0 && exp.units.length > 0) {
    for (const u of exp.units) {
      if (u.kind === "formula" && sc.acceptedFormulaVersions[u.id] === undefined) {
        sc.acceptedFormulaVersions[u.id] = u.version;
      }
    }
    const run = runScenario(exp, sc.id, "accepted");
    sc.results = run.results;
    sc.resultKeys = run.keys;
    sc.executionOrder = run.order;
    sc.cycleUnitIds = run.cycleUnitIds;
  }
  return exp.activeScenarioId!;
}

/**
 * 规范化持久化实验：为公式补齐版本历史。
 * 旧数据（含存在 bug 的版本，只有版本号没有表达式历史）无法还原当时表达式时，
 * 用当前表达式回填，但版本号不变——内容键仍按各自版本隔离，成功记录不会跨版本混接。
 */
export function normalizeExperiment(exp: Experiment): void {
  for (const unit of exp.units) {
    if (unit.kind !== "formula") continue;
    if (!Array.isArray(unit.revisions)) unit.revisions = [];
    const byVersion = new Map(unit.revisions.map((r) => [r.version, r]));
    for (const sc of Object.values(exp.scenarios)) {
      const pinned = sc.acceptedFormulaVersions[unit.id];
      if (pinned !== undefined && !byVersion.has(pinned)) {
        byVersion.set(pinned, { version: pinned, expression: unit.expression ?? "" });
      }
    }
    if (!byVersion.has(unit.version)) {
      byVersion.set(unit.version, { version: unit.version, expression: unit.expression ?? "" });
    }
    unit.revisions = [...byVersion.values()].sort((a, b) => a.version - b.version);
  }
}

/** v1（单情景）数据迁移为 v2：共享定义 + 默认情景，旧结果按内容重新入仓。 */
function migrateV1(raw: unknown): NotebookState | null {
  try {
    const state = raw as NotebookState & {
      experiments: Record<string, Experiment & { results?: never; executionOrder?: never } & Record<string, unknown>>;
    };
    if (!state.experiments) return null;
    for (const exp of Object.values(state.experiments) as Experiment[]) {
      const legacy = exp as unknown as {
        units: ComputeUnit[];
        results?: Record<string, import("./types").UnitResult>;
        executionOrder?: string[];
      };
      if (!legacy.units || exp.scenarios) continue;
      for (const u of legacy.units) if (u.version === undefined) u.version = 1;
      const sc = makeScenario("默认情景", {}, null, exp.createdAt);
      sc.executionOrder = legacy.executionOrder ?? [];
      exp.scenarios = { [sc.id]: sc };
      exp.scenarioOrder = [sc.id];
      exp.activeScenarioId = sc.id;
      exp.resultStore = {};
      // 先运行得到内容键，再用迁移结果覆盖（保留旧 revision 也没关系，后续编辑会重算）。
      const run = runScenario(exp, sc.id, "accepted");
      sc.results = run.results;
      sc.resultKeys = run.keys;
      sc.executionOrder = run.order;
      sc.cycleUnitIds = run.cycleUnitIds;
      for (const u of legacy.units) sc.acceptedFormulaVersions[u.id] = u.version;
      delete (exp as unknown as Record<string, unknown>).results;
      delete (exp as unknown as Record<string, unknown>).executionOrder;
    }
    return state;
  } catch {
    return null;
  }
}

export function loadNotebook(storage: Storage = localStorage): NotebookState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as NotebookState;
      if (parsed.experiments) {
        for (const exp of Object.values(parsed.experiments)) normalizeExperiment(exp);
        return parsed;
      }
    }
    const legacy = storage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrateV1(JSON.parse(legacy));
      if (migrated) {
        for (const exp of Object.values(migrated.experiments)) normalizeExperiment(exp);
        saveNotebook(migrated, storage);
        return migrated;
      }
    }
    return emptyNotebook();
  } catch {
    return emptyNotebook();
  }
}

export function saveNotebook(state: NotebookState, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}
