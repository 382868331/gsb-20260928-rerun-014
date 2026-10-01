import { create } from "zustand";
import type { ComputeUnit, Experiment, NotebookState, Scenario, UnitResult } from "../core/types";
import {
  cloneExperiment,
  emptyNotebook,
  loadNotebook,
  saveNotebook,
  uid,
} from "../core/storage";
import { runGraph } from "../core/engine";
import {
  BASELINE_SCENARIO_ID,
  acceptScenarioPreview,
  activeResults,
  effectiveUnits,
  normalizeExperiment,
  previewFormulaChange,
  rejectScenarioPreview,
  runAcceptedScenario,
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

function runExperiment(exp: Experiment): Experiment {
  const runResults: Record<string, Record<string, UnitResult>> = {};
  const orders: Record<string, string[]> = {};
  for (const scenarioId of exp.scenarioOrder) {
    const scenario = exp.scenarios[scenarioId];
    const outcome = runGraph(effectiveUnits(exp.units, scenario), undefined, exp.scenarioResults[scenarioId] ?? {});
    runResults[scenarioId] = outcome.results;
    orders[scenarioId] = outcome.order;
  }
  return {
    ...exp,
    updatedAt: Date.now(),
    scenarioResults: runResults,
    scenarioOrders: orders,
    previewResults: {},
    pendingFormulaChange: null,
  };
}

interface NotebookStore extends NotebookState {
  hydrate: () => void;
  createExperiment: (name: string) => string;
  selectExperiment: (id: string | null) => void;
  addUnit: (kind: ComputeUnit["kind"]) => string | null;
  updateUnit: (id: string, patch: Partial<ComputeUnit>) => void;
  updateParameter: (id: string, value: string) => void;
  updateSharedFormula: (id: string, expression: string) => void;
  removeUnit: (id: string) => void;
  recomputeAll: () => void;
  snapshot: (name?: string) => string | null;
  branch: (fromId: string, name: string) => string | null;
  removeExperiment: (id: string) => void;
  addScenario: (name: string, parameterValues?: Record<string, string>) => string | null;
  selectScenario: (id: string) => void;
  removeScenario: (id: string) => void;
  acceptScenario: (id: string) => void;
  rejectScenario: (id: string) => void;
  getExperiment: (id: string) => Experiment | undefined;
  active: () => Experiment | undefined;
}

export const useNotebook = create<NotebookStore>((set, get) => {
  function commit(next: NotebookState) {
    persist(next);
    set({ ...next });
  }

  function mutateActive(mutate: (exp: Experiment) => Experiment) {
    const state = get();
    if (!state.activeId) return;
    const exp = mutate(normalizeExperiment(state.experiments[state.activeId]));
    commit({ ...get(), experiments: { ...get().experiments, [exp.id]: exp } });
  }

  return {
    ...emptyNotebook(),

    hydrate: () => {
      const loaded = loadNotebook();
      const experiments = Object.fromEntries(
        Object.entries(loaded.experiments).map(([id, exp]) => [id, normalizeExperiment(exp)]),
      );
      set({ ...loaded, experiments });
    },

    createExperiment: (name) => {
      const now = Date.now();
      const baseline: Scenario = {
        id: BASELINE_SCENARIO_ID,
        name: "基线参数",
        parentScenarioId: null,
        createdAt: now,
        updatedAt: now,
        parameterValues: {},
        formulaOverrides: {},
        pendingFormulaRevision: null,
      };
      const exp: Experiment = normalizeExperiment({
        id: uid("exp"),
        name: name.trim() || `实验 ${Object.keys(get().experiments).length + 1}`,
        parentId: null,
        createdAt: now,
        updatedAt: now,
        units: [],
        results: {},
        executionOrder: [],
        scenarios: { [baseline.id]: baseline },
        scenarioOrder: [baseline.id],
        activeScenarioId: baseline.id,
        scenarioResults: { [baseline.id]: {} },
        scenarioOrders: { [baseline.id]: [] },
        previewResults: {},
        formulaRevision: 1,
        sharedFormulaRevision: 1,
        pendingFormulaChange: null,
      });
      const state = get();
      commit({
        experiments: { ...state.experiments, [exp.id]: exp },
        rootId: state.rootId ?? exp.id,
        activeId: exp.id,
      });
      return exp.id;
    },

    selectExperiment: (id) => set({ activeId: id }),

    addUnit: (kind) => {
      let createdId: string | null = null;
      mutateActive((exp) => {
        const unit: ComputeUnit = {
          id: uid("u"),
          name: newUnitName(kind),
          kind,
          value: kind === "input" ? "0" : undefined,
          expression: kind === "formula" ? "" : undefined,
        };
        createdId = unit.id;
        return runExperiment({ ...exp, units: [...exp.units, unit] });
      });
      return createdId;
    },

    updateUnit: (id, patch) => {
      if ("value" in patch && patch.value !== undefined) {
        get().updateParameter(id, patch.value);
        return;
      }
      if ("expression" in patch && patch.expression !== undefined) {
        get().updateSharedFormula(id, patch.expression);
        return;
      }
      mutateActive((exp) => {
        const units = exp.units.map((unit) => (unit.id === id ? { ...unit, ...patch } : unit));
        return runExperiment({ ...exp, units });
      });
    },

    updateParameter: (id, value) => {
      mutateActive((exp) => {
        const scenarioId = exp.activeScenarioId ?? BASELINE_SCENARIO_ID;
        const scenario = exp.scenarios[scenarioId];
        const nextScenario: Scenario = {
          ...scenario,
          updatedAt: Date.now(),
          parameterValues: { ...scenario.parameterValues, [id]: value },
        };
        const next = {
          ...exp,
          scenarios: { ...exp.scenarios, [scenarioId]: nextScenario },
        };
        const run = runAcceptedScenario(next, scenarioId, [id]);
        return {
          ...next,
          scenarioResults: run.scenarioResults,
          scenarioOrders: run.scenarioOrders,
        };
      });
    },

    updateSharedFormula: (id, expression) => {
      mutateActive((exp) => {
        const old = exp.units.find((unit) => unit.id === id)?.expression ?? "";
        if (old === expression) return exp;
        return previewFormulaChange({ ...exp, formulaRevision: exp.formulaRevision + 1 }, id, old, expression);
      });
    },

    removeUnit: (id) => mutateActive((exp) => runExperiment({ ...exp, units: exp.units.filter((unit) => unit.id !== id) })),

    recomputeAll: () => mutateActive(runExperiment),

    snapshot: (name) => {
      const state = get();
      if (!state.activeId) return null;
      const exp = normalizeExperiment(state.experiments[state.activeId]);
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
      const base = normalizeExperiment(state.experiments[fromId]);
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

    addScenario: (name, parameterValues = {}) => {
      let newId: string | null = null;
      mutateActive((exp) => {
        const parentId = exp.activeScenarioId ?? BASELINE_SCENARIO_ID;
        const id = uid("scenario");
        const now = Date.now();
        const scenario: Scenario = {
          id,
          name: name.trim() || `情景 ${exp.scenarioOrder.length + 1}`,
          parentScenarioId: parentId,
          createdAt: now,
          updatedAt: now,
          parameterValues: { ...exp.scenarios[parentId].parameterValues, ...parameterValues },
          formulaOverrides: { ...exp.scenarios[parentId].formulaOverrides },
          pendingFormulaRevision: null,
        };
        newId = id;
        let next: Experiment = {
          ...exp,
          scenarios: { ...exp.scenarios, [id]: scenario },
          scenarioOrder: [...exp.scenarioOrder, id],
          activeScenarioId: id,
        };
        const run = runAcceptedScenario(next, id);
        next = { ...next, scenarioResults: run.scenarioResults, scenarioOrders: run.scenarioOrders };
        return next;
      });
      return newId;
    },

    selectScenario: (id) => mutateActive((exp) => ({ ...exp, activeScenarioId: id })),

    removeScenario: (id) => {
      mutateActive((exp) => {
        if (id === BASELINE_SCENARIO_ID || !exp.scenarios[id]) return exp;
        const scenarios = { ...exp.scenarios };
        const scenarioResults = { ...exp.scenarioResults };
        const scenarioOrders = { ...exp.scenarioOrders };
        const previewResults = { ...exp.previewResults };
        delete scenarios[id];
        delete scenarioResults[id];
        delete scenarioOrders[id];
        delete previewResults[id];
        const scenarioOrder = exp.scenarioOrder.filter((item) => item !== id);
        const pendingFormulaChange = scenarioOrder.some((item) => scenarios[item]?.pendingFormulaRevision !== null)
          ? exp.pendingFormulaChange
          : null;
        return {
          ...exp,
          scenarios,
          scenarioResults,
          scenarioOrders,
          previewResults,
          scenarioOrder,
          activeScenarioId: exp.activeScenarioId === id ? BASELINE_SCENARIO_ID : exp.activeScenarioId,
          pendingFormulaChange,
        };
      });
    },

    acceptScenario: (id) => mutateActive((exp) => acceptScenarioPreview(exp, id)),
    rejectScenario: (id) => mutateActive((exp) => rejectScenarioPreview(exp, id)),

    getExperiment: (id) => normalizeExperiment(get().experiments[id]),
    active: () => (get().activeId ? normalizeExperiment(get().experiments[get().activeId!]) : undefined),
  };
});
