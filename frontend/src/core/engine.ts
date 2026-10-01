import type { ComputeUnit, UnitResult } from "./types";
import { EvalError, evaluate, extractReferences } from "./evaluator";

/** 单元定义指纹：输入或表达式变化都会改变，用于判定旧结果是否仍对应当前定义。 */
export function unitRevision(unit: ComputeUnit): string {
  return unit.kind === "input"
    ? `input:${unit.value ?? ""}`
    : `formula:v${unit.version}:${unit.expression ?? ""}`;
}

export interface GraphBuild {
  /** 单元名 -> 单元（重名视为错误，在该单元上定位）。 */
  byName: Map<string, ComputeUnit>;
  /** 单元 id -> 依赖的单元 id 列表（保持引用出现顺序）。 */
  deps: Map<string, string[]>;
  /** 单元 id -> 被哪些单元直接依赖。 */
  dependents: Map<string, string[]>;
  /** 定义级错误：重名、引用不存在（不依赖求值即可定位）。 */
  definitionErrors: Map<string, string>;
}

export function buildGraph(units: ComputeUnit[]): GraphBuild {
  const byName = new Map<string, ComputeUnit>();
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const definitionErrors = new Map<string, string>();

  for (const u of units) {
    deps.set(u.id, []);
    dependents.set(u.id, []);
  }

  for (const u of units) {
    if (u.name.trim() === "") {
      definitionErrors.set(u.id, "单元名称为空");
    } else if (byName.has(u.name)) {
      definitionErrors.set(u.id, `单元名 "${u.name}" 重复`);
    } else {
      byName.set(u.name, u);
    }
  }

  for (const u of units) {
    if (u.kind !== "formula") continue;
    const refs = [...new Set(extractReferences(u.expression ?? ""))];
    const ids: string[] = [];
    for (const ref of refs) {
      const target = byName.get(ref);
      if (!target) {
        definitionErrors.set(u.id, `引用了不存在的单元 "${ref}"`);
      } else if (target.id === u.id) {
        definitionErrors.set(u.id, `单元 "${ref}" 直接引用自身`);
      } else {
        ids.push(target.id);
      }
    }
    deps.set(u.id, ids);
  }

  for (const [id, ds] of deps) {
    for (const d of ds) dependents.get(d)?.push(id);
  }

  return { byName, deps, dependents, definitionErrors };
}

/** Tarjan 强连通分量：大小 >1 的分量即为引用环（自引用在定义阶段已剔除自边）。 */
export function findCycles(units: ComputeUnit[], graph: GraphBuild): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const strongConnect = (id: string) => {
    indices.set(id, index);
    lowlink.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const dep of graph.deps.get(id) ?? []) {
      if (!indices.has(dep)) {
        strongConnect(dep);
        lowlink.set(id, Math.min(lowlink.get(id)!, lowlink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlink.set(id, Math.min(lowlink.get(id)!, indices.get(dep)!));
      }
    }

    if (lowlink.get(id) === indices.get(id)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== id);
      if (component.length > 1) cycles.push(component);
    }
  };

  for (const u of units) if (!indices.has(u.id)) strongConnect(u.id);
  return cycles;
}

/** 环成员 id -> 环的名称描述。 */
export function cycleMembership(units: ComputeUnit[], cycles: string[][]): Map<string, string> {
  const nameOf = (id: string) => units.find((u) => u.id === id)?.name ?? id;
  const map = new Map<string, string>();
  for (const cyc of cycles) {
    const desc = `${cyc.map(nameOf).join(" -> ")} -> ${nameOf(cyc[0])}`;
    for (const id of cyc) map.set(id, desc);
  }
  return map;
}

/**
 * 可执行单元的 Kahn 拓扑次序。环成员及其被阻塞的下游不参与排序——
 * 它们在计算图中没有唯一位置；独立单元照常排序执行，菱形汇点只出现一次。
 */
export function topologicalOrder(units: ComputeUnit[], graph: GraphBuild, blocked: Set<string>): string[] {
  const runnable = units.filter((u) => !blocked.has(u.id));
  const indegree = new Map<string, number>();
  for (const u of runnable) {
    indegree.set(u.id, (graph.deps.get(u.id) ?? []).filter((d) => !blocked.has(d)).length);
  }
  const queue = runnable.filter((u) => (indegree.get(u.id) ?? 0) === 0).map((u) => u.id);
  const order: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const dep of graph.dependents.get(id) ?? []) {
      if (blocked.has(dep)) continue;
      indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
      if ((indegree.get(dep) ?? 0) === 0) queue.push(dep);
    }
  }
  return order;
}

/** 收集 changedIds 的全部下游（含自身），菱形汇点只出现一次。 */
export function affectedDownstream(changedIds: string[], graph: GraphBuild): Set<string> {
  const affected = new Set<string>();
  const stack = [...changedIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    for (const d of graph.dependents.get(id) ?? []) stack.push(d);
  }
  return affected;
}

export interface RunOutcome {
  results: Record<string, UnitResult>;
  /** 可执行单元的拓扑次序（环及其下游不参与）。 */
  order: string[];
  /** 本次真正求值/判定的单元（revision 变化、旧错误待恢复、环与被阻塞者）。 */
  executed: string[];
  /** 检测到的环成员（去重）。 */
  cycle: string[] | null;
  cycleIds: Set<string>;
  /** 因依赖环而被阻塞的下游 id（不含环成员）。 */
  blockedIds: Set<string>;
}

