import type { CellKind, Notebook, RunResponse } from "./types";

const base = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
  return res.json();
}

export const api = {
  listNotebooks: () => req<{ id: string; title: string }[]>("/notebooks"),
  getNotebook: (id: string) => req<Notebook>(`/notebooks/${id}`),
  createNotebook: () =>
    req<Notebook>("/notebooks", { method: "POST", body: "{}" }),
  addCell: (nb: string, name: string, kind: CellKind) =>
    req<Notebook>(`/notebooks/${nb}/cells`, {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    }),
  updateCell: (
    nb: string,
    cell: string,
    patch: { name?: string; code?: string; params?: Record<string, unknown> },
  ) =>
    req<Notebook>(`/notebooks/${nb}/cells/${cell}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteCell: (nb: string, cell: string) =>
    req<Notebook>(`/notebooks/${nb}/cells/${cell}`, { method: "DELETE" }),
  run: (nb: string, force = false) =>
    req<RunResponse>(`/notebooks/${nb}/run`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  resetDemo: (nb: string) =>
    req<Notebook>(`/notebooks/${nb}/reset-demo`, { method: "POST", body: "{}" }),
};
