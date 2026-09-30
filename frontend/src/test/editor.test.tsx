import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExperimentStore, type KVStorage } from '../services/experimentStore';
import { NotebookEditor } from '../components/NotebookEditor';
import type { Notebook } from '../compute/types';

function memStorage(): KVStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

async function flushTimers(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

describe('编辑器集成', () => {
  let store: ExperimentStore;
  let notebook: Notebook;

  beforeEach(() => {
    store = new ExperimentStore(memStorage());
    notebook = store.create('集成实验');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('搭建菱形依赖后结果正确，改输入只刷新下游，失败时旧值不作数', async () => {
    const rendered = render(
      <NotebookEditor notebook={notebook} store={store} onBack={() => undefined} onOpen={() => undefined} />,
    );

    // 三个输入 a、b、c
    fireEvent.click(screen.getByTestId('add-input'));
    fireEvent.click(screen.getByTestId('add-input'));
    fireEvent.click(screen.getByTestId('add-input'));
    fireEvent.click(screen.getByTestId('add-formula'));
    fireEvent.click(screen.getByTestId('add-formula'));

    const typeSelects = screen.getAllByLabelText('单元类型') as HTMLSelectElement[];
    const nameInputs = screen.getAllByLabelText('单元名称') as HTMLInputElement[];
    const exprInputs = screen.getAllByLabelText('单元表达式') as HTMLInputElement[];

    fireEvent.change(typeSelects[1], { target: { value: 'formula' } });
    fireEvent.change(typeSelects[2], { target: { value: 'formula' } });
    fireEvent.change(typeSelects[3], { target: { value: 'formula' } });
    fireEvent.change(typeSelects[4], { target: { value: 'formula' } });
    fireEvent.change(nameInputs[0], { target: { value: 'a' } });
    fireEvent.change(exprInputs[0], { target: { value: '2' } });
    fireEvent.change(nameInputs[1], { target: { value: 'b' } });
    fireEvent.change(exprInputs[1], { target: { value: 'a * 10' } });
    fireEvent.change(nameInputs[2], { target: { value: 'c' } });
    fireEvent.change(exprInputs[2], { target: { value: 'a + 1' } });
    fireEvent.change(nameInputs[3], { target: { value: 'd' } });
    fireEvent.change(exprInputs[3], { target: { value: 'b + c' } });
    fireEvent.change(nameInputs[4], { target: { value: 'e' } });
    fireEvent.change(exprInputs[4], { target: { value: 'd * 2' } });

    await flushTimers();

    // 通过保存后的数据断言计算结果，避免依赖生成的单元 id
    fireEvent.click(screen.getByTestId('save'));
    const saved = store.get(notebook.id)!;
    const byName = Object.fromEntries(saved.cells.map((cell) => [cell.name, cell.id]));
    expect(saved.results[byName.d].value).toBe(23);
    expect(saved.results[byName.e].value).toBe(46);

    // 把 d 改成除零：d 错误，e 被跳过，旧成功值失效
    fireEvent.change(exprInputs[3], { target: { value: 'b / 0' } });
    await flushTimers();
    fireEvent.click(screen.getByTestId('save'));
    const failed = store.get(notebook.id)!;
    expect(failed.results[byName.d].status).toBe('error');
    expect(failed.results[byName.d].value).toBeNull();
    expect(failed.results[byName.e].status).toBe('skipped');
    expect(failed.results[byName.e].value).toBeNull();

    rendered.unmount();
    await flushTimers();
  });
});
