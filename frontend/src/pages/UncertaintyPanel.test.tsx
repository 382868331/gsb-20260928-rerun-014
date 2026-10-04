import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { UncertaintyPanel } from "./UncertaintyPanel";
import { useNotebook } from "../store/useNotebook";
import { loadNotebook, STORAGE_KEY } from "../core/storage";
import { computeScenarioRanges } from "../core/uncertainty";

function blockByTitle(title: string): HTMLElement {
  const heading = screen.getByText((_, el) => el?.tagName === "H3" && el.textContent === title);
  return heading.closest(".range-block")!;
}

function acceptedBlock(): HTMLElement {
  const headings = screen.getAllByText((_, el) => el?.tagName === "H3" && el.textContent.startsWith("已接受基线范围"));
  return headings[0].closest(".range-block")!;
}

function setupExperiment(build: (names: { n1: string; n2: string; n3: string }) => string) {
  const store = () => useNotebook.getState();
  store().createExperiment("范围复验");
  const x1 = store().addUnit("input")!;
  const x2 = store().addUnit("input")!;
  const f3 = store().addUnit("formula")!;
  const exp = store().active()!;
  const n1 = exp.units.find((u) => u.id === x1)!.name;
  const n2 = exp.units.find((u) => u.id === x2)!.name;
  const n3 = exp.units.find((u) => u.id === f3)!.name;
  const expression = build({ n1, n2: n2, n3 });
  store().updateUnit(f3, { expression });
  store().acceptAllScenarioUpdates();
  store().setJointGroups([{ id: "jg", unitIds: [x1, x2], rows: [[1, 20], [3, 10]] }]);
  return { store, x1, x2, f3, n1, n2, n3 };
}

describe("范围面板：失效版本复验", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotebook.setState({ experiments: {}, rootId: null, activeId: null, rev: 0 });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("引用环：接受自引用版本后范围表立即失效，保存重开也不恢复旧区间", () => {
    const { store, f3, n1, n2, n3 } = setupExperiment(({ n1, n2 }) => `${n1} - ${n2}`);

    const { rerender } = render(<UncertaintyPanel exp={store().active()!} />);
    let row = screen.getByText(n3).closest("tr")!;
    expect(within(row).getByText("已证实")).toBeTruthy();
    expect(within(row).getByText(/\[-19, -7\]/)).toBeTruthy();

    store().updateUnit(f3, { expression: `${n3} + ${n1}` });
    store().acceptAllScenarioUpdates();
    rerender(<UncertaintyPanel exp={store().active()!} />);

    row = screen.getByText(n3).closest("tr")!;
    expect(within(row).queryByText("已证实")).toBeNull();
    expect(within(row).getByText("无法判断")).toBeTruthy();
    expect(within(row).getByText(/直接引用自身/)).toBeTruthy();

    const reloaded = loadNotebook();
    const reExp = reloaded.experiments[store().active()!.id];
    const scId = reExp.activeScenarioId!;
    const rr = computeScenarioRanges(reExp, scId, "accepted").ranges[f3];
    expect(rr.status).toBe("indeterminate");
    expect(rr.min).toBeUndefined();
  });

  it("除零：全部组合除零时范围无法判断并给出原因", () => {
    const { store, f3, n1, n2 } = setupExperiment(({ n1 }) => `1 / ${n1}`);
    // 联合观测里没有 x=0；改为确定值 0 触发全部组合除零。
    store().setJointGroups([]);
    store().updateScenarioParam(n1Id(store), "0");
    render(<UncertaintyPanel exp={store().active()!} />);
    const block = acceptedBlock();
    const row = within(block).getByText(store().active()!.units.find((u) => u.id === f3)!.name).closest("tr")!;
    expect(within(row).getByText("无法判断")).toBeTruthy();
    expect(within(row).getByText(/除数为零/)).toBeTruthy();
  });

  it("缺少联合关系：清空观测行后相关范围无法判断", () => {
    const { store, f3, n1, n2 } = setupExperiment(({ n1, n2 }) => `${n1} - ${n2}`);
    store().setJointGroups([
      { id: "jg", unitIds: [n1Id(store), n2Id(store)], rows: [] },
    ]);
    render(<UncertaintyPanel exp={store().active()!} />);
    const block = acceptedBlock();
    const row = within(block).getByText(store().active()!.units.find((u) => u.id === f3)!.name).closest("tr")!;
    expect(within(row).getByText("无法判断")).toBeTruthy();
    expect(within(row).getByText(/联合观测|上游/)).toBeTruthy();
  });

  it("保存的历史报告标清原版本，且公式改版后不被当作当前结果", () => {
    const { store, f3, n1, n2, n3 } = setupExperiment(({ n1, n2 }) => `${n1} - ${n2}`);
    store().saveRangeReport("accepted", "旧版报告");
    render(<UncertaintyPanel exp={store().active()!} />);
    // 改版接受后：当前范围失效。
    act(() => {
      store().updateUnit(f3, { expression: `${n3} + ${n1}` });
      store().acceptAllScenarioUpdates();
    });
    const exp = store().active()!;
    // 历史报告原样保存。
    const report = exp.reports![0];
    expect(report.ranges[f3].status).toBe("proven");
    expect(report.ranges[f3].min).toBe(-19);
    expect(report.formulaExpressions?.[f3]).toBe(`${n1} - ${n2}`);
    // 展开历史报告仍能看到保存时的已证实范围。
    fireEvent.click(screen.getByText("旧版报告"));
    const historyBlock = blockByTitle("保存时的范围（历史快照）");
    const historyFormulaRow = within(historyBlock).getByText(n3).closest("tr")!;
    expect(within(historyFormulaRow).getByText("已证实")).toBeTruthy();
    expect(within(historyFormulaRow).getByText(/\[-19, -7\]/)).toBeTruthy();
    expect(screen.getAllByText(/历史报告（保存时的原版本快照，不是当前结果）/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/不能当作当前范围/).length).toBeGreaterThan(0);

    // 保存重开后历史报告依旧，当前范围依旧失效。
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.experiments[exp.id].reports[0].formulaExpressions[f3]).toBe(`${n1} - ${n2}`);
    const reloaded = loadNotebook();
    const reExp = reloaded.experiments[exp.id];
    expect(reExp.reports![0].ranges[f3].max).toBe(-7);
    const rr = computeScenarioRanges(reExp, reExp.activeScenarioId!, "accepted").ranges[f3];
    expect(rr.status).toBe("indeterminate");
  });
});

function n1Id(store: () => ReturnType<typeof useNotebook.getState>): string {
  return store().active()!.units.filter((u) => u.kind === "input")[0]!.id;
}
function n2Id(store: () => ReturnType<typeof useNotebook.getState>): string {
  return store().active()!.units.filter((u) => u.kind === "input")[1]!.id;
}
