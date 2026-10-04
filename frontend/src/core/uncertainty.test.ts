import { beforeEach, describe, expect, it } from "vitest";
import type { ComputeUnit, Experiment, Scenario } from "./types";
import { compareScenarios, computeScenarioRanges } from "./uncertainty";
import { loadNotebook, makeScenario, recordFormulaHistory, saveNotebook, STORAGE_KEY } from "./storage";
import { useNotebook } from "../store/useNotebook";

function input(id: string, name: string, value: string): ComputeUnit {
  return { id, name, kind: "input", value, version: 1 };
}
function formula(id: string, name: string, expression: string, version = 1): ComputeUnit {
  return { id, name, kind: "formula", expression, version };
}

function makeExp(units: ComputeUnit[]): { exp: Experiment; sc: Scenario } {
  const sc = makeScenario("S1", {}, null, 1);
  const exp: Experiment = {
    id: "e1",
    name: "实验",
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    units,
    scenarios: { [sc.id]: sc },
    scenarioOrder: [sc.id],
    activeScenarioId: sc.id,
    resultStore: {},
    formulaHistory: {},
  };
  for (const u of units) {
    if (u.kind === "formula") {
      sc.acceptedFormulaVersions[u.id] = u.version;
      recordFormulaHistory(exp, u.id, u.version, u.expression ?? "");
    }
  }
  return { exp, sc };
}

describe("可枚举联合输入", () => {
  it("联合观测按行整体取值，不拼出不存在的组合，范围为已证实且给出真实组合", () => {
    const { exp, sc } = makeExp([
      input("a", "a", "0"),
      input("b", "b", "0"),
      formula("f", "f", "a + b"),
      formula("g", "g", "a - b"),
    ]);
    sc.jointGroups = [{ id: "j1", unitIds: ["a", "b"], rows: [[1, 2], [3, 4]] }];

    const { ranges, totalCombos, truncated } = computeScenarioRanges(exp, sc.id);
    expect(totalCombos).toBe(2);
    expect(truncated).toBe(false);
    expect(ranges.f.status).toBe("proven");
    expect(ranges.f.min).toBe(3);
    expect(ranges.f.max).toBe(7);
    expect(ranges.f.minWitness).toEqual({ a: 1, b: 2 });
    expect(ranges.f.maxWitness).toEqual({ a: 3, b: 4 });
    // 若任意拼接会出现 a=1,b=4 -> -3；联合约束下只能取 -1。
    expect(ranges.g.min).toBe(-1);
    expect(ranges.g.max).toBe(-1);
  });

  it("缺少联合观测数据时相关单元无法判断", () => {
    const { exp, sc } = makeExp([
      input("a", "a", "0"),
      input("b", "b", "0"),
      formula("f", "f", "a + b"),
    ]);
    sc.jointGroups = [{ id: "j1", unitIds: ["a", "b"], rows: [] }];
    const { ranges } = computeScenarioRanges(exp, sc.id);
    expect(ranges.a.status).toBe("indeterminate");
    expect(ranges.a.reason).toContain("联合观测");
    expect(ranges.f.status).toBe("indeterminate");
    expect(ranges.f.reason).toContain("无法判断");
  });
});

describe("区间输入", () => {
  it("区间按采样点估计，范围记为可能并给出边界组合", () => {
    const { exp, sc } = makeExp([input("x", "x", "0"), formula("f", "f", "x * 2")]);
    sc.inputConstraints = { x: { kind: "interval", min: 0, max: 10, samples: 5 } };
    const { ranges, totalCombos } = computeScenarioRanges(exp, sc.id);
    expect(totalCombos).toBe(5);
    expect(ranges.f.status).toBe("possible");
    expect(ranges.f.min).toBe(0);
    expect(ranges.f.max).toBe(20);
    expect(ranges.f.maxWitness).toEqual({ x: 10 });
  });
});

