import { describe, expect, it } from "vitest";
import type { ComputeUnit, Experiment } from "./types";
import { makeScenario, loadNotebook, saveNotebook, normalizeExperiment } from "./storage";
import {
  acceptPending,
  detachScenario,
  discardPending,
  effectiveUnits,
  isUnitPending,
  refreshPending,
  runScenario,
} from "./scenarios";

function setupExperiment(): Experiment {
  const now = 1;
  const units: ComputeUnit[] = [
    { id: "a", name: "a", kind: "input", value: "1", version: 1 },
    {
      id: "b", name: "b", kind: "formula", expression: "a * 2", version: 1,
      revisions: [{ version: 1, expression: "a * 2" }],
    },
  ];
  const s1 = makeScenario("情景一", {}, null, now, { b: 1 });
  const s2 = makeScenario("情景二", {}, s1.id, now, { b: 1 });
  const exp: Experiment = {
    id: "exp", name: "E", parentId: null, createdAt: now, updatedAt: now, units,
    scenarios: { [s1.id]: s1, [s2.id]: s2 }, scenarioOrder: [s1.id, s2.id],
    activeScenarioId: s1.id, resultStore: {},
  };
  for (const id of exp.scenarioOrder) {
    const run = runScenario(exp, id, "accepted");
    exp.scenarios[id].results = run.results;
    exp.scenarios[id].resultKeys = run.keys;
    exp.scenarios[id].executionOrder = run.order;
  }
  return exp;
}

function changeFormula(exp: Experiment, unitId: string, expression: string) {
  const u = exp.units.find((x) => x.id === unitId)!;
  u.version += 1;
  u.expression = expression;
  u.revisions = [...(u.revisions ?? []), { version: u.version, expression }];
  for (const id of exp.scenarioOrder) refreshPending(exp, id);
}

function setParam(exp: Experiment, id: string, unitId: string, value: string) {
  const sc = exp.scenarios[id];
  sc.params[unitId] = value;
  const run = runScenario(exp, id, "accepted", [unitId]);
  sc.results = run.results;
  sc.resultKeys = run.keys;
  sc.executionOrder = run.order;
  refreshPending(exp, id);
}

function memoryStorage() {
  const data: Record<string, string> = {};
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
    clear: () => { Object.keys(data).forEach((k) => delete data[k]); },
  };
}

