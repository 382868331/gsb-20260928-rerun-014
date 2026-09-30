import type { ComputeUnit, UnitResult } from "./types";
import { EvalError, evaluate, extractReferences } from "./evaluator";

/** 单元定义指纹：输入或表达式变化都会改变，用于判定旧结果是否仍对应当前定义。 */
export function unitRevision(unit: ComputeUnit): string {
  return unit.kind === "input"
    ? `input:${unit.name}:${unit.value ?? ""}`
    : `formula:${unit.name}:${unit.expression ?? ""}`;
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
      continue;
    }
    if (byName.has(u.name)) {
      definitionErrors.set(u.id, `单元名 "${u.name}" 重复`);
      continue;
    }
    byName.set(u.name, u);
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

/**
 * Kahn 拓扑排序。返回执行次序；若存在环，返回环上的单元 id 列表。
 * 菱形依赖中每个单元只出现一次，且其所有上游先于它执行。
 */
export function topologicalOrder(
  units: ComputeUnit[],
  graph: GraphBuild,
): { order: string[]; cycle: string[] | null } {
  const indegree = new Map<string, number>();
  for (const u of units) indegree.set(u.id, graph.deps.get(u.id)?.length ?? 0);
  const queue = units.filter((u) => (indegree.get(u.id) ?? 0) === 0).map((u) => u.id);
  const order: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const dep of graph.dependents.get(id) ?? []) {
      indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
      if ((indegree.get(dep) ?? 0) === 0) queue.push(dep);
    }
  }

  if (order.length === units.length) return { order, cycle: null };

  // 环定位：在剩余节点上沿依赖前进一步直到回到已访问节点。
  const remaining = new Set(units.map((u) => u.id).filter((id) => !seen.has(id)));
  const start = remaining.values().next().value as string;
  const path: string[] = [];
  const pos = new Map<string, number>();
  let cur = start;
  while (remaining.has(cur) && !pos.has(cur)) {
    pos.set(cur, path.length);
    path.push(cur);
 const next = (graph.deps.get(cur) ?? []).find((d) => remaining.has(d));
    if (!next) break;
    cur = next;
  }
  const cycle = pos.has(cur) ? path.slice(pos.get(cur)!) : path;
  return { order, cycle };
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
  order: string[];
  /** 本次真正求值的单元（受影响集合），按拓扑顺序。 */
  executed: string[];
  cycle: string[] | null;
}

/** 判断从 from 沿依赖（仅经过 scope 内节点）能否到达 target。 */
function reachableWithin(from: string, target: string, graph: GraphBuild, scope: Set<string>): boolean {
  const stack = (graph.deps.get(from) ?? []).filter((d) => scope.has(d));
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of graph.deps.get(id) ?? []) if (scope.has(d)) stack.push(d);
  }
  return false;
}

/** 为环成员生成从它出发回到它自己的引用路径（单元名），用于展示完整阻断链。 */
function cyclePathFrom(start: string, graph: GraphBuild, members: Set<string>, units: ComputeUnit[]): string[] {
  const nameOf = (id: string) => units.find((u) => u.id === id)?.name ?? id;
  const path = [start];
  let cur = start;
  while (true) {
    const next = (graph.deps.get(cur) ?? []).find((d) => members.has(d));
    if (!next || next === start) break;
    path.push(next);
    cur = next;
  }
  const names = path.map(nameOf);
  names.push(nameOf(start));
  return names;
}

/**
 * 增量执行计算图。
 * @param changedIds 输入被修改的单元；省略表示全量执行。
 * @param previous 上一轮结果。任何被重算的单元先清空旧值：失败不会残留旧成功值。
 */
export function runGraph(
  units: ComputeUnit[],
  changedIds?: string[],
  previous: Record<string, UnitResult> = {},
): RunOutcome {
  const graph = buildGraph(units);
  const { order, cycle } = topologicalOrder(units, graph);
  const results: Record<string, UnitResult> = {};
  for (const u of units) {
    const old = previous[u.id];
    if (old) results[u.id] = { ...old };
  }

  const affected = changedIds ? affectedDownstream(changedIds, graph) : new Set(units.map((u) => u.id));

  // 环处理：失败只落在环成员及依赖环的下游，独立计算照常执行。
  // remaining 是未进入拓扑次序的节点（环成员 + 环的下游）。
  const inOrder = new Set(order);
  const remaining = new Set(units.map((u) => u.id).filter((id) => !inOrder.has(id)));
  if (remaining.size > 0) {
    // 环成员：在 remaining 内沿依赖能回到自身。
    const members = new Set<string>();
    for (const id of remaining) {
      if (reachableWithin(id, id, graph, remaining)) members.add(id);
    }
    for (const id of members) {
      const u = units.find((x) => x.id === id)!;
      const chain = cyclePathFrom(id, graph, members, units);
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(u),
        error: `检测到引用环：${chain.join(" -> ")}`,
        chain,
      };
    }
    // 环的下游：沿 remaining 内的依赖挂到已定位的失败上游，逐层展开（剩余部分成 DAG，必然收敛）。
    const pending = [...remaining].filter((id) => !members.has(id));
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const id = pending[i];
        const dep = (graph.deps.get(id) ?? []).find((d) => remaining.has(d));
        const depResult = dep ? results[dep] : undefined;
        if (!dep || !depResult || depResult.status !== "error") continue;
        const u = units.find((x) => x.id === id)!;
        const depName = units.find((x) => x.id === dep)!.name;
        const chain = [...(depResult.chain ?? [depName]), u.name];
        results[id] = {
          unitId: id,
          status: "error",
          value: null,
          revision: unitRevision(u),
          error: `上游单元 "${depName}" 处于引用环中，本单元被阻断`,
          chain,
        };
        pending.splice(i, 1);
        progress = true;
      }
    }
  }

  const executed: string[] = [];
  const values = new Map<string, number>();

  for (const id of order) {
    const unit = units.find((u) => u.id === id)!;
    const defErr = graph.definitionErrors.get(id);

    if (defErr) {
      results[id] = { unitId: id, status: "error", value: null, revision: unitRevision(unit), error: defErr, chain: [unit.name] };
      continue;
    }

    // 未受影响且旧结果与当前定义一致：沿用，不重算。
    const old = previous[id];
    if (!affected.has(id) && old && old.status === "ok" && old.revision === unitRevision(unit)) {
      values.set(id, old.value as number);
      results[id] = { ...old };
      continue;
    }

    if (!affected.has(id)) {
      // 依赖未变但旧结果不可用：仍需补算。
      affected.add(id);
    }

    executed.push(id);

    if (unit.kind === "input") {
      const raw = (unit.value ?? "").trim();
      const v = Number(raw);
      if (raw === "" || Number.isNaN(v) || !Number.isFinite(v)) {
        results[id] = { unitId: id, status: "error", value: null, revision: unitRevision(unit), error: raw === "" ? "输入为空" : `输入 "${raw}" 不是有效数字` };
      } else {
        values.set(id, v);
        results[id] = { unitId: id, status: "ok", value: v, revision: unitRevision(unit) };
      }
      continue;
    }

    // formula：先检查上游是否有失败；有则不做求值并继承定位。
    const depFailure = (graph.deps.get(id) ?? []).find((d) => results[d]?.status === "error");
    if (depFailure) {
      const depUnit = units.find((u) => u.id === depFailure)!;
      const depResult = results[depFailure];
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        error: `上游单元 "${depUnit.name}" 执行失败，本单元跳过`,
        chain: [...(depResult.chain ?? [depUnit.name]), unit.name],
      };
      continue;
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
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return { results, order, executed, cycle };
}