describe("求值失败与循环", () => {
  it("部分组合除零：范围按成功组合给出，失败组合单独计数", () => {
    const { exp, sc } = makeExp([input("x", "x", "0"), formula("f", "f", "10 / x")]);
    sc.inputConstraints = { x: { kind: "candidates", values: [-1, 0, 2] } };
    const { ranges } = computeScenarioRanges(exp, sc.id);
    expect(ranges.f.status).toBe("proven");
    expect(ranges.f.min).toBe(-10);
    expect(ranges.f.max).toBe(5);
    expect(ranges.f.failed).toBe(1);
    expect(ranges.f.failureReasons?.join()).toContain("除数为零");
  });

  it("全部组合除零时无法判断", () => {
    const { exp, sc } = makeExp([input("x", "x", "0"), formula("f", "f", "10 / x")]);
    sc.inputConstraints = { x: { kind: "candidates", values: [0] } };
    const { ranges } = computeScenarioRanges(exp, sc.id);
    expect(ranges.f.status).toBe("indeterminate");
    expect(ranges.f.reason).toContain("除数为零");
  });

  it("只影响新版本的引用环：基线已证实，预览无法判断", () => {
    const units = [formula("p", "p", "q + 1"), formula("q", "q", "1")];
    const { exp, sc } = makeExp(units);
    // 公式 q 改版为 p + 1（v2），与 p 形成环；情景尚未接受。
    exp.units = units.map((u) => (u.id === "q" ? { ...u, version: 2, expression: "p + 1" } : u));
    recordFormulaHistory(exp, "q", 2, "p + 1");
    sc.pendingFormulaVersions = { q: 2 };

    const accepted = computeScenarioRanges(exp, sc.id, "accepted");
    expect(accepted.ranges.p.status).toBe("proven");
    expect(accepted.ranges.p.min).toBe(2);

    const pending = computeScenarioRanges(exp, sc.id, "pending");
    expect(pending.ranges.p.status).toBe("indeterminate");
    expect(pending.ranges.p.reason).toContain("引用环");
    expect(pending.ranges.q.status).toBe("indeterminate");
  });
});

describe("情景比较归因", () => {
  it("公式一致而输入约束不同：差异来自参数不确定性，按范围比较", () => {
    const { exp, sc } = makeExp([input("x", "x", "1"), formula("f", "f", "x * 2")]);
    const sc2 = makeScenario("S2", {}, sc.id, 2);
    sc2.acceptedFormulaVersions = { f: 1 };
    sc2.inputConstraints = { x: { kind: "candidates", values: [1, 2] } };
    exp.scenarios[sc2.id] = sc2;
    exp.scenarioOrder.push(sc2.id);

    const [cmp] = compareScenarios(exp, sc.id, sc2.id);
    expect(cmp.attribution).toBe("参数不确定性");
    expect(cmp.a?.min).toBe(2);
    expect(cmp.b?.max).toBe(4);
    expect(cmp.overlap).toBe(true);
    expect(cmp.detail).toContain("参数不确定性");
  });

  it("参数一致而公式版本不同：差异来自公式修订", () => {
    const { exp, sc } = makeExp([input("x", "x", "1"), formula("f", "f", "x * 2")]);
    const sc2 = makeScenario("S2", {}, sc.id, 2);
    exp.scenarios[sc2.id] = sc2;
    exp.scenarioOrder.push(sc2.id);
    // f 改版为 x * 3（v2），只有 S2 接受。
    exp.units = exp.units.map((u) => (u.id === "f" ? { ...u, version: 2, expression: "x * 3" } : u));
    recordFormulaHistory(exp, "f", 2, "x * 3");
    sc2.acceptedFormulaVersions = { f: 2 };
    sc.acceptedFormulaVersions = { f: 1 };

    const [cmp] = compareScenarios(exp, sc.id, sc2.id);
    expect(cmp.attribution).toBe("公式修订");
    expect(cmp.a?.max).toBe(2);
    expect(cmp.b?.max).toBe(3);
    expect(cmp.overlap).toBe(false);
  });
});

