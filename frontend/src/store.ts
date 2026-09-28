import { create } from "zustand";
import { api } from "./api";
import type { Notebook, RunReport } from "./types";

interface State {
  notebook: Notebook | null;
  report: RunReport | null;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  run: (force?: boolean) => Promise<void>;
  addCell: (kind: "compute" | "plot") => Promise<void>;
  updateCell: (
    cellId: string,
    patch: { name?: string; code?: string; params?: Record<string, unknown> },
  ) => Promise<void>;
  deleteCell: (cellId: string) => Promise<void>;
  resetDemo: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  notebook: null,
  report: null,
  error: null,
  load: async () => {
    const list = await api.listNotebooks();
    const id = list.find((n) => n.id === "demo")?.id ?? list[0]?.id;
    if (id) {
      const notebook = await api.getNotebook(id);
      set({ notebook, error: null });
    }
  },
  refresh: async () => {
    const nb = get().notebook;
    if (!nb) return;
    set({ notebook: await api.getNotebook(nb.id) });
  },
  run: async (force = false) => {
    const nb = get().notebook;
    if (!nb) return;
    try {
      const res = await api.run(nb.id, force);
      set({ notebook: res.notebook, report: res.report, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  addCell: async (kind) => {
    const nb = get().notebook;
    if (!nb) return;
    const base = kind === "plot" ? "plot" : "cell";
    let i = 1;
    while (nb.cells.some((c) => c.name === `${base}_${i}`)) i++;
    try {
      const notebook = await api.addCell(nb.id, `${base}_${i}`, kind);
      set({ notebook, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  updateCell: async (cellId, patch) => {
    const nb = get().notebook;
    if (!nb) return;
    try {
      const notebook = await api.updateCell(nb.id, cellId, patch);
      set({ notebook, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
  deleteCell: async (cellId) => {
    const nb = get().notebook;
    if (!nb) return;
    const notebook = await api.deleteCell(nb.id, cellId);
    set({ notebook });
  },
  resetDemo: async () => {
    const nb = get().notebook;
    if (!nb) return;
    const notebook = await api.resetDemo(nb.id);
    set({ notebook, report: null });
  },
}));
