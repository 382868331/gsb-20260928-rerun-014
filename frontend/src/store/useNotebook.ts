import { create } from "zustand";
import type { ComputeUnit, Experiment, InputConstraint, JointObservation, NotebookState } from "../core/types";
import {
  cloneExperiment,
  emptyNotebook,
  loadNotebook,
  makeScenario,
  recordFormulaHistory,
  rebuildResultStore,
  saveNotebook,
  uid,
} from "../core/storage";
import {
  acceptPending as acceptScenarioPending,
  detachScenario,
  discardPending as discardScenarioPending,
  refreshPendingPreview,
  runScenario,
} from "../core/scenarios";

let idCounter = 0;
export function newUnitName(kind: ComputeUnit["kind"]): string {
  idCounter += 1;
  return kind === "input" ? `x${idCounter}` : `f${idCounter}`;
}

function persist(state: NotebookState) {
  try {
    saveNotebook(state);
  } catch {
    // 存储不可用时仅在内存中保留。
  }
}

/** 在某个情景内重算（参数编辑后的增量重算）。 */
function refreshScenario(exp: Experiment, scenarioId: string, changedInputIds?: string[]) {
  const sc = exp.scenarios[scenarioId];
  const run = runScenario(exp, scenarioId, "accepted", changedInputIds);
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  sc.cycleUnitIds = run.cycleUnitIds;
}

interface NotebookStore extends NotebookState {
  hydrate: () => void;
  createExperiment: (name: string) => string;
  selectExperiment: (id: string | null) => void;
  selectScenario: (scenarioId: string) => void;
  addUnit: (kind: ComputeUnit["kind"]) => string | null;
  /** 编辑共享定义：公式 / 名称 / 备注。公式内容变化时产生新版本并对所有情景生成预览。 */
  updateUnit: (id: string, patch: Partial<ComputeUnit>) => void;
  /** 编辑当前情景的参数（input 覆盖），只影响该情景。 */
  updateScenarioParam: (unitId: string, value: string) => void;
  updateInputConstraint: (unitId: string, constraint: InputConstraint | null) => void;
  addJointObservation: () => string | null;
  updateJointObservation: (observationId: string, patch: Partial<JointObservation>) => void;
  removeJointObservation: (observationId: string) => void;
  removeUnit: (id: string) => void;
  recomputeAll: () => void;
  addScenario: (name?: string) => string | null;
  removeScenario: (scenarioId: string) => void;
  acceptScenarioUpdate: (scenarioId: string) => void;
  acceptAllScenarioUpdates: () => void;
  discardScenarioUpdate: (scenarioId: string) => void;
  snapshot: (name?: string) => string | null;
  branch: (fromId: string, name: string) => string | null;
  removeExperiment: (id: string) => void;
  getExperiment: (id: string) => Experiment | undefined;
  active: () => Experiment | undefined;
}

