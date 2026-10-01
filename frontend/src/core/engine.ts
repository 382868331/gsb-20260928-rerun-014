import type { ComputeUnit, UnitResult } from "./types";
import { EvalError, evaluate, extractReferences } from "./evaluator";

/** 单元定义指纹：输入或表达式变化都会改变，用于判定旧结果是否仍对应当前定义。 */
export function unitRevision(unit: ComputeUnit): string {
  return unit.kind === "input"
    ? `input:${unit.value ?? ""}`
    : `formula:${unit.expression ?? ""}`;
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

/** 找出所有真正位于环中的节点；环的下游不属于环，但会被阻塞。 */
export function findCycleNodes(units: ComputeUnit[], graph: GraphBuild): string[] {
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string): void => {
    indices.set(id, nextIndex);
    low.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const dep of graph.deps.get(id) ?? []) {
      if (!indices.has(dep)) {
        visit(dep);
        low.set(id, Math.min(low.get(id)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id)!, indices.get(dep)!));
      }
    }

    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let current = "";
      do {
        current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
      } while (current !== id);
      if (component.length > 1 || (graph.deps.get(id) ?? []).includes(id)) cycles.push(component);
    }
  };

  for (const unit of units) {
    if (!indices.has(unit.id)) visit(unit.id);
  }
  return cycles.flat();
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
  blockedIds: string[];
}

function provenRevision(
  id: string,
  graph: GraphBuild,
  results: Record<string, UnitResult>,
  units: ComputeUnit[],
): string {
  const unit = units.find((item) => item.id === id);
  const own = unit ? unitRevision(unit) : "unknown";
  const depKey = (graph.deps.get(id) ?? [])
    .map((depId) => `${depId}:${results[depId]?.revision ?? "missing"}`)
    .join("|");
  return depKey ? `${own}<<${depKey}` : own;
}

function sealResult(
  id: string,
  graph: GraphBuild,
  results: Record<string, UnitResult>,
  units: ComputeUnit[],
): void {
  const result = results[id];
  if (result) {
    result.revision = provenRevision(id, graph, results, units);
    result.dependencyIds = [...(graph.deps.get(id) ?? [])];
  }
}

function canReuse(
  id: string,
  unit: ComputeUnit,
  graph: GraphBuild,
  previous: Record<string, UnitResult>,
  results: Record<string, UnitResult>,
  units: ComputeUnit[],
): boolean {
  const old = previous[id];
  if (!old || old.status !== "ok" || old.revision === "") return false;
  const ownRevision = unitRevision(unit);
  if (old.revision === provenRevision(id, graph, results, units)) return true;
  if (old.revision.includes("<<")) return false;
  if (old.revision !== ownRevision) return false;
  return (graph.deps.get(id) ?? []).every((depId) => {
    const depUnit = units.find((item) => item.id === depId);
    const depOld = previous[depId];
    const depCurrent = results[depId];
    const currentRevision = depUnit ? unitRevision(depUnit) : "";
    return depUnit && depOld?.status === "ok" && depCurrent?.status === "ok" &&
      (depOld.revision === depCurrent.revision ||
        (depOld.revision === currentRevision && (depCurrent.revision === currentRevision || depCurrent.revision.startsWith(`${currentRevision}<<`))));
  });
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
  const { order } = topologicalOrder(units, graph);
  const cycleNodes = findCycleNodes(units, graph);
  const cycle = cycleNodes.length > 0 ? cycleNodes : null;
  const blocked = cycle ? affectedDownstream(cycleNodes, graph) : new Set<string>();
  const results: Record<string, UnitResult> = {};
  for (const u of units) {
    const old = previous[u.id];
    if (old) results[u.id] = { ...old };
  }

  const affected = changedIds ? affectedDownstream(changedIds, graph) : new Set(units.map((u) => u.id));

  const executed: string[] = [];
  const values = new Map<string, number>();

  for (const id of order) {
    const unit = units.find((u) => u.id === id)!;
    const defErr = graph.definitionErrors.get(id);

    if (blocked.has(id)) continue;

    if (defErr) {
      results[id] = { unitId: id, status: "error", value: null, revision: unitRevision(unit), error: defErr };
      sealResult(id, graph, results, units);
      continue;
    }

    // 未受影响且旧结果与当前定义一致：沿用，不重算。
    const old = previous[id];
    if (!affected.has(id) && canReuse(id, unit, graph, previous, results, units)) {
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
      sealResult(id, graph, results, units);
      continue;
    }

    // formula：先检查上游是否有失败；有则不做求值并继承定位。
    const depFailure = (graph.deps.get(id) ?? []).find((d) => results[d]?.status === "error");
    if (depFailure) {
      const depUnit = units.find((u) => u.id === depFailure)!;
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        error: `上游单元 "${depUnit.name}" 执行失败，本单元跳过`,
      };
      sealResult(id, graph, results, units);
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
    sealResult(id, graph, results, units);
  }

  if (cycle) {
    const cycleNames = new Map(cycle.map((id) => {
      const next = (graph.deps.get(id) ?? []).find((depId) => cycle.includes(depId));
      return [id, units.find((u) => u.id === next)?.name ?? next];
    }));
    for (const id of blocked) {
      const unit = units.find((u) => u.id === id)!;
      const isCycleNode = cycle.includes(id);
      const name = unit.name;
      const nextName = cycleNames.get(id) ?? "";
      results[id] = {
        unitId: id,
        status: "error",
        value: null,
        revision: unitRevision(unit),
        error: isCycleNode
          ? `检测到引用环：${name} -> ${nextName}`
          : `依赖的单元位于引用环中，本单元阻塞`,
      };
      sealResult(id, graph, results, units);
    }
  }

  return { results, order, executed, cycle, blockedIds: [...blocked] };
}