describe("回归：部分接受后未接受情景仍按旧公式", () => {
  it("乘二改乘三：只情景一接受；情景二改参数为 7 得 14 而不是 21", () => {
    const exp = setupExperiment();
    const [id1, id2] = exp.scenarioOrder;
    changeFormula(exp, "b", "a * 3");
    expect(exp.scenarios[id1].pending.b.value).toBe(3);
    expect(exp.scenarios[id2].pending.b.value).toBe(3);

    acceptPending(exp, id1);
    expect(exp.scenarios[id1].results.b.value).toBe(3);
    expect(isUnitPending(exp, exp.scenarios[id2], "b")).toBe(true);
    expect(exp.scenarios[id2].results.b.value).toBe(2);

    setParam(exp, id2, "a", "7");
    expect(exp.scenarios[id2].results.b.value).toBe(14);
    expect(exp.scenarios[id2].pending.b.value).toBe(21);
    expect(effectiveUnits(exp, exp.scenarios[id2], "accepted").find((u) => u.id === "b")!.expression).toBe("a * 2");
    expect(effectiveUnits(exp, exp.scenarios[id2], "pending").find((u) => u.id === "b")!.expression).toBe("a * 3");
  });

  it("连续修订 v2(乘三)、v3(乘四)：情景停留在不同已接受版本，预览相对各自基线", () => {
    const exp = setupExperiment();
    const [id1, id2] = exp.scenarioOrder;
    changeFormula(exp, "b", "a * 3");
    acceptPending(exp, id1);
    changeFormula(exp, "b", "a * 4");
    expect(exp.scenarios[id1].results.b.value).toBe(3);
    expect(exp.scenarios[id1].pending.b.value).toBe(4);
    expect(exp.scenarios[id2].results.b.value).toBe(2);
    expect(exp.scenarios[id2].pending.b.value).toBe(4);
    expect(exp.scenarios[id1].resultKeys.b).toContain("v2");
    expect(exp.scenarios[id2].resultKeys.b).toContain("v1");
  });

  it("派生情景继承当时已接受版本，父后来接受不改变它；放弃预览后仍按旧版", () => {
    const exp = setupExperiment();
    const [id1] = exp.scenarioOrder;
    changeFormula(exp, "b", "a * 3");
    acceptPending(exp, id1);
    changeFormula(exp, "b", "a * 4");
    const parent = exp.scenarios[id1];
    const child = makeScenario("派生", { ...parent.params }, id1, 5, { ...parent.acceptedFormulaVersions });
    exp.scenarios[child.id] = child;
    exp.scenarioOrder.push(child.id);
    for (const [uid2, result] of Object.entries(parent.results)) {
      child.results[uid2] = { ...result };
      child.resultKeys[uid2] = parent.resultKeys[uid2];
    }
    refreshPending(exp, child.id);
    expect(child.results.b.value).toBe(3);
    expect(child.pending.b.value).toBe(4);
    acceptPending(exp, id1);
    expect(exp.scenarios[id1].results.b.value).toBe(4);
    expect(child.results.b.value).toBe(3);
    discardPending(exp, child.id);
    setParam(exp, child.id, "a", "7");
    expect(child.results.b.value).toBe(21);
  });

  it("v2 成环、v3 断环：只影响采用它的情景；部分接受后保存，成功记录不混接", () => {
    const units: ComputeUnit[] = [
      { id: "a", name: "a", kind: "input", value: "2", version: 1 },
      {
        id: "b", name: "b", kind: "formula", expression: "a * 2", version: 1,
        revisions: [{ version: 1, expression: "a * 2" }],
      },
      {
        id: "c", name: "c", kind: "formula", expression: "b + 1", version: 1,
        revisions: [{ version: 1, expression: "b + 1" }],
      },
    ];
    const s1 = makeScenario("s1", {}, null, 1, { b: 1, c: 1 });
    const s2 = makeScenario("s2", {}, null, 1, { b: 1, c: 1 });
    const exp: Experiment = {
      id: "e", name: "E", parentId: null, createdAt: 1, updatedAt: 1, units,
      scenarios: { [s1.id]: s1, [s2.id]: s2 }, scenarioOrder: [s1.id, s2.id],
      activeScenarioId: s1.id, resultStore: {},
    };
    for (const id of exp.scenarioOrder) {
      const run = runScenario(exp, id, "accepted");
      exp.scenarios[id].results = run.results;
      exp.scenarios[id].resultKeys = run.keys;
    }
    const b = exp.units.find((u) => u.id === "b")!;
    b.version = 2;
    b.expression = "c + 1";
    b.revisions!.push({ version: 2, expression: "c + 1" });
    for (const id of exp.scenarioOrder) refreshPending(exp, id);
    expect(s1.pending.b.errorKind).toBe("cycle");
    expect(s1.pending.c.errorKind).toBe("cycle");
    acceptPending(exp, s1.id);
    expect(s1.results.b.status).toBe("error");
    expect(s2.results.b.value).toBe(4);

    const storage = memoryStorage();
    saveNotebook({ experiments: { e: exp }, rootId: "e", activeId: "e" }, storage as unknown as Storage);

    b.version = 3;
    b.expression = "a * 5";
    b.revisions!.push({ version: 3, expression: "a * 5" });
    refreshPending(exp, s1.id);
    refreshPending(exp, s2.id);
    expect(s1.pending.b.value).toBe(10);
    expect(s1.pending.c.value).toBe(11);
    expect(s2.pending.b.value).toBe(10);
    acceptPending(exp, s2.id);
    expect(s2.results.b.value).toBe(10);
    expect(s2.results.c.value).toBe(11);
    expect(s1.results.b.status).toBe("error");
    expect(s1.results.b.errorKind).toBe("cycle");

    const reloaded = loadNotebook(storage as unknown as Storage);
    const e2 = reloaded.experiments.e;
    const s1r = e2.scenarios[s1.id];
    const s2r = e2.scenarios[s2.id];
    expect(s1r.results.b.errorKind).toBe("cycle");
    expect(s2r.results.b.value).toBe(4);
    expect(s1r.acceptedFormulaVersions.b).toBe(2);
    expect(s2r.acceptedFormulaVersions.b).toBe(1);
    expect(e2.units.find((u) => u.id === "b")!.revisions!.map((r) => r.version)).toEqual([1, 2]);
  });

  it("删除情景后另一情景的结果与公式版本仍可追溯", () => {
    const exp = setupExperiment();
    const [id1, id2] = exp.scenarioOrder;
    changeFormula(exp, "b", "a * 3");
    acceptPending(exp, id1);
    const key1 = exp.scenarios[id1].resultKeys.b;
    const key2 = exp.scenarios[id2].resultKeys.b;
    detachScenario(exp, id1);
    delete exp.scenarios[id1];
    expect(exp.resultStore[key1]).toBeUndefined();
    expect(exp.resultStore[key2]).toBeDefined();
    expect(exp.scenarios[id2].results.b.value).toBe(2);
  });

  it("normalize 为缺失历史的旧数据回填且版本不混", () => {
    const units: ComputeUnit[] = [
      { id: "a", name: "a", kind: "input", value: "1", version: 1 },
      { id: "b", name: "b", kind: "formula", expression: "a * 3", version: 2 },
    ];
    const s1 = makeScenario("s1", {}, null, 1, { b: 2 });
    const s2 = makeScenario("s2", {}, null, 1, { b: 1 });
    const exp: Experiment = {
      id: "e", name: "E", parentId: null, createdAt: 1, updatedAt: 1, units,
      scenarios: { [s1.id]: s1, [s2.id]: s2 }, scenarioOrder: [s1.id, s2.id],
      activeScenarioId: s1.id, resultStore: {},
    };
    normalizeExperiment(exp);
    expect(exp.units.find((u) => u.id === "b")!.revisions!.map((r) => r.version)).toEqual([1, 2]);
    expect(effectiveUnits(exp, s1, "accepted").find((u) => u.id === "b")!.version).toBe(2);
    expect(effectiveUnits(exp, s2, "accepted").find((u) => u.id === "b")!.version).toBe(1);
  });
});
