import { beforeEach, describe, expect, it } from "vitest";
import type { ComputeUnit, Experiment, Scenario } from "./types";
import { compareConstraintSchemes, compareScenarios, computeScenarioRanges } from "./uncertainty";
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

describe("联合约束下的范围收紧", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebook.setState({ experiments: {}, rootId: null, activeId: null });
  });

  it("线性关系收紧边界：单变量极值不能拼成违反联合约束的伪边界", () => {
    const { exp, sc } = makeExp([
      input("a", "a", "0"),
      input("b", "b", "0"),
      formula("f", "f", "a + b"),
      formula("g", "g", "a - b"),
    ]);
    const vals = [...Array(11).keys()];
    sc.inputConstraints = {
      a: { kind: "candidates", values: vals },
      b: { kind: "candidates", values: vals },
    };
    sc.constraintSchemes = [{
      id: "s1",
      name: "和上限",
      linear: [{ id: "l1", terms: [{ unitId: "a", coef: 1 }, { unitId: "b", coef: 1 }], op: "<=", rhs: 5 }],
      piecewise: [],
    }];
    sc.adoptedSchemeId = "s1";

    const { ranges, infeasible, schemeName } = computeScenarioRanges(exp, sc.id);
    expect(schemeName).toBe("和上限");
    expect(infeasible).toBeGreaterThan(0);
    // 不采用方案时上界是 20（a=10,b=10）；该组合违反 a+b<=5，不能拼成伪边界。
    const free = computeScenarioRanges(exp, sc.id, "accepted", { scheme: null });
    expect(free.ranges.f.max).toBe(20);
    expect(ranges.f.status).toBe("proven");
    expect(ranges.f.min).toBe(0);
    expect(ranges.f.max).toBe(5);
    // 边界证据是完整且可行的输入组合：覆盖全部相关输入并满足线性关系。
    const wf = ranges.f.maxWitness!;
    expect(Object.keys(wf).sort()).toEqual(["a", "b"]);
    expect(wf.a + wf.b).toBeLessThanOrEqual(5);
    expect(wf.a + wf.b).toBe(5);
    expect(ranges.g.max).toBe(5);
    const wg = ranges.g.maxWitness!;
    expect(wg.a + wg.b).toBeLessThanOrEqual(5);
    expect(wg.a - wg.b).toBe(5);
  });

  it("分段取值条件：可取值随其他输入分段变化，被排除的组合不计入边界", () => {
    const { exp, sc } = makeExp([
      input("x", "x", "0"),
      input("b", "b", "0"),
      formula("f", "f", "x * 2"),
    ]);
    sc.inputConstraints = {
      x: { kind: "candidates", values: [1, 2, 10] },
      b: { kind: "candidates", values: [1, 3] },
    };
    sc.constraintSchemes = [{
      id: "s1",
      name: "分段",
      linear: [],
      piecewise: [{
        unitId: "x",
        clauses: [
          { when: { unitId: "b", op: ">=", value: 2 }, values: [10] },
          { values: [1, 2] },
        ],
      }],
    }];
    sc.adoptedSchemeId = "s1";

    const { ranges, infeasible } = computeScenarioRanges(exp, sc.id);
    // 6 个组合中 x=10,b=1 与 x∈{1,2},b=3 共 3 个被分段条件排除。
    expect(infeasible).toBe(3);
    expect(ranges.f.status).toBe("proven");
    expect(ranges.f.min).toBe(2);
    expect(ranges.f.max).toBe(20);
    expect(ranges.f.maxWitness).toEqual({ x: 10, b: 3 });
    expect(ranges.f.minWitness).toEqual({ x: 1, b: 1 });
  });

  it("不可行约束：无可行组合时无法判断并给出原因，不给出伪边界", () => {
    const { exp, sc } = makeExp([
      input("a", "a", "0"),
      input("b", "b", "0"),
      formula("f", "f", "a + b"),
    ]);
    sc.inputConstraints = {
      a: { kind: "candidates", values: [0, 1] },
      b: { kind: "candidates", values: [0, 1] },
    };
    sc.constraintSchemes = [{
      id: "s1",
      name: "矛盾",
      linear: [{ id: "l1", terms: [{ unitId: "a", coef: 1 }, { unitId: "b", coef: 1 }], op: "<=", rhs: -1 }],
      piecewise: [],
    }];
    sc.adoptedSchemeId = "s1";

    const { ranges, infeasible } = computeScenarioRanges(exp, sc.id);
    expect(infeasible).toBe(4);
    for (const id of ["a", "b", "f"]) {
      expect(ranges[id].status).toBe("indeterminate");
      expect(ranges[id].reason).toContain("无可行组合");
      expect(ranges[id].min).toBeUndefined();
    }
  });

  it("跨零分母：经过零点的区间只能记为可能并保留除零原因；方案排除零点后方可证实", () => {
    const { exp, sc } = makeExp([input("x", "x", "0"), formula("f", "f", "10 / x")]);
    sc.inputConstraints = { x: { kind: "interval", min: -1, max: 1, samples: 3 } };
    const crossed = computeScenarioRanges(exp, sc.id);
    expect(crossed.ranges.f.status).toBe("possible");
    expect(crossed.ranges.f.failed).toBe(1);
    expect(crossed.ranges.f.failureReasons?.join()).toContain("除数为零");

    // 同一公式在候选集 + 线性关系 x>=1 下排除零点，边界可证实且证据可行。
    sc.inputConstraints = { x: { kind: "candidates", values: [-1, 0, 1] } };
    sc.constraintSchemes = [{
      id: "s1",
      name: "远离零点",
      linear: [{ id: "l1", terms: [{ unitId: "x", coef: 1 }], op: ">=", rhs: 1 }],
      piecewise: [],
    }];
    sc.adoptedSchemeId = "s1";
    const { ranges, infeasible } = computeScenarioRanges(exp, sc.id);
    expect(infeasible).toBe(2);
    expect(ranges.f.status).toBe("proven");
    expect(ranges.f.min).toBe(10);
    expect(ranges.f.max).toBe(10);
    expect(ranges.f.failed).toBe(0);
    expect(ranges.f.maxWitness).toEqual({ x: 1 });
  });

  it("搜索预算不足：枚举被截断时只能记为可能，不能称为完整边界", () => {
    const { exp, sc } = makeExp([
      input("x", "x", "0"),
      input("y", "y", "0"),
      input("z", "z", "0"),
      formula("f", "f", "x + y + z"),
    ]);
    const vals = [...Array(30).keys()];
    sc.inputConstraints = {
      x: { kind: "candidates", values: vals },
      y: { kind: "candidates", values: vals },
      z: { kind: "candidates", values: vals },
    };
    const { ranges, truncated, totalCombos } = computeScenarioRanges(exp, sc.id);
    expect(truncated).toBe(true);
    expect(totalCombos).toBe(20000);
    expect(ranges.f.status).toBe("possible");
    expect(ranges.f.status).not.toBe("proven");
  });

  it("无效方案：引用不存在的单元时无法判断并说明原因", () => {
    const { exp, sc } = makeExp([input("a", "a", "1"), formula("f", "f", "a * 2")]);
    sc.constraintSchemes = [{
      id: "s1",
      name: "坏方案",
      linear: [{ id: "l1", terms: [{ unitId: "ghost", coef: 1 }], op: "<=", rhs: 1 }],
      piecewise: [],
    }];
    sc.adoptedSchemeId = "s1";
    const { ranges } = computeScenarioRanges(exp, sc.id);
    expect(ranges.f.status).toBe("indeterminate");
    expect(ranges.f.reason).toContain("无效");
    expect(ranges.f.reason).toContain("不存在");
  });

  it("方案比较与采用：各方案独立重算，采用只影响当前情景，保存重开后保持一致", () => {
    const store = () => useNotebook.getState();
    store().hydrate();
    const expId = store().createExperiment("方案实验");
    const a = store().addUnit("input")!;
    const b = store().addUnit("input")!;
    const f = store().addUnit("formula")!;
    const names = () => Object.fromEntries(store().active()!.units.map((u) => [u.id, u.name]));
    store().updateUnit(f, { expression: names()[a] + " + " + names()[b] });
    store().acceptAllScenarioUpdates();
    store().setInputConstraint(a, { kind: "candidates", values: [0, 5, 10] });
    store().setInputConstraint(b, { kind: "candidates", values: [0, 5, 10] });

    const mk = (id: string, rhs: number) => ({
      id,
      name: "和<=" + rhs,
      linear: [{ id: id + "l", terms: [{ unitId: a, coef: 1 }, { unitId: b, coef: 1 }], op: "<=" as const, rhs }],
      piecewise: [],
    });
    store().setConstraintSchemes([mk("s1", 5), mk("s2", 15)]);
    const scId = store().active()!.activeScenarioId!;

    // 比较：不采用 / s1 / s2 三行各自独立重算。
    const rows = compareConstraintSchemes(store().active()!, scId);
    expect(rows).toHaveLength(3);
    expect(rows[0].schemeId).toBeNull();
    expect(rows[0].result.ranges[f].max).toBe(20);
    expect(rows[1].result.ranges[f].max).toBe(5);
    expect(rows[2].result.ranges[f].max).toBe(15);
    expect(rows.every((r) => r.result.ranges[f].status === "proven")).toBe(true);

    // 明确采用 s1：当前情景范围收紧；报告快照记录所采用方案。
    store().adoptConstraintScheme("s1");
    expect(computeScenarioRanges(store().active()!, scId).ranges[f].max).toBe(5);
    store().saveRangeReport("accepted");
    expect(store().active()!.reports![0].adoptedScheme?.name).toBe("和<=5");

    // 派生情景继承方案，但之后的采用各自独立：新情景取消采用不影响原情景。
    const otherId = store().addScenario("对照情景")!;
    expect(computeScenarioRanges(store().active()!, otherId).ranges[f].max).toBe(5);
    store().adoptConstraintScheme(null);
    expect(computeScenarioRanges(store().active()!, otherId).ranges[f].max).toBe(20);
    expect(computeScenarioRanges(store().active()!, scId).ranges[f].max).toBe(5);

    // 保存重开后采用关系与范围保持一致。
    const reloaded = loadNotebook();
    const reExp = reloaded.experiments[expId];
    expect(computeScenarioRanges(reExp, scId).ranges[f].max).toBe(5);
    expect(computeScenarioRanges(reExp, otherId).ranges[f].max).toBe(20);
    expect(reExp.reports![0].adoptedScheme?.id).toBe("s1");
  });
});
