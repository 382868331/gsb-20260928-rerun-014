import {
  cleanResult,
  errorResult,
  pendingResult,
  skippedResult,
  type Cell,
  type CellResult,
  type RunReport,
} from './types';
import { fingerprintCell } from './identifiers';
import { evaluateExpression } from './evaluator';
import { affectedDownstream, buildGraph, findCycles, topologicalOrder, type GraphIssues } from './graph';

interface PreparedGraph {
  issues: GraphIssues;
  order: string[];
  /** 环上的单元 id 集合 */
  cycleIds: Set<string>;
  /** cellId -> 人类可读的环路径（名称序列） */
  cyclePaths: Record<string, string>;
  /** 每个环（强连通分量）的成员 id */
  cycleGroups: string[][];
  /** 依赖（传递）了环上单元的 id 集合 */
  downstreamOfCycle: Set<string>;
}

function nameById(cells: Cell[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cell of cells) map.set(cell.id, cell.name.trim() || cell.id);
  return map;
}

function traceCyclePath(
  start: string,
  memberIds: Set<string>,
  deps: Record<string, string[]>,
  nameOf: Map<string, string>,
): string {
  const path = [start];
  let current = start;
  for (;;) {
    const next = (deps[current] ?? []).find(
      (dep) => memberIds.has(dep) && (dep === start || !path.includes(dep)),
    );
    if (!next || next === start) break;
    path.push(next);
    current = next;
  }
  return [...path, start].map((id) => nameOf.get(id) ?? id).join(' → ');
}

function prepare(cells: Cell[]): PreparedGraph {
  const { issues } = buildGraph(cells);
  const ids = cells.map((cell) => cell.id);
  const nameOf = nameById(cells);
  const cycles = findCycles(ids, issues.deps);
  const cycleIds = new Set<string>();
  const cyclePaths: Record<string, string> = {};
  const cycleGroups: string[][] = [];
  for (const component of cycles) {
    cycleGroups.push([...component]);
    const memberIds = new Set(component);
    for (const id of component) {
      cycleIds.add(id);
      cyclePaths[id] = traceCyclePath(id, memberIds, issues.deps, nameOf);
    }
  }
  const downstreamOfCycle = affectedDownstream([...cycleIds], ids, issues.deps);
  const order = topologicalOrder(ids, issues.deps);
  return { issues, order, cycleIds, cyclePaths, cycleGroups, downstreamOfCycle };
}

function cellMap(cells: Cell[]): Map<string, Cell> {
  return new Map(cells.map((cell) => [cell.id, cell]));
}

function firstBlockingDep(
  depIds: string[],
  results: Record<string, CellResult>,
  byId: Map<string, Cell>,
): string | null {
  for (const depId of depIds) {
    const result = results[depId];
    if (!result || result.status !== 'clean') {
      const depName = byId.get(depId)?.name.trim() ?? depId;
      if (result?.error) return `依赖单元 "${depName}" 执行失败：${result.error}`;
      return `依赖单元 "${depName}" 无可用结果`;
    }
  }
  return null;
}

function evaluateCell(
  cell: Cell,
  depIds: string[],
  results: Record<string, CellResult>,
  nameOf: Map<string, string>,
): CellResult {
  const fp = fingerprintCell(cell);
  if (cell.type === 'input') {
    return cleanResult(Number(cell.expr.trim()), fp, []);
  }
  const scope: Record<string, number> = {};
  for (const depId of depIds) scope[nameOf.get(depId)!] = results[depId].value!;
  try {
    const value = evaluateExpression(cell.expr, scope);
    return cleanResult(value, fp, depIds);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : '执行失败', fp, depIds);
  }
}

/**
 * 全量执行所有单元。旧结果不会被信任：每个单元都按当前输入重新求值，
 * 失败单元写入错误结果（value=null），上游失败的下游标记为 skipped。
 */
export function runAll(cells: Cell[]): RunReport {
  const prepared = prepare(cells);
  const byId = cellMap(cells);
  const nameOf = nameById(cells);
  const { issues } = prepared;
  const results: Record<string, CellResult> = {};
  const executed: string[] = [];

  // 非环单元按拓扑序执行；图错误/成环/依赖阻断先判定
  for (const id of prepared.order) {
    const cell = byId.get(id)!;
    const fp = fingerprintCell(cell);
    executed.push(id);
    if (issues.errors[id]) {
      results[id] = errorResult(issues.errors[id], fp, issues.deps[id]);
      continue;
    }
    if (prepared.cycleIds.has(id)) {
      results[id] = errorResult(`依赖成环：${prepared.cyclePaths[id]}`, fp, issues.deps[id]);
      continue;
    }
    const blocking = firstBlockingDep(issues.deps[id], results, byId);
    if (blocking) {
      results[id] = skippedResult(blocking, fp, issues.deps[id]);
      continue;
    }
    results[id] = evaluateCell(cell, issues.deps[id], results, nameOf);
  }

  // 环上及依赖环但未进入拓扑序的单元
  for (const id of cells.map((cell) => cell.id)) {
    if (results[id]) continue;
    const cell = byId.get(id)!;
    const fp = fingerprintCell(cell);
    executed.push(id);
    if (prepared.cycleIds.has(id)) {
      results[id] = errorResult(`依赖成环：${prepared.cyclePaths[id]}`, fp, issues.deps[id]);
    } else if (issues.errors[id]) {
      results[id] = errorResult(issues.errors[id], fp, issues.deps[id]);
    } else {
      results[id] = skippedResult('位于无法完成拓扑排序的依赖路径上', fp, issues.deps[id]);
    }
  }

  return { results, executed, cycles: cycleReport(prepared) };
}

