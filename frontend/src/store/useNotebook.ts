import { create } from "zustand";
import type { ComputeUnit, Experiment, NotebookState } from "../core/types";
import { cloneExperiment, emptyNotebook, loadNotebook, saveNotebook, uid } from "../core/storage";
import { runGraph } from "../core/engine";

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

function runExperiment(exp: Experiment, changedIds?: string[]): Experiment {
  const outcome = runGraph(exp.units, changedIds, exp.results);
  return {
    ...exp,
    updatedAt: Date.now(),
    results: outcome.results,
    executionOrder: outcome.order,
  };
}

interface NotebookStore extends NotebookState {
  hydrate: () => void;
  createExperiment: (name: string) => string;
  selectExperiment: (id: string | null) => void;
  addUnit: (kind: ComputeUnit["kind"]) => string | null;
  updateUnit: (id: string, patch: Partial<ComputeUnit>) => void;
  removeUnit: (id: string) => void;
  recomputeAll: () => void;
  /** 保存一次完整实验：把当前输入与结果的对应关系固化为快照。 */
  snapshot: (name?: string) => string | null;
  /** 从某实验分出参数支线，返回新实验 id。 */
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

  return {
    ...emptyNotebook(),

    hydrate: () => set(loadNotebook()),

    createExperiment: (name) => {
      const now = Date.now();
      const exp: Experiment = {
        id: uid("exp"),
        name: name.trim() || `实验 ${Object.keys(get().experiments).length + 1}`,
        parentId: null,
        createdAt: now,
        updatedAt: now,
        units: [],
        results: {},
        executionOrder: [],
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
      };
      const units = [...exp.units, unit];
      const updated = runExperiment({ ...exp, units }, [unit.id]);
      commit({ ...get(), experiments: { ...get().experiments, [updated.id]: updated } });
      return unit.id;
    },

    updateUnit: (id, patch) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      const units = exp.units.map((u) => (u.id === id ? { ...u, ...patch } : u));
      const updated = runExperiment({ ...exp, units }, [id]);
      commit({ ...get(), experiments: { ...get().experiments, [updated.id]: updated } });
    },

    removeUnit: (id) => {
      const state = get();
      if (!state.activeId) return;
      const exp = state.experiments[state.activeId];
      const units = exp.units.filter((u) => u.id !== id);
      const updated = runExperiment({ ...exp, units, results: {} });
      commit({ ...get(), experiments: { ...get().experiments, [updated.id]: updated } });
    },

    recomputeAll: () => {
      const state = get();
      if (!state.activeId) return;
      const updated = runExperiment(state.experiments[state.activeId]);
      commit({ ...get(), experiments: { ...get().experiments, [updated.id]: updated } });
    },

    snapshot: (name) => {
      const state = get();
      if (!state.activeId) return null;
      const exp = state.experiments[state.activeId];
      const now = Date.now();
      const snap = cloneExperiment(exp, {
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
      const child = cloneExperiment(base, {
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
