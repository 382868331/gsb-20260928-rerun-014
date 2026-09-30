import { describe, expect, it } from 'vitest';
import { ExperimentStore, type KVStorage } from '../services/experimentStore';
import { runAll } from '../compute/engine';
import type { Cell } from '../compute/types';

function memStorage(): KVStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

const cells: Cell[] = [
  { id: 'c1', name: 'a', type: 'input', expr: '2' },
  { id: 'c2', name: 'b', type: 'formula', expr: 'a + 1' },
];

describe('实验快照与支线', () => {
  it('保存完整实验后，重开（新 store 实例）输入与结果对应关系仍在', () => {
    const storage = memStorage();
    const store = new ExperimentStore(storage);
    const created = store.create('基线');
    const report = runAll(cells);
    store.save(created.id, { cells, results: report.results });

    const reopened = new ExperimentStore(storage);
    const loaded = reopened.get(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.cells.map((cell) => cell.expr)).toEqual(['2', 'a + 1']);
    expect(loaded!.results.c2.value).toBe(3);
    expect(loaded!.results.c2.fingerprint).not.toBeNull();
    // 结果条目与单元一一对应，不多不少
    expect(Object.keys(loaded!.results).sort()).toEqual(['c1', 'c2']);
  });

  it('支线是深拷贝：修改支线参数与结果不影响父实验', () => {
    const storage = memStorage();
    const store = new ExperimentStore(storage);
    const parent = store.create('基线');
    store.save(parent.id, { cells, results: runAll(cells).results });

    const child = store.branch(parent.id, '高温参数');
    const childCells: Cell[] = [
      { ...cells[0], expr: '20' },
      cells[1],
    ];
    store.save(child.id, { cells: childCells, results: runAll(childCells).results });

    const reloadedParent = store.get(parent.id)!;
    const reloadedChild = store.get(child.id)!;
    expect(reloadedParent.cells[0].expr).toBe('2');
    expect(reloadedParent.results.c2.value).toBe(3);
    expect(reloadedChild.cells[0].expr).toBe('20');
    expect(reloadedChild.results.c2.value).toBe(21);
    expect(reloadedChild.parentId).toBe(parent.id);
    expect(reloadedParent.parentId).toBeNull();
  });

  it('失败快照重开后仍是失败，而不是只留下最后显示的数字', () => {
    const storage = memStorage();
    const store = new ExperimentStore(storage);
    const created = store.create('含错误');
    const badCells: Cell[] = [
      { id: 'a', name: 'a', type: 'input', expr: '1' },
      { id: 'b', name: 'b', type: 'formula', expr: 'a / 0' },
      { id: 'c', name: 'c', type: 'formula', expr: 'b + 1' },
    ];
    store.save(created.id, { cells: badCells, results: runAll(badCells).results });

    const reopened = new ExperimentStore(storage).get(created.id)!;
    expect(reopened.results.b.status).toBe('error');
    expect(reopened.results.b.value).toBeNull();
    expect(reopened.results.c.status).toBe('skipped');
    expect(reopened.results.c.value).toBeNull();
  });

  it('谱系返回从根到支线的链路', () => {
    const storage = memStorage();
    const store = new ExperimentStore(storage);
    const root = store.create('root');
    const mid = store.branch(root.id, 'mid');
    const leaf = store.branch(mid.id, 'leaf');
    const lineage = store.lineage(leaf.id).map((item) => item.title);
    expect(lineage).toEqual(['root', 'mid', 'leaf']);
  });
});