function cycleReport(prepared: PreparedGraph): string[][] {
  return prepared.cycleGroups.map((group) => [...group]);
}

/**
 * 增量执行：只重算 changedIds 及其受影响下游。未受影响的单元必须指纹一致才复用旧结果；
 * 指纹不一致（输入已变而未登记）也强制重算。被重算单元的旧成功值不会保留：
 * 一旦执行失败或上游阻断，写入的是 value=null 的错误/跳过结果。
 */
export function runIncremental(
  cells: Cell[],
  previous: Record<string, CellResult>,
  changedIds: string[],
): RunReport {
  const prepared = prepare(cells);
  const byId = cellMap(cells);
  const nameOf = nameById(cells);
  const ids = cells.map((cell) => cell.id);
  const { issues } = prepared;

  const results: Record<string, CellResult> = {};
  const executed: string[] = [];

  // 种子集合：显式变更 + 旧结果指纹已失效 + 处于 stale 状态 + 环上及其下游
  const seeds = new Set<string>(changedIds);
  for (const id of ids) {
    const prev = previous[id];
    if (
      prev &&
      (prev.fingerprint !== fingerprintCell(byId.get(id)!) || prev.status === 'stale' || prev.status === 'pending')
    ) {
      seeds.add(id);
    }
  }
  for (const id of prepared.downstreamOfCycle) seeds.add(id);
  const affected = affectedDownstream([...seeds], ids, issues.deps);

  for (const id of prepared.order) {
    const cell = byId.get(id)!;
    if (!affected.has(id)) {
      // 未受影响：只有指纹匹配的旧结果才能复用，保证“旧成功值”不被错误信任
      const prev = previous[id];
      if (prev && prev.fingerprint === fingerprintCell(cell)) {
        results[id] = prev;
        continue;
      }
    }
    const fp = fingerprintCell(cell);
    executed.push(id);
    if (issues.errors[id]) {
      results[id] = errorResult(issues.errors[id], fp, issues.deps[id]);
      continue;
    }
    if (prepared.cycleIds.has(id)) {
      results[id] = errorResult(`依赖成环：${prepared.cyclePaths[id]}`, fp, issues.deps[id]);
      continue;
    }
    const blocking = firstBlockingDep(issues.deps[id], results, byId);
    if (blocking) {
      results[id] = skippedResult(blocking, fp, issues.deps[id]);
      continue;
    }
    results[id] = evaluateCell(cell, issues.deps[id], results, nameOf);
  }

  for (const id of ids) {
    if (results[id]) continue;
    const cell = byId.get(id)!;
    executed.push(id);
    if (prepared.cycleIds.has(id)) {
      results[id] = errorResult(`依赖成环：${prepared.cyclePaths[id]}`, fingerprintCell(cell), issues.deps[id]);
    } else {
      results[id] = skippedResult('位于无法完成拓扑排序的依赖路径上', fingerprintCell(cell), issues.deps[id]);
    }
  }

  return { results, executed, cycles: cycleReport(prepared) };
}

/**
 * 编辑后、执行前：把变更单元及其下游标记为 stale。
 * stale 仅表示“界面上的旧数字不再是当前成功值”，不会参与求值。
 */
export function markStale(
  cells: Cell[],
  previous: Record<string, CellResult>,
  changedIds: string[],
): Record<string, CellResult> {
  const { issues } = buildGraph(cells);
  const ids = cells.map((cell) => cell.id);
  const affected = affectedDownstream(changedIds, ids, issues.deps);
  const next: Record<string, CellResult> = {};
  for (const cell of cells) {
    const prev = previous[cell.id];
    if (affected.has(cell.id)) {
      next[cell.id] = {
        ...(prev ?? pendingResult()),
        status: 'stale',
        fingerprint: fingerprintCell(cell),
      };
    } else if (prev) {
      next[cell.id] = prev;
    }
  }
  return next;
}
