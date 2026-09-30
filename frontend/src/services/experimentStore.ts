import type { Cell, CellResult, ExperimentSummary, Notebook } from '../compute/types';

const STORAGE_KEY = 'sci-notebook:experiments:v1';
const ACTIVE_KEY = 'sci-notebook:active:v1';

export interface PersistedData {
  version: 1;
  experiments: Notebook[];
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 可注入的存储，默认 localStorage；测试中使用内存实现 */
export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryStorage = (): KVStorage => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

export class ExperimentStore {
  private storage: KVStorage;
  private experiments: Notebook[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;

  constructor(storage?: KVStorage) {
    this.storage =
      storage ??
      (typeof localStorage === 'undefined'
        ? memoryStorage()
        : localStorage);
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private load(): void {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) {
      this.experiments = [];
      return;
    }
    try {
      const data = JSON.parse(raw) as PersistedData;
      this.experiments = Array.isArray(data.experiments) ? data.experiments : [];
    } catch {
      this.experiments = [];
    }
  }

  private persist(): void {
    const data: PersistedData = { version: 1, experiments: this.experiments };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
    this.revision += 1;
    this.emit();
  }

  /** 仅在持久化状态变化时改变的稳定版本号，供 useSyncExternalStore 使用 */
  getRevision(): number {
    return this.revision;
  }

  list(): ExperimentSummary[] {
    return this.experiments
      .map((notebook) => {
        const results = Object.values(notebook.results);
        return {
          id: notebook.id,
          title: notebook.title,
          parentId: notebook.parentId,
          createdAt: notebook.createdAt,
          updatedAt: notebook.updatedAt,
          cellCount: notebook.cells.length,
          cleanCount: results.filter((result) => result.status === 'clean').length,
          errorCount: results.filter(
            (result) => result.status === 'error' || result.status === 'skipped',
          ).length,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Notebook | null {
    const found = this.experiments.find((notebook) => notebook.id === id);
    return found ? clone(found) : null;
  }

  create(title: string): Notebook {
    const now = Date.now();
    const notebook: Notebook = {
      id: createId('exp'),
      title: title.trim() || '未命名实验',
      cells: [],
      results: {},
      parentId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.experiments = [notebook, ...this.experiments];
    this.setActiveId(notebook.id);
    this.persist();
    return clone(notebook);
  }

  /** 保存一次完整实验：单元输入与对应结果整体写入快照 */
  save(id: string, patch: { title?: string; cells: Cell[]; results: Record<string, CellResult> }): Notebook {
    const index = this.experiments.findIndex((notebook) => notebook.id === id);
    if (index < 0) throw new Error(`实验不存在: ${id}`);
    const current = this.experiments[index];
    const saved: Notebook = {
      ...current,
      title: patch.title?.trim() || current.title,
      cells: clone(patch.cells),
      // 结果只保留当前单元对应的条目，保证输入与结果一一对应
      results: Object.fromEntries(
        patch.cells.map((cell) => [cell.id, clone(patch.results[cell.id])]).filter(
          ([, result]) => result !== undefined,
        ) as [string, CellResult][],
      ),
      updatedAt: Date.now(),
    };
    this.experiments[index] = saved;
    this.persist();
    return clone(saved);
  }

  /** 从已有实验分出支线：深拷贝输入与结果，支线与原实验互不影响 */
  branch(parentId: string, title?: string): Notebook {
    const parent = this.experiments.find((notebook) => notebook.id === parentId);
    if (!parent) throw new Error(`父实验不存在: ${parentId}`);
    const now = Date.now();
    const child: Notebook = {
      ...clone(parent),
      id: createId('exp'),
      title: title?.trim() || `${parent.title} · 支线`,
      parentId: parent.id,
      createdAt: now,
      updatedAt: now,
    };
    this.experiments = [child, ...this.experiments];
    this.setActiveId(child.id);
    this.persist();
    return clone(child);
  }

  remove(id: string): void {
    this.experiments = this.experiments.filter((notebook) => notebook.id !== id);
    if (this.getActiveId() === id) this.storage.removeItem(ACTIVE_KEY);
    this.persist();
  }

  /** 返回从根到该实验的支线链（最早的在前） */
  lineage(id: string): Notebook[] {
    const chain: Notebook[] = [];
    let currentId: string | null = id;
    const guard = new Set<string>();
    while (currentId && !guard.has(currentId)) {
      guard.add(currentId);
      const notebook = this.experiments.find((item) => item.id === currentId);
      if (!notebook) break;
      chain.unshift(notebook);
      currentId = notebook.parentId;
    }
    return chain.map(clone);
  }

  getActiveId(): string | null {
    return this.storage.getItem(ACTIVE_KEY);
  }

  setActiveId(id: string | null): void {
    if (id) this.storage.setItem(ACTIVE_KEY, id);
    else this.storage.removeItem(ACTIVE_KEY);
    this.emit();
  }
}
