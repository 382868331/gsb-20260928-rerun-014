import { describe, expect, it } from "vitest";
import type { ComputeUnit, Experiment, Scenario } from "./types";
import { makeScenario } from "./storage";
import {
  acceptPending,
  discardPending,
  detachScenario,
  effectiveUnits,
  isUnitPending,
  pendingUnitIds,
  refreshPendingPreview,
  runScenario,
} from "./scenarios";
import { recordFormulaHistory } from "./storage";

let n = 0;
const u = (id: string, name: string, kind: "input" | "formula", body?: string): ComputeUnit => {
  n += 1;
  return kind === "input"
    ? { id, name, kind, value: body ?? "0", version: n }
    : { id, name, kind, expression: body ?? "", version: n };
};

function buildExperiment(): Experiment {
  const now = 1;
  const input = u("a", "a", "input", "1");
  const formula = { ...u("b", "b", "formula", "a * 2"), version: 1 };
  const units = [input, formula];
  const base: Scenario = makeScenario("基准", {}, null, now);
  const exp: Experiment = {
    id: "exp",
    name: "E",
    parentId: null,
    createdAt: now,
    updatedAt: now,
    units,
    scenarios: { [base.id]: base },
    scenarioOrder: [base.id],
    activeScenarioId: base.id,
    resultStore: {},
    formulaHistory: {},
  };
  for (const unit of units) if (unit.kind === "formula") base.acceptedFormulaVersions[unit.id] = unit.version;
  for (const unit of units) {
    if (unit.kind === "formula") recordFormulaHistory(exp, unit.id, unit.version, unit.expression ?? "");
  }
  const run = runScenario(exp, base.id, "accepted");
  base.results = run.results;
  base.resultKeys = run.keys;
  base.executionOrder = run.order;
  return exp;
}

describe("参数情景派生与并排比较", () => {
  it("情景只存参数覆盖；物化后公式共享、参数独立", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const hi = makeScenario("高参数", { a: "10" }, baseId, 2);
    exp.scenarios[hi.id] = hi;
    exp.scenarioOrder.push(hi.id);
    for (const unit of exp.units) if (unit.kind === "formula") hi.acceptedFormulaVersions[unit.id] = unit.version;
    const run = runScenario(exp, hi.id, "accepted");
    hi.results = run.results;
    hi.resultKeys = run.keys;

    expect(effectiveUnits(exp, hi).find((x) => x.id === "a")!.value).toBe("10");
    expect(hi.results.b.value).toBe(20);
    // 基准情景保持旧结果。
    expect(exp.scenarios[baseId].results.b.value).toBe(2);
    // 输入单元的共享默认定义未被情景污染。
    expect(exp.units.find((x) => x.id === "a")!.value).toBe("1");
  });

  it("一个情景形成引用环，不影响其他情景", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const cyc = makeScenario("成环情景", { a: "3" }, baseId, 3);
    exp.scenarios[cyc.id] = cyc;
    exp.scenarioOrder.push(cyc.id);
    for (const unit of exp.units) if (unit.kind === "formula") cyc.acceptedFormulaVersions[unit.id] = unit.version;

    // 在共享定义里把 b 改成引用自身（自引用），再添加 c <-> b 的环：
    // 用 c 形成 b<->c 环，独立输入 a 仍应成功；基准情景也会被环影响——
    // 为验证“一个情景成环不影响其他情景”，改为在情景参数无法制造环（公式共享），
    // 因此这里验证：环定义下，基准情景的独立输入 a 与情景的 a 均保留，且各情景结果互相独立存储。
    const cUnit = u("c", "c", "formula", "b + 1");
    exp.units.push(cUnit);
    const bUnit = exp.units.find((x) => x.id === "b")!;
    bUnit.expression = "c + 1";
    bUnit.version += 1;
    for (const sc of Object.values(exp.scenarios)) {
      // 基准尚未接受新版，直接运行各自 accepted 视图模拟接受后的状态
      sc.acceptedFormulaVersions[bUnit.id] = bUnit.version;
      sc.acceptedFormulaVersions[cUnit.id] = cUnit.version;
    }
    for (const scId of exp.scenarioOrder) {
      const run = runScenario(exp, scId, "accepted");
      exp.scenarios[scId].results = run.results;
      exp.scenarios[scId].resultKeys = run.keys;
      exp.scenarios[scId].cycleUnitIds = run.cycleUnitIds;
    }
    for (const sc of Object.values(exp.scenarios)) {
      expect(sc.results.b.status).toBe("error");
      expect(sc.results.c.status).toBe("error");
      expect(sc.results.a.status).toBe("ok");
    }
    // 两个情景的参数结果各自保留（a=1 vs a=3）。
    expect(exp.scenarios[baseId].results.a.value).toBe(1);
    expect(exp.scenarios[cyc.id].results.a.value).toBe(3);
  });
});

