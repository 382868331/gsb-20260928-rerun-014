import { describe, expect, it } from "vitest";
import { analyzeScenarioRanges } from "./ranges";
import { recordFormulaHistory, makeScenario } from "./storage";
import type { ComputeUnit, Experiment, Scenario } from "./types";

function makeExperiment(units: ComputeUnit[], sc: Scenario): Experiment {
  const now = 1;
  const exp: Experiment = {
    id: "exp",
    name: "E",
    parentId: null,
    createdAt: now,
    updatedAt: now,
    units,
    scenarios: { [sc.id]: sc },
    scenarioOrder: [sc.id],
    activeScenarioId: sc.id,
    resultStore: {},
    formulaHistory: {},
  };
  for (const unit of units) {
    if (unit.kind === "formula") {
      sc.acceptedFormulaVersions[unit.id] = unit.version;
      recordFormulaHistory(exp, unit.id, unit.version, unit.expression ?? "");
    }
  }
  return exp;
}

const input = (id: string, value = "0"): ComputeUnit => ({ id, name: id, kind: "input", value, version: 1 });
const formula = (id: string, expression: string, version = 1): ComputeUnit => ({ id, name: id, kind: "formula", expression, version });

describe("情景范围分析", () => {
  it("有限联合输入穷举真实组合并保留导致边界的输入", () => {
    const sc = makeScenario("s", {}, null, 1);
    sc.inputConstraints = {
      a: { mode: "finite", text: "1,2" },
      b: { mode: "finite", text: "3,4" },
    };
    sc.jointObservations = [
      { id: "o1", name: "o1", values: { a: "1", b: "4" } },
      { id: "o2", name: "o2", values: { a: "2", b: "3" } },
    ];
    const exp = makeExperiment([input("a"), input("b"), formula("y", "a + b")], sc);
    const result = analyzeScenarioRanges(exp, sc);
    expect(result.ranges.y.status).toBe("proven");
    expect([result.ranges.y.min, result.ranges.y.max]).toEqual([5, 5]);
    expect(result.ranges.y.minWorld?.values).toMatchObject({ a: 1, b: 4 });
    expect(result.worlds).toHaveLength(2);
  });

  it("区间输入报告可能范围，并展示端点组合", () => {
    const sc = makeScenario("s", {}, null, 1);
    sc.inputConstraints = { a: { mode: "interval", text: "1..3" } };
    const exp = makeExperiment([input("a"), formula("y", "a * 2")], sc);
    const result = analyzeScenarioRanges(exp, sc);
    expect(result.ranges.y.status).toBe("possible");
    expect([result.ranges.y.min, result.ranges.y.max]).toEqual([2, 6]);
    expect(result.ranges.y.minWorld?.values.a).toBe(1);
  });

  it("多个独立不确定输入缺少联合关系时不能给出已证实边界", () => {
    const sc = makeScenario("s", {}, null, 1);
    sc.inputConstraints = {
      a: { mode: "finite", text: "1,2" },
      b: { mode: "finite", text: "3,4" },
    };
    const exp = makeExperiment([input("a"), input("b"), formula("y", "a + b")], sc);
    const result = analyzeScenarioRanges(exp, sc);
    expect(result.ranges.y.status).toBe("possible");
    expect(result.ranges.y.unknownKinds).toContain("relation");
    expect(result.globalReasons.join(";")).toContain("缺少联合关系");
  });

  it("除零作为无法判断原因，不吞掉其他可计算样本", () => {
    const sc = makeScenario("s", {}, null, 1);
    sc.inputConstraints = { z: { mode: "finite", text: "0,2" } };
    const exp = makeExperiment([input("a", "4"), input("z"), formula("y", "a / z")], sc);
    const result = analyzeScenarioRanges(exp, sc);
    expect(result.ranges.y.status).toBe("possible");
    expect(result.ranges.y.max).toBe(2);
    expect(result.ranges.y.unknownKinds).toContain("division");
  });

  it("只影响预览版本的循环不会污染已接受基线的范围", () => {
    const sc = makeScenario("s", {}, null, 1);
    const y = formula("y", "a + 1", 1);
    const z = formula("z", "a", 1);
    const exp = makeExperiment([input("a", "1"), y, z], sc);
    y.expression = "z + 1";
    y.version = 2;
    z.expression = "y + 2";
    z.version = 2;
    recordFormulaHistory(exp, y.id, 2, y.expression);
    recordFormulaHistory(exp, z.id, 2, z.expression);
    sc.pendingFormulaVersions = { y: 2, z: 2 };
    const accepted = analyzeScenarioRanges(exp, sc, "accepted");
    const pending = analyzeScenarioRanges(exp, sc, "pending");
    expect(accepted.ranges.y.status).toBe("proven");
    expect(pending.ranges.y.status).toBe("unknown");
    expect(pending.ranges.y.unknownKinds).toContain("cycle");
  });
});