export const useNotebook = create<NotebookStore>((set, get) => {
  function commit(next: NotebookState) {
    persist(next);
    set({ ...next });
  }

  /** 深拷贝实验（快照/支线），结果仓按内容键重新装载并重新计数。 */
  function cloneWith(exp: Experiment, overrides: Partial<Experiment>): Experiment {
    const cloned = cloneExperiment(exp, overrides);
    rebuildResultStore(cloned);
    return cloned;
  }

  return {
    ...emptyNotebook(),

    hydrate: () => set(loadNotebook()),

    createExperiment: (name) => {
      const now = Date.now();
      const expId = uid("exp");
      const sc = makeScenario("默认情景", {}, null, now);
      const exp: Experiment = {
        id: expId,
        name: name.trim() || `实验 ${Object.keys(get().experiments).length + 1}`,
        parentId: null,
        createdAt: now,
        updatedAt: now,
        units: [],
        scenarios: { [sc.id]: sc },
        scenarioOrder: [sc.id],
        activeScenarioId: sc.id,
        resultStore: {},
        formulaHistory: {},
      };
      const state = get();
      const next: NotebookState = {
        experiments: { ...state.experiments, [exp.id]: exp },
        rootId: state.rootId ?? exp.id,
        activeId: exp.id,
      };
      commit(next);
      return exp.id;
    },

    selectExperiment: (id) => set({ activeId: id }),
    selectScenario: (scenarioId) => {
      const state = get();
      const exp = state.activeId ? state.experiments[state.activeId] : null;
      if (!exp || !exp.scenarios[scenarioId]) return;
      exp.activeScenarioId = scenarioId;
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    addUnit: (kind) => {
      const state = get();
      if (!state.activeId) return null;
      const exp = state.experiments[state.activeId];
      const unit: ComputeUnit = {
        id: uid("u"),
        name: newUnitName(kind),
        kind,
        value: kind === "input" ? "0" : undefined,
        expression: kind === "formula" ? "" : undefined,
        version: 1,
      };
      exp.units = [...exp.units, unit];
      if (kind === "formula") {
        for (const sc of Object.values(exp.scenarios)) sc.acceptedFormulaVersions[unit.id] = 1;
        recordFormulaHistory(exp, unit.id, 1, unit.expression ?? "");
      }
      for (const scId of exp.scenarioOrder) refreshScenario(exp, scId, [unit.id]);
      exp.updatedAt = Date.now();
      commit({ ...get(), experiments: { ...get().experiments } });
      return unit.id;
    },

    updateUnit: (id, patch) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      const old = exp.units.find((u) => u.id === id);
      if (!old) return;

      const formulaChanged = old.kind === "formula"
        && patch.expression !== undefined && patch.expression !== old.expression;
      const nextVersion = formulaChanged ? old.version + 1 : old.version;
      exp.units = exp.units.map((u) => (u.id === id ? { ...u, ...patch, version: nextVersion } : u));

      if (formulaChanged) {
        recordFormulaHistory(exp, id, nextVersion, patch.expression ?? old.expression ?? "");
        for (const scId of exp.scenarioOrder) {
          refreshPendingPreview(exp, scId, [id]);
        }
      } else {
        // 改名/备注等结构性编辑：失效的名称引用会在正式重算中定位。
        const structuralDefinitionChanged = patch.name !== undefined || (old.kind === "input" && patch.value !== undefined);
        for (const scId of exp.scenarioOrder) {
          refreshScenario(exp, scId);
          if (structuralDefinitionChanged) refreshPendingPreview(exp, scId, [], [], true);
        }
      }
      exp.updatedAt = Date.now();
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    updateScenarioParam: (unitId, value) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      const scId = exp.activeScenarioId;
      if (!scId) return;
      const sc = exp.scenarios[scId];
      const unit = exp.units.find((u) => u.id === unitId);
      if (!unit || unit.kind !== "input") return;
      const defaultVal = unit.value ?? "";
      if (value === defaultVal) delete sc.params[unitId];
      else sc.params[unitId] = value;
      refreshScenario(exp, scId, [unitId]);
      refreshPendingPreview(exp, scId, [], [unitId], true);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    updateInputConstraint: (unitId, constraint) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      if (!exp.activeScenarioId) return;
      const unit = exp.units.find((u) => u.id === unitId && u.kind === "input");
      const sc = exp.scenarios[exp.activeScenarioId];
      if (!unit || !sc) return;
      sc.inputConstraints ??= {};
      if (constraint) sc.inputConstraints[unitId] = constraint;
      else delete sc.inputConstraints[unitId];
      if (constraint?.mode === "point") sc.params[unitId] = constraint.text;
      else delete sc.params[unitId];
      refreshScenario(exp, sc.id);
      refreshPendingPreview(exp, sc.id, [], [], true);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    addJointObservation: () => {
      const state = get();
      if (!state.activeId || !state.experiments[state.activeId].activeScenarioId) return null;
      const exp = state.experiments[state.activeId];
      const sc = exp.scenarios[exp.activeScenarioId!];
      sc.jointObservations ??= [];
      const observation: JointObservation = { id: uid("obs"), name: `观测 ${sc.jointObservations.length + 1}`, values: {} };
      sc.jointObservations.push(observation);
      commit({ ...get(), experiments: { ...get().experiments } });
      return observation.id;
    },

    updateJointObservation: (observationId, patch) => {
      const state = get();
      if (!state.activeId || !state.experiments[state.activeId].activeScenarioId) return;
      const exp = state.experiments[state.activeId];
      const sc = exp.scenarios[exp.activeScenarioId!];
      const observation = sc.jointObservations?.find((item) => item.id === observationId);
      if (!observation) return;
      Object.assign(observation, patch);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    removeJointObservation: (observationId) => {
      const state = get();
      if (!state.activeId || !state.experiments[state.activeId].activeScenarioId) return;
      const sc = state.experiments[state.activeId].scenarios[state.experiments[state.activeId].activeScenarioId!];
      sc.jointObservations = (sc.jointObservations ?? []).filter((item) => item.id !== observationId);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    removeUnit: (id) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      exp.units = exp.units.filter((u) => u.id !== id);
      for (const sc of Object.values(exp.scenarios)) {
        delete sc.params[id];
        delete sc.inputConstraints?.[id];
        sc.jointObservations = (sc.jointObservations ?? []).map((obs) => {
          const values = { ...obs.values };
          delete values[id];
          return { ...obs, values };
        });
        delete sc.acceptedFormulaVersions[id];
        delete sc.pending[id];
        delete sc.pendingKeys[id];
        delete sc.pendingFormulaVersions?.[id];
      }
      delete exp.formulaHistory?.[id];
      for (const scId of exp.scenarioOrder) refreshScenario(exp, scId);
      exp.updatedAt = Date.now();
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    recomputeAll: () => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      for (const scId of exp.scenarioOrder) refreshScenario(exp, scId);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    addScenario: (name) => {
      const state = get();
      if (!state.activeId) return null;
      const exp = state.experiments[state.activeId];
      const base = exp.activeScenarioId ? exp.scenarios[exp.activeScenarioId] : null;
      const sc = makeScenario(
        name?.trim() || `情景 ${exp.scenarioOrder.length + 1}`,
        base ? { ...base.params } : {},
        base?.id ?? null,
      );
      if (base) {
        sc.acceptedFormulaVersions = { ...base.acceptedFormulaVersions };
        sc.inputConstraints = structuredClone(base.inputConstraints ?? {});
        sc.jointObservations = structuredClone(base.jointObservations ?? []);
      }
      exp.scenarios[sc.id] = sc;
      exp.scenarioOrder = [...exp.scenarioOrder, sc.id];
      exp.activeScenarioId = sc.id;
      refreshScenario(exp, sc.id);
      refreshPendingPreview(exp, sc.id, [], [], true);
      exp.updatedAt = Date.now();
      commit({ ...get(), experiments: { ...get().experiments } });
      return sc.id;
    },

    removeScenario: (scenarioId) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      detachScenario(exp, scenarioId);
      delete exp.scenarios[scenarioId];
      exp.scenarioOrder = exp.scenarioOrder.filter((id) => id !== scenarioId);
      if (exp.activeScenarioId === scenarioId) {
        exp.activeScenarioId = exp.scenarioOrder[0] ?? null;
      }
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    acceptScenarioUpdate: (scenarioId) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      if (!exp.scenarios[scenarioId] || Object.keys(exp.scenarios[scenarioId].pending).length === 0) return;
      acceptScenarioPending(exp, scenarioId);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    acceptAllScenarioUpdates: () => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      for (const scId of exp.scenarioOrder) {
        if (Object.keys(exp.scenarios[scId].pending).length > 0) acceptScenarioPending(exp, scId);
      }
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    discardScenarioUpdate: (scenarioId) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      discardScenarioPending(exp, scenarioId);
      commit({ ...get(), experiments: { ...get().experiments } });
    },

    snapshot: (name) => {
      const state = get();
      if (!state.activeId) return null;
      const exp = state.experiments[state.activeId];
      const now = Date.now();
      const snap = cloneWith(exp, {
        id: uid("exp"),
        name: name?.trim() || `${exp.name} @ ${new Date(now).toLocaleString()}`,
        parentId: exp.parentId,
        createdAt: now,
        updatedAt: now,
      });
      commit({ ...get(), experiments: { ...get().experiments, [snap.id]: snap }, activeId: snap.id });
      return snap.id;
    },

    branch: (fromId, name) => {
      const state = get();
      const base = state.experiments[fromId];
      if (!base) return null;
      const now = Date.now();
      const child = cloneWith(base, {
        id: uid("exp"),
        name: name.trim() || `${base.name} 支线`,
        parentId: base.id,
        createdAt: now,
        updatedAt: now,
      });
      commit({ ...get(), experiments: { ...get().experiments, [child.id]: child }, activeId: child.id });
      return child.id;
    },

    removeExperiment: (id) => {
      const state = get();
      const experiments = { ...state.experiments };
      delete experiments[id];
      commit({
        experiments,
        rootId: state.rootId === id ? null : state.rootId,
        activeId: state.activeId === id ? null : state.activeId,
      });
    },

    getExperiment: (id) => get().experiments[id],
    active: () => (get().activeId ? get().experiments[get().activeId!] : undefined),
  };
});