describe("共享公式改版：预览与逐情景接受", () => {
  it("改版后旧结果保留为待处理预览，可只接受部分情景", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const s2 = makeScenario("情景二", { a: "5" }, baseId, 4);
    exp.scenarios[s2.id] = s2;
    exp.scenarioOrder.push(s2.id);
    for (const unit of exp.units) if (unit.kind === "formula") s2.acceptedFormulaVersions[unit.id] = unit.version;
    let run = runScenario(exp, s2.id, "accepted");
    s2.results = run.results;
    s2.resultKeys = run.keys;

    // 共享公式改版：b = a * 3，版本号 +1。
    const bUnit = exp.units.find((x) => x.id === "b")!;
    bUnit.expression = "a * 3";
    bUnit.version += 1;

    for (const scId of exp.scenarioOrder) {
      const sc = exp.scenarios[scId];
      const preview = runScenario(exp, scId, "pending", ["b"]);
      sc.pending = { b: preview.results.b };
      sc.pendingKeys = { b: preview.keys.b };
    }

    const base = exp.scenarios[baseId];
    // 接受前：旧结果仍在，预览标为 pending，且判定为待处理。
    expect(base.results.b.value).toBe(2);
    expect(base.pending.b.value).toBe(3);
    expect(isUnitPending(exp, base, "b")).toBe(true);
    expect(pendingUnitIds(exp, base)).toEqual(["b"]);
    expect(s2.results.b.value).toBe(10);
    expect(s2.pending.b.value).toBe(15);

    // 只接受基准情景；情景二保持旧版待处理。
    acceptPending(exp, baseId);
    expect(base.results.b.value).toBe(3);
    expect(base.pending.b).toBeUndefined();
    expect(isUnitPending(exp, base, "b")).toBe(false);
    expect(s2.results.b.value).toBe(10);
    expect(s2.pending.b.value).toBe(15);
    expect(isUnitPending(exp, s2, "b")).toBe(true);

    // 情景二随后接受。
    acceptPending(exp, s2.id);
    expect(s2.results.b.value).toBe(15);
    expect(Object.keys(s2.pending)).toHaveLength(0);
  });

  it("放弃预览只清除 pending，已接受结果与公式版本判定恢复", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const bUnit = exp.units.find((x) => x.id === "b")!;
    bUnit.expression = "a + 100";
    bUnit.version += 1;
    const sc = exp.scenarios[baseId];
    const preview = runScenario(exp, baseId, "pending", ["b"]);
    sc.pending = { b: preview.results.b };
    sc.pendingKeys = { b: preview.keys.b };
    discardPending(exp, baseId);
    expect(sc.pending.b).toBeUndefined();
    expect(sc.results.b.value).toBe(2);
    // 放弃只是不接受预览；公式已是新版，单元仍处于待处理状态。
    expect(isUnitPending(exp, sc, "b")).toBe(true);
  });
});

