import { afterEach, describe, expect, it } from "vitest";
import { cloneExperiment, loadNotebook, saveNotebook, STORAGE_KEY } from "./storage";
import { runGraph } from "./engine";
import { normalizeExperiment } from "./scenarios";
import type { ComputeUnit, Experiment } from "./types";

function makeExperiment(): Experiment {
  const units: ComputeUnit[] = [
    { id: "a", name: "a", kind: "input", value: "3" },
    { id: "b", name: "b", kind: "formula", expression: "a * 2" },
  ];
  const run = runGraph(units);
  return normalizeExperiment({
    id: "root",
    name: "根",
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    units,
    results: run.results,
    executionOrder: run.order,
  } as Experiment);
}

describe("版本隔离", () => {
  it("支线深拷贝自基线，之后修改参数互不影响", () => {
    const root = makeExperiment();
    const branchExp = cloneExperiment(root, { id: "child", name: "支线", parentId: root.id });

    // 修改支线输入并重算。
    branchExp.units = branchExp.units.map((u) => (u.id === "a" ? { ...u, value: "10" } : u));
    const run = runGraph(branchExp.units, ["a"], branchExp.results);
    branchExp.results = run.results;

    // 原实验输入与结果保持不变。
    expect(root.units.find((u) => u.id === "a")!.value).toBe("3");
    expect(root.results.b.value).toBe(6);
    expect(branchExp.results.b.value).toBe(20);
  });
});

describe("重开持久化", () => {
  afterEach(() => localStorage.clear());

  it("重开后保留输入与结果的对应关系，而不只是最后数字", () => {
    const root = makeExperiment();
    const child = cloneExperiment(root, {
      id: "child",
      name: "支线",
      parentId: root.id,
      units: root.units.map((u) => (u.id === "a" ? { ...u, value: "8" } : u)),
    });
    const childRun = runGraph(child.units);
    child.results = childRun.results;

    const state = { experiments: { [root.id]: root, [child.id]: child }, rootId: root.id, activeId: child.id };
    saveNotebook(state, localStorage);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.experiments.root.units[0].value).toBe("3");
    expect(raw.experiments.root.results.b.value).toBe(6);
    expect(raw.experiments.child.units[0].value).toBe("8");
    expect(raw.experiments.child.results.b.value).toBe(16);
    expect(raw.experiments.child.parentId).toBe("root");

    const reloaded = loadNotebook(localStorage);
    expect(reloaded.experiments.root.results.b.revision).toContain("formula");
    expect(reloaded.experiments.child.results.b.value).toBe(16);
    expect(reloaded.activeId).toBe("child");
  });
});