/**
 * 增量执行计算图。
 * 引用环只阻塞环成员及其下游；独立常量/分支照常计算。
 * 断开环后，上一轮失败/阻塞的单元自动进入重算集，只恢复需要重算的部分；
 * 沿用的成功结果必须 revision 与当前定义一致，旧成功值不会误接到新输入。
 */
export function runGraph(
  units: ComputeUnit[],
  changedIds?: string[],
  previous: Record<string, UnitResult> = {},
): RunOutcome {
  const graph = buildGraph(units);
  const cycles = findCycles(units, graph);
  const membership = cycleMembership(units, cycles);
  const cycleIds = new Set<string>(membership.keys());

  // 环的全部下游（含多环、菱形汇点）被阻塞：沿 dependents 传播。
  const blockedIds = affectedDownstream([...cycleIds], graph);
  for (const id of cycleIds) blockedIds.delete(id);

  const order = topologicalOrder(units, graph, new Set([...cycleIds, ...blockedIds]));

  const results: Record<string, UnitResult> = {};
  for (const u of units) {
    const old = previous[u.id];
    if (old) results[u.id] = { ...old };
  }

  // 受影响集合：编辑点的下游 + 结构上无法执行者 + 上一轮非成功者（断环后自动恢复）。
  const affected = changedIds
    ? affectedDownstream(changedIds, graph)
    : new Set(units.map((u) => u.id));
  for (const id of cycleIds) affected.add(id);
  for (const id of blockedIds) affected.add(id);
  for (const [id, old] of Object.entries(previous)) {
    if (old.status !== "ok") affected.add(id);
  }

  const executed: string[] = [];
  const values = new Map<string, number>();
  const unitById = new Map(units.map((u) => [u.id, u]));
  const nameOf = (id: string) => unitById.get(id)?.name ?? id;

  const evaluateNode = (id: string) => {
    const unit = unitById.get(id)!;
    const defErr = graph.definitionErrors.get(id);
    if (defErr) {
      results[id] = { unitId: id, status: "error", value: null, revision: unitRevision(unit), errorKind: "definition", error: defErr };
      executed.push(id);
      return;
    }

    const old = previous[id];
    if (!affected.has(id) && old?.status === "ok" && old.revision === unitRevision(unit)) {
      values.set(id, old.value as number);
      results[id] = { ...old };
      return;
    }
    affected.add(id);
    executed.push(id);

    if (unit.kind === "input") {
      const raw = (unit.value ?? "").trim();
      const v = Number(raw);
      if (raw === "" || Number.isNaN(v) || !Number.isFinite(v)) {
        results[id] = { unitId: id, status: "error", value: null, revision: unitRevision(unit), errorKind: "eval", error: raw === "" ? "输入为空" : `输入 "${raw}" 不是有效数字` };
      } else {
        values.set(id, v);
        results[id] = { unitId: id, status: "ok", value: v, revision: unitRevision(unit) };
      }
      return;
    }

    const depFailure = (graph.deps.get(id) ?? []).find((d) => results[d]?.status === "error");
    if (depFailure) {
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        errorKind: "upstream",
        error: `上游单元 "${nameOf(depFailure)}" 执行失败，本单元跳过`,
      };
      return;
    }

    try {
      const v = evaluate(unit.expression ?? "", (name) => {
        const target = graph.byName.get(name);
        if (!target) throw new EvalError(`引用了不存在的单元 "${name}"`);
        const val = values.get(target.id);
        if (val === undefined) throw new EvalError(`上游单元 "${name}" 尚未就绪`);
        return val;
      });
      values.set(id, v);
      results[id] = { unitId: id, status: "ok", value: v, revision: unitRevision(unit) };
    } catch (e) {
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        errorKind: "eval",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // 1) 可执行部分按拓扑次序运行：独立单元不受引用环影响。
  for (const id of order) evaluateNode(id);

  // 2) 环成员：结构性错误，绝不产出数值。
  for (const id of cycleIds) {
    const unit = unitById.get(id)!;
    results[id] = {
      unitId: id,
      status: "error",
      value: null,
      revision: unitRevision(unit),
      errorKind: "cycle",
      error: `检测到引用环：${membership.get(id)}`,
    };
    if (!executed.includes(id)) executed.push(id);
  }

  // 3) 被环阻塞的下游：报告最近的环上源头或同样被阻塞的失败上游。
  for (const id of blockedIds) {
    const unit = unitById.get(id)!;
    const cycleDep = (graph.deps.get(id) ?? []).find((d) => cycleIds.has(d));
    const blockedDep = (graph.deps.get(id) ?? []).find((d) => blockedIds.has(d));
    const source = cycleDep ?? blockedDep;
    if (source) {
      const why = cycleDep ? "处于引用环中" : "被引用环阻塞";
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        errorKind: "upstream",
        error: `上游单元 "${nameOf(source)}" ${why}，本单元跳过`,
      };
    }
    if (!executed.includes(id)) executed.push(id);
  }

  const cycleFlat = [...new Set(cycles.reduce<string[]>((acc, c) => acc.concat(c), []))];
  return { results, order, executed, cycle: cycleFlat.length ? cycleFlat : null, cycleIds, blockedIds };
}