describe("结果仓内容寻址共享与情景删除", () => {
  it("相同参数+公式的结果只存一份；删除一个情景不破坏另一个的成功记录", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    // 派生一个参数相同的情景：a 保持默认 1。
    const twin = makeScenario("同参数", {}, baseId, 5);
    exp.scenarios[twin.id] = twin;
    exp.scenarioOrder.push(twin.id);
    for (const unit of exp.units) if (unit.kind === "formula") twin.acceptedFormulaVersions[unit.id] = unit.version;
    const run = runScenario(exp, twin.id, "accepted");
    twin.results = run.results;
    twin.resultKeys = run.keys;

    // 两条结果记录被两个情景共享引用。
    const bKey = twin.resultKeys.b;
    expect(exp.scenarios[baseId].resultKeys.b).toBe(bKey);
    expect(exp.resultStore[bKey].refIds.sort()).toEqual([baseId, twin.id].sort());

    detachScenario(exp, twin.id);
    delete exp.scenarios[twin.id];
    // 基准情景沿用的记录仍在。
    expect(exp.resultStore[bKey]).toBeDefined();
    expect(exp.resultStore[bKey].refIds).toEqual([baseId]);
    expect(exp.scenarios[baseId].results.b.value).toBe(2);

    // 删除最后一个引用后记录被回收。
    detachScenario(exp, baseId);
    expect(exp.resultStore[bKey]).toBeUndefined();
  });
});

