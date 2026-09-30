import type { Cell } from './types';
import { extractReferences } from './evaluator';
import { isValidName } from './identifiers';

export interface GraphIssues {
  /** cellId -> 错误信息（重名、非法名、语法错误、引用不存在） */
  errors: Record<string, string>;
  /** cellId -> 依赖的上游 cellId 列表（按出现顺序去重） */
  deps: Record<string, string[]>;
}

export interface BuildResult {
  issues: GraphIssues;
  /** name -> cellId（重名时保留第一个，其余记为错误） */
  nameToId: Map<string, string>;
}

/**
 * 构建依赖图。编译失败、名字非法、重名、引用不存在都会记录为单元错误，
 * 但不抛出，便于批量定位。
 */
export function buildGraph(cells: Cell[]): BuildResult {
  const errors: Record<string, string> = {};
  const deps: Record<string, string[]> = {};
  const nameToId = new Map<string, string>();

  for (const cell of cells) {
    const name = cell.name.trim();
    if (!name) {
      errors[cell.id] = '单元名称不能为空';
    } else if (!isValidName(name)) {
      errors[cell.id] = `非法单元名称 "${name}"`;
    } else if (nameToId.has(name)) {
      errors[cell.id] = `单元名称 "${name}" 重复`;
    } else {
      nameToId.set(name, cell.id);
    }
    deps[cell.id] = [];
  }

  for (const cell of cells) {
    if (errors[cell.id]) continue;
    if (cell.type === 'input') {
      const value = cell.expr.trim();
      if (value === '') {
        errors[cell.id] = '输入值不能为空';
        continue;
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        errors[cell.id] = `输入值 "${value}" 不是有效数字`;
      }
      continue;
    }
    let refs: string[];
    try {
      refs = extractReferences(cell.expr);
    } catch (err) {
      errors[cell.id] = err instanceof Error ? err.message : '表达式解析失败';
      continue;
    }
    const cellDeps: string[] = [];
    const seen = new Set<string>();
    const missing = new Set<string>();
    for (const ref of refs) {
      const depId = nameToId.get(ref);
      if (!depId) {
        missing.add(ref);
        continue;
      }
      if (depId === cell.id) {
        if (!seen.has(depId)) {
          seen.add(depId);
          cellDeps.push(depId);
        }
        continue;
      }
      if (!seen.has(depId)) {
        seen.add(depId);
        cellDeps.push(depId);
      }
    }
    deps[cell.id] = cellDeps;
    if (missing.size > 0) {
      errors[cell.id] = `引用了不存在的单元: ${[...missing].map((name) => `"${name}"`).join('、')}`;
    }
  }

  return { issues: { errors, deps }, nameToId };
}

/** Tarjan SCC：返回大小 >= 2 的环，以及带自环的单点环 */
export function findCycles(ids: string[], deps: Record<string, string[]>): string[][] {
  let indexCounter = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const connect = (v: string): void => {
    indexOf.set(v, indexCounter);
    lowlink.set(v, indexCounter);
    indexCounter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of deps[v] ?? []) {
      if (!indexOf.has(w)) {
        connect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
      }
    }

    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      const isCycle =
        component.length >= 2 ||
        (component.length === 1 && (deps[component[0]] ?? []).includes(component[0]));
      if (isCycle) cycles.push(component.reverse());
    }
  };

  for (const id of ids) {
    if (!indexOf.has(id)) connect(id);
  }
  return cycles;
}

/**
 * Kahn 拓扑排序（依赖在前）。返回顺序；若存在环，环上及依赖环的单元不会出现在结果中。
 */
export function topologicalOrder(ids: string[], deps: Record<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const id of ids) {
    for (const dep of deps[id] ?? []) {
      if (indegree.has(dep)) indegree.set(id, (indegree.get(id) ?? 0) + 1);
    }
  }
  // 用原始顺序作为同优先级次序，保证稳定的计算次序
  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  const readySet = new Set(ready);
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const candidate of ids) {
      if (readySet.has(candidate) || order.includes(candidate)) continue;
      const remaining = (deps[candidate] ?? []).filter(
        (dep) => indegree.has(dep) && !order.includes(dep),
      ).length;
      if (remaining === 0 && (indegree.get(candidate) ?? 0) > 0) {
        ready.push(candidate);
        readySet.add(candidate);
      }
    }
  }
  return order;
}

/** 求 changedIds 的传递下游闭包（含自身） */
export function affectedDownstream(
  changedIds: string[],
  ids: string[],
  deps: Record<string, string[]>,
): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    for (const dep of deps[id] ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(id);
      dependents.set(dep, list);
    }
  }
  const affected = new Set<string>();
  const queue = [...changedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (affected.has(id)) continue;
    affected.add(id);
    for (const child of dependents.get(id) ?? []) queue.push(child);
  }
  return affected;
}