describe("接受改版后范围同步失效", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebook.setState({ experiments: {}, rootId: null, activeId: null });
  });

  it("直接引用自身：明确无法判断并向下游传播", () => {
    const { exp, sc } = makeExp([
      input("a", "a", "1"),
      formula("f", "f", "f + a"),
      formula("g", "g", "f * 2"),
    ]);
    const { ranges } = computeScenarioRanges(exp, sc.id);
    expect(ranges.f.status).toBe("indeterminate");
    expect(ranges.f.reason).toContain("引用自身");
    expect(ranges.f.min).toBeUndefined();
    expect(ranges.g.status).toBe("indeterminate");
    expect(ranges.g.reason).toContain("无法判断");
  });

  it("接受形成自引用的公式后：范围与比较同步失效，旧版情景保留有效范围，报告与重开不复活旧区间", () => {
    const store = () => useNotebook.getState();
    store().hydrate();
    const expId = store().createExperiment("环实验");
    const x1 = store().addUnit("input")!;
    const x2 = store().addUnit("input")!;
    const f = store().addUnit("formula")!;
    const names = () => Object.fromEntries(store().active()!.units.map((u) => [u.id, u.name]));
    store().updateUnit(f, { expression: `${names()[x1]} - ${names()[x2]}` });
    store().acceptAllScenarioUpdates();
    store().setJointGroups([{ id: "jg1", unitIds: [x1, x2], rows: [[1, 20], [3, 10]] }]);

    const scId = store().active()!.activeScenarioId!;
    const before = computeScenarioRanges(store().active()!, scId).ranges;
    expect(before[f].status).toBe("proven");
    expect(before[f].min).toBe(-19);
    expect(before[f].max).toBe(-7);

    // 保存历史报告（旧版本快照），再派生一个停留在旧版公式的情景。
    store().saveRangeReport("accepted");
    const otherId = store().addScenario("旧版情景")!;
    store().selectScenario(scId);

    // 改为自引用并仅在当前情景接受。
    store().updateUnit(f, { expression: `${names()[f]} + ${names()[x1]}` });
    store().acceptScenarioUpdate(scId);

    const exp = store().active()!;
    expect(exp.scenarios[scId].results[f].error).toContain("引用自身");
    // 范围表同步失效：明确无法判断及原因，不再显示旧区间。
    const after = computeScenarioRanges(exp, scId).ranges;
    expect(after[f].status).toBe("indeterminate");
    expect(after[f].reason).toContain("引用自身");
    expect(after[f].min).toBeUndefined();
    // 仍采用旧公式的情景继续保留有效范围。
    const other = computeScenarioRanges(exp, otherId).ranges;
    expect(other[f].status).toBe("proven");
    expect(other[f].min).toBe(-19);
    expect(other[f].max).toBe(-7);
    // 情景比较按各情景实际接受的版本计算。
    const [cmp] = compareScenarios(exp, scId, otherId);
    expect(cmp.attribution).toBe("公式修订");
    expect(cmp.detail).toContain("无法判断");
    // 历史报告保持原样并标清原版本。
    const report = exp.reports![0];
    expect(report.formulaVersions[f]).toBe(2);
    expect(report.ranges[f].status).toBe("proven");
    expect(report.ranges[f].min).toBe(-19);

    // 保存重开后不能重新显示失效区间。
    const reloaded = loadNotebook();
    const reExp = reloaded.experiments[expId];
    const reRanges = computeScenarioRanges(reExp, scId).ranges;
    expect(reRanges[f].status).toBe("indeterminate");
    expect(reRanges[f].reason).toContain("引用自身");
    const reOther = computeScenarioRanges(reExp, otherId).ranges;
    expect(reOther[f].status).toBe("proven");
    expect(reOther[f].min).toBe(-19);
    expect(reExp.reports![0].ranges[f].status).toBe("proven");
  });

  it("除零与缺少联合观测：无法判断并给出原因，保存重开后不复活旧区间", () => {
    const { exp: expZ, sc: scZ } = makeExp([input("x", "x", "0"), formula("f", "f", "10 / x")]);
    scZ.inputConstraints = { x: { kind: "candidates", values: [0] } };
    const { exp: expJ, sc: scJ } = makeExp([
      input("a", "a", "0"),
      input("b", "b", "0"),
      formula("g", "g", "a + b"),
    ]);
    scJ.jointGroups = [{ id: "j1", unitIds: ["a", "b"], rows: [] }];
    expJ.id = "e2";

    saveNotebook({ experiments: { [expZ.id]: expZ, [expJ.id]: expJ }, rootId: expZ.id, activeId: expZ.id });
    const loaded = loadNotebook();
    const lz = computeScenarioRanges(loaded.experiments[expZ.id], scZ.id).ranges;
    expect(lz.f.status).toBe("indeterminate");
    expect(lz.f.reason).toContain("除数为零");
    const lj = computeScenarioRanges(loaded.experiments[expJ.id], scJ.id).ranges;
    expect(lj.g.status).toBe("indeterminate");
    expect(lj.g.reason).toContain("无法判断");
  });
});

