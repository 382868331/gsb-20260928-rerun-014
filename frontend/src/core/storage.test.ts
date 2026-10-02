import { afterEach, describe, expect, it } from "vitest";
import { cloneExperiment, loadNotebook, makeScenario, rebuildResultStore, recordFormulaHistory, saveNotebook, STORAGE_KEY } from "./storage";
import { refreshPendingPreview, runScenario } from "./scenarios";
import type { ComputeUnit, Experiment } from "./types";

function makeExperiment(): Experiment {
  const now = 1;
  const units: ComputeUnit[] = [
    { id: "a", name: "a", kind: "input", value: "3", version: 1 },
    { id: "b", name: "b", kind: "formula", expression: "a * 2", version: 1 },
  ];
  const sc = makeScenario("默认情景", {}, null, now);
  const exp: Experiment = {
    id: "root",
    name: "根",
    parentId: null,
    createdAt: now,
    updatedAt: now,
    units,
    scenarios: { [sc.id]: sc },
    scenarioOrder: [sc.id],
    activeScenarioId: sc.id,
    resultStore: {},
  };
  sc.acceptedFormulaVersions.b = 1;
  recordFormulaHistory(exp, "b", 1, "a * 2");
  const run = runScenario(exp, sc.id, "accepted");
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  return exp;
}

describe("支线深拷贝隔离", () => {
  it("快照深拷贝自基线，参数与结果互不影响", () => {
    const root = makeExperiment();
    const child = cloneExperiment(root, { id: "child", name: "支线", parentId: root.id });
    rebuildResultStore(child);
    const childScId = child.scenarioOrder[0];
    const rootScId = root.scenarioOrder[0];
    const childSc = child.scenarios[childScId];

    childSc.params.a = "10";
    const run = runScenario(child, childScId, "accepted", ["a"]);
    childSc.results = run.results;
    childSc.resultKeys = run.keys;

    expect(root.scenarios[rootScId].params.a).toBeUndefined();
    expect(root.scenarios[rootScId].results.b.value).toBe(6);
    expect(childSc.results.b.value).toBe(20);
    // 结果仓也是独立的两份存储。
    expect(child.resultStore).not.toBe(root.resultStore);
  });
});

describe("重开持久化与版本追溯", () => {
  afterEach(() => localStorage.clear());

  it("保存参数覆盖、结果、公式版本与结果仓；重开后完整复原", () => {
    const root = makeExperiment();
    const rootScId = root.scenarioOrder[0];
    const hi = makeScenario("高参数", { a: "8" }, rootScId, 2);
    root.scenarios[hi.id] = hi;
    root.scenarioOrder.push(hi.id);
    hi.acceptedFormulaVersions.b = 1;
    const run = runScenario(root, hi.id, "accepted");
    hi.results = run.results;
    hi.resultKeys = run.keys;

    const state = { experiments: { root }, rootId: "root", activeId: "root" };
    saveNotebook(state, localStorage);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const savedHi = raw.experiments.root.scenarios[hi.id];
    expect(savedHi.params.a).toBe("8");
    expect(savedHi.results.b.value).toBe(16);
    expect(raw.experiments.root.units.find((x: ComputeUnit) => x.id === "b").version).toBe(1);
    expect(savedHi.acceptedFormulaVersions.b).toBe(1);
    // 结果仓按内容键保存。
    const storedKey = savedHi.resultKeys.b;
    expect(raw.experiments.root.resultStore[storedKey].result.value).toBe(16);

    const reloaded = loadNotebook(localStorage);
    const exp2 = reloaded.experiments.root;
    const hi2 = exp2.scenarios[hi.id];
    expect(hi2.results.b.revision).toContain("formula:v1");
    expect(hi2.results.b.value).toBe(16);
    expect(exp2.scenarios[rootScId].results.b.value).toBe(6);
  });

  it("部分接受后保存重开，未接受情景继续用历史公式计算", () => {
    const root = makeExperiment();
    const rootScId = root.scenarioOrder[0];
    const old = makeScenario("旧版情景", { a: "5" }, rootScId, 3);
    root.scenarios[old.id] = old;
    root.scenarioOrder.push(old.id);
    old.acceptedFormulaVersions.b = 1;
    let run = runScenario(root, old.id, "accepted");
    old.results = run.results;
    old.resultKeys = run.keys;

    const b = root.units.find((u) => u.id === "b")!;
    b.expression = "a * 3";
    b.version = 2;
    recordFormulaHistory(root, b.id, 2, b.expression);
    refreshPendingPreview(root, rootScId, ["b"]);
    refreshPendingPreview(root, old.id, ["b"]);
    const accepted = root.scenarios[rootScId];
    accepted.acceptedFormulaVersions.b = 2;
    run = runScenario(root, rootScId, "accepted", ["b"]);
    accepted.results = run.results;
    accepted.resultKeys = run.keys;
    accepted.pending = {};
    accepted.pendingKeys = {};
    accepted.pendingFormulaVersions = {};

    saveNotebook({ experiments: { root }, rootId: "root", activeId: "root" }, localStorage);
    const reloaded = loadNotebook(localStorage);
    const exp = reloaded.experiments.root;
    const oldReloaded = exp.scenarios[old.id];
    oldReloaded.params.a = "7";
    run = runScenario(exp, old.id, "accepted", ["a"]);
    oldReloaded.results = run.results;
    oldReloaded.resultKeys = run.keys;

    expect(oldReloaded.results.b.value).toBe(14);
    expect(oldReloaded.results.b.revision).toContain("formula:v1");
    expect(exp.formulaHistory?.b?.[1]).toBe("a * 2");
    expect(exp.formulaHistory?.b?.[2]).toBe("a * 3");
  });
});

describe("v1 数据迁移", () => {
  afterEach(() => localStorage.clear());

  it("把旧的单情景实验迁移为共享定义 + 默认情景", () => {
    const legacy = {
      experiments: {
        old: {
          id: "old",
          name: "旧实验",
          parentId: null,
          createdAt: 1,
          updatedAt: 1,
          units: [
            { id: "a", name: "a", kind: "input", value: "4" },
            { id: "b", name: "b", kind: "formula", expression: "a + 1" },
          ],
          results: { a: { unitId: "a", status: "ok", value: 4, revision: "input:4" } },
          executionOrder: ["a", "b"],
        },
      },
      rootId: "old",
      activeId: "old",
    };
    localStorage.setItem("sci-compute-notebook:v1", JSON.stringify(legacy));
    const reloaded = loadNotebook(localStorage);
    const exp = reloaded.experiments.old;
    expect(exp.scenarioOrder).toHaveLength(1);
    const sc = exp.scenarios[exp.scenarioOrder[0]];
    expect(sc.results.b.value).toBe(5);
    expect(exp.units.find((x) => x.id === "b")!.version).toBe(1);
    // v2 键已写入，后续不再走迁移。
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});
