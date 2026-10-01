import { describe, expect, it } from "vitest";
import { runGraph } from "./engine";
import {
  acceptScenarioPreview,
  effectiveUnits,
  previewFormulaChange,
  rejectScenarioPreview,
} from "./scenarios";
import type { Experiment, Scenario } from "./types";

function scenario(id: string, name: string, values: Record<string, string>): Scenario {
  return {
    id,
    name,
    parentScenarioId: null,
    createdAt: 1,
    updatedAt: 1,
    parameterValues: values,
    formulaOverrides: {},
    pendingFormulaRevision: null,
  };
}

function makeExperiment(): Experiment {
  const units = [
    { id: "a", name: "a", kind: "input" as const, value: "2" },
    { id: "b", name: "b", kind: "input" as const, value: "3" },
    { id: "f", name: "f", kind: "formula" as const, expression: "a + b" },
  ];
  const baseline = scenario("base", "基线", {});
  const warm = scenario("warm", "高参数", { a: "10" });
  const exp: Experiment = {
    id: "exp",
    name: "exp",
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    units,
    results: {},
    executionOrder: [],
    scenarios: { base: baseline, warm },
    scenarioOrder: ["base", "warm"],
    activeScenarioId: "base",
    scenarioResults: {},
    scenarioOrders: {},
    previewResults: {},
    formulaRevision: 1,
    sharedFormulaRevision: 1,
    pendingFormulaChange: null,
  };
  for (const id of exp.scenarioOrder) {
    const run = runGraph(effectiveUnits(units, exp.scenarios[id]));
    exp.scenarioResults[id] = run.results;
    exp.scenarioOrders[id] = run.order;
  }
  return exp;
}

describe("参数情景", () => {
  it("不同参数结果并排保存且互不串用", () => {
    const exp = makeExperiment();
    expect(exp.scenarioResults.base.f.value).toBe(5);
    expect(exp.scenarioResults.warm.f.value).toBe(13);
    expect(exp.scenarioResults.base.f.dependencyIds).toEqual(["a", "b"]);
  });

  it("共享公式修改预览所有情景，并可只接受部分情景", () => {
    const exp = makeExperiment();
    const changed = previewFormulaChange({ ...exp, formulaRevision: 2 }, "f", "a + b", "a * b");
    expect(changed.previewResults.base.f.value).toBe(6);
    expect(changed.previewResults.warm.f.value).toBe(30);
    expect(changed.scenarioResults.base.f.value).toBe(5);
    expect(changed.scenarioResults.warm.f.value).toBe(13);

    const acceptedBase = acceptScenarioPreview(changed, "base");
    expect(acceptedBase.scenarioResults.base.f.value).toBe(6);
    expect(acceptedBase.scenarioResults.warm.f.value).toBe(13);
    expect(acceptedBase.previewResults.warm.f.value).toBe(30);

    const rejectedWarm = rejectScenarioPreview(acceptedBase, "warm");
    expect(rejectedWarm.scenarioResults.base.f.value).toBe(6);
    expect(rejectedWarm.scenarioResults.warm.f.value).toBe(13);
    expect(rejectedWarm.pendingFormulaChange).toBeNull();
  });
});