describe("派生继承与持久化", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebook.setState({ experiments: {}, rootId: null, activeId: null });
  });

  it("派生情景继承当时的输入约束与公式基线；保存重开后旧报告仍按原约束与版本解释", () => {
    const store = () => useNotebook.getState();
    store().hydrate();
    const expId = store().createExperiment("范围实验");
    const inputId = store().addUnit("input")!;
    const formulaId = store().addUnit("formula")!;
    const inputName = store().active()!.units.find((u) => u.id === inputId)!.name;
    store().updateUnit(formulaId, { expression: inputName + " * 2" });
    store().acceptAllScenarioUpdates();
    store().setInputConstraint(inputId, { kind: "candidates", values: [1, 2] });
    store().setJointGroups([{ id: "jg1", unitIds: [inputId], rows: [[1], [2]] }]);

    const derivedId = store().addScenario("派生情景")!;
    const derived = store().active()!.scenarios[derivedId];
    expect(derived.inputConstraints?.[inputId]).toEqual({ kind: "candidates", values: [1, 2] });
    expect(derived.jointGroups).toHaveLength(1);
    expect(derived.acceptedFormulaVersions[formulaId]).toBe(2);

    // 公式再次改版：派生情景只生成预览，基线不变。
    store().updateUnit(formulaId, { expression: inputName + " * 5" });
    const after = store().active()!.scenarios[derivedId];
    expect(after.acceptedFormulaVersions[formulaId]).toBe(2);
    expect(Object.keys(after.pending).length).toBeGreaterThan(0);

    // 保存基线报告后重开，再继续细化输入范围，旧报告仍按原约束与公式版本解释。
    store().saveRangeReport("accepted");
    store().setInputConstraint(inputId, { kind: "candidates", values: [10, 20] });
    const reloaded = loadNotebook();
    const reExp = reloaded.experiments[expId];
    expect(reExp.reports).toHaveLength(1);
    const report = reExp.reports![0];
    expect(report.formulaVersions[formulaId]).toBe(2);
    expect(report.inputConstraints[inputId]).toEqual({ kind: "candidates", values: [1, 2] });
    expect(report.ranges[formulaId].min).toBe(2);
    expect(report.ranges[formulaId].max).toBe(4);
    // 重开后情景当前约束是细化后的新值，与报告快照互不影响。
    expect(reExp.scenarios[derivedId].inputConstraints?.[inputId]).toEqual({ kind: "candidates", values: [10, 20] });
  });

  it("缺少新字段的旧存档重开后自动补默认值", () => {
    const { exp, sc } = makeExp([input("x", "x", "1"), formula("f", "f", "x * 2")]);
    const raw = JSON.parse(JSON.stringify({ experiments: { [exp.id]: exp }, rootId: exp.id, activeId: exp.id }));
    delete raw.experiments[exp.id].scenarios[sc.id].inputConstraints;
    delete raw.experiments[exp.id].scenarios[sc.id].jointGroups;
    delete raw.experiments[exp.id].reports;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    const loaded = loadNotebook();
    const loadedSc = loaded.experiments[exp.id].scenarios[sc.id];
    expect(loadedSc.inputConstraints).toEqual({});
    expect(loadedSc.jointGroups).toEqual([]);
    expect(loaded.experiments[exp.id].reports).toEqual([]);
    saveNotebook(loaded);
  });
});