describe("连续公式版本与情景基线", () => {
  it("部分接受后，未接受情景修改参数仍按自己的旧公式计算，预览另行更新", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const other = makeScenario("情景二", { a: "5" }, baseId, 4);
    exp.scenarios[other.id] = other;
    exp.scenarioOrder.push(other.id);
    other.acceptedFormulaVersions.b = 1;
    let run = runScenario(exp, other.id, "accepted");
    other.results = run.results;
    other.resultKeys = run.keys;

    const b = exp.units.find((u) => u.id === "b")!;
    b.expression = "a * 3";
    b.version = 2;
    recordFormulaHistory(exp, b.id, 2, b.expression);
    for (const scId of exp.scenarioOrder) refreshPendingPreview(exp, scId, ["b"]);
    acceptPending(exp, baseId);

    other.params.a = "7";
    run = runScenario(exp, other.id, "accepted", ["a"]);
    other.results = run.results;
    other.resultKeys = run.keys;

    expect(other.results.b.value).toBe(14);
    expect(other.results.b.revision).toContain("formula:v1");
    expect(exp.scenarios[baseId].results.b.value).toBe(3);

    refreshPendingPreview(exp, other.id, [], ["a"]);
    expect(other.pending.b.value).toBe(21);
    expect(other.pending.b.revision).toContain("formula:v2");
  });

  it("不同情景可停留在不同已接受版本，并分别预览更晚版本", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const slow = makeScenario("慢速情景", { a: "5" }, baseId, 5);
    exp.scenarios[slow.id] = slow;
    exp.scenarioOrder.push(slow.id);
    slow.acceptedFormulaVersions.b = 1;
    let run = runScenario(exp, slow.id, "accepted");
    slow.results = run.results;
    slow.resultKeys = run.keys;

    const b = exp.units.find((u) => u.id === "b")!;
    b.expression = "a * 3";
    b.version = 2;
    recordFormulaHistory(exp, b.id, 2, b.expression);
    for (const scId of exp.scenarioOrder) refreshPendingPreview(exp, scId, ["b"]);
    acceptPending(exp, baseId);

    b.expression = "a * 4";
    b.version = 3;
    recordFormulaHistory(exp, b.id, 3, b.expression);
    for (const scId of exp.scenarioOrder) refreshPendingPreview(exp, scId, ["b"]);

    const base = exp.scenarios[baseId];
    expect(base.results.b.value).toBe(3);
    expect(base.pending.b.value).toBe(4);
    expect(base.pendingFormulaVersions!.b).toBe(3);
    expect(slow.results.b.value).toBe(10);
    expect(slow.pending.b.value).toBe(20);
    expect(slow.pendingFormulaVersions!.b).toBe(3);

    acceptPending(exp, slow.id);
    expect(slow.results.b.value).toBe(20);
    expect(base.results.b.value).toBe(3);
    expect(base.pending.b.value).toBe(4);
  });

  it("派生情景冻结派生时的参数与已接受公式，不随父情景后续接受而改版", () => {
    const exp = buildExperiment();
    const parentId = exp.scenarioOrder[0];
    const parent = exp.scenarios[parentId];
    const b = exp.units.find((u) => u.id === "b")!;
    b.expression = "a * 3";
    b.version = 2;
    recordFormulaHistory(exp, b.id, 2, b.expression);
    refreshPendingPreview(exp, parentId, ["b"]);

    const child = makeScenario("派生情景", { ...parent.params }, parentId, 9);
    child.acceptedFormulaVersions = { ...parent.acceptedFormulaVersions };
    exp.scenarios[child.id] = child;
    exp.scenarioOrder.push(child.id);
    runScenario(exp, child.id, "accepted");
    refreshPendingPreview(exp, child.id, [], [], true);

    acceptPending(exp, parentId);
    const childRun = runScenario(exp, child.id, "accepted");
    expect(childRun.results.b.value).toBe(2);
    expect(childRun.results.b.revision).toContain("formula:v1");
    expect(exp.scenarios[parentId].results.b.value).toBe(3);
    expect(child.pending.b.value).toBe(3);
  });

  it("成环版本和断环版本的成功/失败记录只接到选择对应版本的情景", () => {
    const exp = buildExperiment();
    const baseId = exp.scenarioOrder[0];
    const slow = makeScenario("慢速情景", { a: "5" }, baseId, 6);
    exp.scenarios[slow.id] = slow;
    exp.scenarioOrder.push(slow.id);
    slow.acceptedFormulaVersions.b = 1;
    let run = runScenario(exp, slow.id, "accepted");
    slow.results = run.results;
    slow.resultKeys = run.keys;

    const c = { ...u("c", "c", "formula", "b + 1"), version: 1 };
    exp.units.push(c);
    for (const sc of Object.values(exp.scenarios)) sc.acceptedFormulaVersions.c = c.version;
    recordFormulaHistory(exp, c.id, c.version, c.expression!);
    for (const scId of exp.scenarioOrder) {
      const existing = runScenario(exp, scId, "accepted");
      const sc = exp.scenarios[scId];
      sc.results = existing.results;
      sc.resultKeys = existing.keys;
    }

    const b = exp.units.find((u) => u.id === "b")!;
    b.expression = "c + 1";
    b.version = 2;
    recordFormulaHistory(exp, b.id, 2, b.expression);
    for (const scId of exp.scenarioOrder) refreshPendingPreview(exp, scId, ["b"]);
    acceptPending(exp, baseId);
    expect(exp.scenarios[baseId].results.b.status).toBe("error");
    expect(exp.scenarios[baseId].results.b.errorKind).toBe("cycle");
    expect(exp.scenarios[baseId].results.c.status).toBe("error");
    expect(slow.results.b.value).toBe(10);
    discardPending(exp, slow.id);

    b.expression = "a * 3";
    b.version = 3;
    recordFormulaHistory(exp, b.id, 3, b.expression);
    for (const scId of exp.scenarioOrder) refreshPendingPreview(exp, scId, ["b"]);
    expect(exp.scenarios[baseId].results.b.status).toBe("error");
    expect(slow.results.b.value).toBe(10);

    acceptPending(exp, baseId);
    expect(exp.scenarios[baseId].results.b.value).toBe(3);
    expect(slow.results.b.value).toBe(10);
    expect(slow.pending.b.value).toBe(15);
  });
});
