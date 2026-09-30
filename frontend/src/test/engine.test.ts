import { describe, expect, it } from 'vitest';
import { markStale, runAll, runIncremental } from '../compute/engine';
import { evaluateExpression, extractReferences } from '../compute/evaluator';
import type { Cell } from '../compute/types';
import { fingerprintCell } from '../compute/identifiers';

const input = (id: string, name: string, expr: string): Cell => ({ id, name, type: 'input', expr });
const formula = (id: string, name: string, expr: string): Cell => ({ id, name, type: 'formula', expr });

describe('表达式求值', () => {
  it('支持算术、函数与常量', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluateExpression('sqrt(16) + ln(e)')).toBeCloseTo(5);
    expect(evaluateExpression('a / b', { a: 10, b: 4 })).toBeCloseTo(2.5);
  });

  it('提取变量引用时排除函数名和常量', () => {
    expect(extractReferences('sqrt(a) + max(a, b) * pi').sort()).toEqual(['a', 'a', 'b']);
  });

  it('除零和非法表达式抛出错误', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow('除数为零');
    expect(() => evaluateExpression('a +')).toThrow();
    expect(() => evaluateExpression('a + @')).toThrow('非法字符');
  });
});

describe('计算次序：菱形依赖', () => {
  // a -> b -> d
  // a -> c -> d
  const cells = [
    input('a', 'a', '2'),
    formula('b', 'b', 'a * 10'),
    formula('c', 'c', 'a + 1'),
    formula('d', 'd', 'b + c'),
  ];

  it('按拓扑序执行，d 只计算一次且值正确', () => {
    const report = runAll(cells);
    expect(report.results.d.status).toBe('clean');
    expect(report.results.d.value).toBe(23);
    const dIndex = report.executed.indexOf('d');
    expect(dIndex).toBeGreaterThan(report.executed.indexOf('b'));
    expect(dIndex).toBeGreaterThan(report.executed.indexOf('c'));
    // b、c 都在 a 之后
    expect(report.executed.indexOf('b')).toBeGreaterThan(report.executed.indexOf('a'));
    expect(report.executed.indexOf('c')).toBeGreaterThan(report.executed.indexOf('a'));
  });

  it('修改 a 后只重算 a 及其下游闭包（b、c、d）', () => {
    const first = runAll(cells);
    const changed = cells.map((cell) => (cell.id === 'a' ? { ...cell, expr: '3' } : cell));
    const second = runIncremental(changed, first.results, ['a']);
    expect(second.executed.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(second.results.d.value).toBe(34);
  });

  it('只修改 b 时，c 不重算，a 也不重算', () => {
    const first = runAll(cells);
    const changed = cells.map((cell) => (cell.id === 'b' ? { ...cell, expr: 'a * 100' } : cell));
    const second = runIncremental(changed, first.results, ['b']);
    expect(second.executed.sort()).toEqual(['b', 'd']);
    expect(second.results.d.value).toBe(203);
    // c 直接复用旧结果对象
    expect(second.results.c).toBe(first.results.c);
  });
});

describe('引用成环', () => {
  it('定位环上的单元并给出引用路径，下游被跳过', () => {
    const cells = [
      input('a', 'a', '1'),
      formula('b', 'b', 'c + 1'),
      formula('c', 'c', 'b + 1'),
      formula('d', 'd', 'c * 2'),
    ];
    const report = runAll(cells);
    expect(report.results.b.status).toBe('error');
    expect(report.results.c.status).toBe('error');
    expect(report.results.b.error).toContain('依赖成环');
    expect(report.results.b.error).toMatch(/b → c → b|c → b → c/);
    expect(report.results.d.status).toBe('skipped');
    expect(report.cycles.length).toBe(1);
  });

  it('自环也被识别为环', () => {
    const cells = [formula('x', 'x', 'x + 1')];
    const report = runAll(cells);
    expect(report.results.x.status).toBe('error');
    expect(report.results.x.error).toContain('依赖成环');
  });

  it('打破环后增量恢复成功', () => {
    const cyclic = [formula('b', 'b', 'c + 1'), formula('c', 'c', 'b + 1')];
    const failed = runAll(cyclic);
    expect(failed.results.b.value).toBeNull();
    const fixed = cyclic.map((cell) => (cell.id === 'c' ? { ...cell, expr: '2' } : cell));
    const recovered = runIncremental(fixed, failed.results, ['c']);
    expect(recovered.results.c.status).toBe('clean');
    expect(recovered.results.b.status).toBe('clean');
    expect(recovered.results.b.value).toBe(3);
  });
});

describe('中途报错与失败失效', () => {
  const cells = [
    input('a', 'a', '4'),
    formula('b', 'b', 'sqrt(a)'),
    formula('c', 'c', 'b + 10'),
  ];

  it('上游运行错误时，本单元报错、下游跳过且没有成功值', () => {
    const report = runAll(cells);
    expect(report.results.b.value).toBe(2);
    const broken = cells.map((cell) => (cell.id === 'a' ? { ...cell, expr: '-4' } : cell));
    const failed = runIncremental(broken, report.results, ['a']);
    expect(failed.results.a.status).toBe('clean');
    expect(failed.results.b.status).toBe('error');
    expect(failed.results.b.value).toBeNull();
    expect(failed.results.c.status).toBe('skipped');
    expect(failed.results.c.value).toBeNull();
    // 错误信息可定位到具体单元和原因
    expect(failed.results.c.error).toContain('b');
  });

  it('执行失败后不能把上一版结果继续当作当前成功值', () => {
    const first = runAll(cells);
    expect(first.results.c.value).toBe(12);
    const broken = cells.map((cell) => (cell.id === 'b' ? { ...cell, expr: 'a / 0' } : cell));
    const failed = runIncremental(broken, first.results, ['b']);
    expect(failed.results.b.status).toBe('error');
    expect(failed.results.b.value).toBeNull();
    expect(failed.results.c.status).toBe('skipped');
    expect(failed.results.c.value).toBeNull();

    // 编辑后、重算前也不能显示旧的成功值
    const marked = markStale(broken, first.results, ['b']);
    expect(marked.b.status).toBe('stale');
    expect(marked.c.status).toBe('stale');
  });

  it('引用缺失、重名、输入非法都能定位到单元', () => {
    const bad = [
      input('a', 'a', '1'),
      input('a2', 'a', '2'),
      formula('f', 'f', 'missing + 1'),
      input('g', 'g', 'abc'),
    ];
    const report = runAll(bad);
    expect(report.results.a2.error).toContain('重复');
    expect(report.results.f.error).toContain('不存在');
    expect(report.results.g.error).toContain('不是有效数字');
  });
});

describe('指纹与增量安全', () => {
  it('未在 changedIds 中但指纹已变的单元也会被重算', () => {
    const cells = [input('a', 'a', '1'), formula('b', 'b', 'a * 2')];
    const first = runAll(cells);
    const tampered = cells.map((cell) => (cell.id === 'a' ? { ...cell, expr: '5' } : cell));
    // changedIds 故意只传 b：a 指纹不匹配仍需重算
    const second = runIncremental(tampered, first.results, ['b']);
    expect(second.results.a.value).toBe(5);
    expect(second.results.b.value).toBe(10);
  });

  it('结果指纹对应生成时的单元输入', () => {
    const cell = input('a', 'a', '3');
    const report = runAll([cell]);
    expect(report.results.a.fingerprint).toBe(fingerprintCell(cell));
  });
});
