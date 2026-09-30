import { useCallback, useEffect, useRef, useState } from 'react';
import { markStale, runIncremental } from '../compute/engine';
import type { Cell, CellResult, Notebook } from '../compute/types';
import type { ExperimentStore } from '../services/experimentStore';

let idCounter = 0;
export function newCellId(): string {
  idCounter += 1;
  return `cell_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

export function makeCell(partial: Partial<Cell> = {}): Cell {
  return {
    id: partial.id ?? newCellId(),
    name: partial.name ?? 'x',
    type: partial.type ?? 'input',
    expr: partial.expr ?? '0',
  };
}

const pendingResult: CellResult = { status: 'pending', value: null, error: null, deps: [], fingerprint: null };

let editorEpoch = 0;

export function useNotebookEditor(notebook: Notebook, store: ExperimentStore) {
  const [cells, setCells] = useState<Cell[]>(() => notebook.cells.map((cell) => ({ ...cell })));
  const [title, setTitle] = useState(notebook.title);
  const [results, setResults] = useState<Record<string, CellResult>>(() => notebook.results);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rerunTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChanges = useRef<Set<string>>(new Set());
  const epochRef = useRef(0);
  const cellsRef = useRef(cells);
  const resultsRef = useRef(results);
  const titleRef = useRef(title);
  cellsRef.current = cells;
  resultsRef.current = results;
  titleRef.current = title;

  useEffect(() => {
    setCells(notebook.cells.map((cell) => ({ ...cell })));
    setTitle(notebook.title);
    setResults(notebook.results);
    pendingChanges.current = new Set();
    // 切换实验时作废旧实验挂起的重算/保存回调，防止写入错误的实验
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (rerunTimer.current) clearTimeout(rerunTimer.current);
    editorEpoch += 1;
    epochRef.current = editorEpoch;
  }, [notebook.id]);

  // 每个挂载实例分配唯一纪元；StrictMode 首次挂载的实例在卸载后作废，
  // 其挂起的重算/保存回调不得覆盖新实例的状态
  useEffect(() => {
    editorEpoch += 1;
    epochRef.current = editorEpoch;
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (rerunTimer.current) clearTimeout(rerunTimer.current);
      editorEpoch += 1;
    };
  }, []);

  const persistSoon = useCallback(
    (snapshotCells: Cell[], snapshotResults: Record<string, CellResult>, snapshotTitle: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const epoch = epochRef.current;
      saveTimer.current = setTimeout(() => {
        if (epoch !== epochRef.current || epoch !== editorEpoch) return;
        store.save(notebook.id, {
          title: snapshotTitle,
          cells: snapshotCells,
          results: snapshotResults,
        });
      }, 400);
    },
    [store, notebook.id],
  );

  // 编辑后立即作废旧值（stale），再合并连续编辑进行一次增量重算
  const invalidate = useCallback(
    (nextCells: Cell[], changedIds: string[]) => {
      const seeded: Record<string, CellResult> = {};
      for (const cell of nextCells) {
        seeded[cell.id] = resultsRef.current[cell.id] ?? { ...pendingResult };
      }
      const marked = markStale(nextCells, seeded, changedIds);
      setResults(marked);
      for (const id of changedIds) pendingChanges.current.add(id);
      if (rerunTimer.current) clearTimeout(rerunTimer.current);
      const epoch = epochRef.current;
      rerunTimer.current = setTimeout(() => {
        if (epoch !== epochRef.current || epoch !== editorEpoch) return;
        const changed = [...pendingChanges.current];
        pendingChanges.current = new Set();
        const report = runIncremental(cellsRef.current, resultsRef.current, changed);
        setResults(report.results);
        persistSoon(cellsRef.current, report.results, titleRef.current);
      }, 120);
    },
    [persistSoon],
  );

  const updateCell = useCallback(
    (id: string, patch: Partial<Omit<Cell, 'id'>>) => {
      const next = cellsRef.current.map((cell) => (cell.id === id ? { ...cell, ...patch } : cell));
      setCells(next);
      invalidate(next, [id]);
    },
    [invalidate],
  );

  const addCell = useCallback(
    (type: Cell['type'] = 'input') => {
      const cell = makeCell({
        type,
        name: `x${cellsRef.current.length + 1}`,
        expr: type === 'input' ? '0' : '',
      });
      const next = [...cellsRef.current, cell];
      setCells(next);
      invalidate(next, [cell.id]);
    },
    [invalidate],
  );

  const removeCell = useCallback(
    (id: string) => {
      const remaining = cellsRef.current.filter((cell) => cell.id !== id);
      if (rerunTimer.current) clearTimeout(rerunTimer.current);
      pendingChanges.current = new Set();
      setCells(remaining);
      const kept: Record<string, CellResult> = {};
      for (const cell of remaining) {
        if (resultsRef.current[cell.id]) kept[cell.id] = resultsRef.current[cell.id];
      }
      // 删除后可能产生“引用不存在”，对保留单元整体增量重算
      const report = runIncremental(remaining, kept, remaining.map((cell) => cell.id));
      setResults(report.results);
      persistSoon(remaining, report.results, titleRef.current);
    },
    [persistSoon],
  );

  const moveCell = useCallback(
    (id: string, direction: -1 | 1) => {
      const current = cellsRef.current;
      const index = current.findIndex((cell) => cell.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      setCells(next);
      persistSoon(next, resultsRef.current, titleRef.current);
    },
    [persistSoon],
  );

  const runAllNow = useCallback(() => {
    if (rerunTimer.current) clearTimeout(rerunTimer.current);
    pendingChanges.current = new Set();
    const report = runIncremental(
      cellsRef.current,
      resultsRef.current,
      cellsRef.current.map((cell) => cell.id),
    );
    setResults(report.results);
    persistSoon(cellsRef.current, report.results, titleRef.current);
  }, [persistSoon]);

  const saveNow = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    store.save(notebook.id, { title: titleRef.current, cells: cellsRef.current, results: resultsRef.current });
  }, [store, notebook.id]);

  const renameTitle = useCallback(
    (nextTitle: string) => {
      setTitle(nextTitle);
      persistSoon(cellsRef.current, resultsRef.current, nextTitle);
    },
    [persistSoon],
  );

  const branch = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    store.save(notebook.id, {
      title: titleRef.current,
      cells: cellsRef.current,
      results: resultsRef.current,
    });
    return store.branch(notebook.id);
  }, [store, notebook.id]);

  return {
    cells,
    title,
    results,
    updateCell,
    addCell,
    removeCell,
    moveCell,
    runAllNow,
    saveNow,
    branch,
    renameTitle,
  };
}
