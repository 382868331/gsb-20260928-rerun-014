import type { Experiment, NotebookState } from "./types";

export const STORAGE_KEY = "sci-compute-notebook:v1";

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 深拷贝实验，确保支线与原实验完全隔离，后续改动互不影响。 */
export function cloneExperiment(exp: Experiment, overrides: Partial<Experiment>): Experiment {
  return {
    ...structuredClone(exp),
    ...overrides,
    units: overrides.units ? structuredClone(overrides.units) : structuredClone(exp.units),
    results: overrides.results ? structuredClone(overrides.results) : structuredClone(exp.results),
    executionOrder: overrides.executionOrder ? [...overrides.executionOrder] : [...exp.executionOrder],
  };
}

export function emptyNotebook(): NotebookState {
  return { experiments: {}, rootId: null, activeId: null };
}

export function loadNotebook(storage: Storage = localStorage): NotebookState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyNotebook();
    const parsed = JSON.parse(raw) as NotebookState;
    if (!parsed.experiments) return emptyNotebook();
    return parsed;
  } catch {
    return emptyNotebook();
  }
}

export function saveNotebook(state: NotebookState, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}
