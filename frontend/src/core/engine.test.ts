import { describe, expect, it } from "vitest";
import { affectedDownstream, buildGraph, runGraph, topologicalOrder } from "./engine";
import type { ComputeUnit } from "./types";

function unit(id: string, name: string, kind: "input" | "formula", body: string): ComputeUnit {
  return kind === "input"
    ? { id, name, kind, value: body }
    : { id, name, kind, expression: body };
}

/** 菱形：a -> b、a -> c；b,c -> d。d 只应在 b、c 之后执行一次。 */
function diamond(): ComputeUnit[] {
  return [
    unit("d", "d", "formula", "b + c"),
    unit("b", "b", "formula", "a * 2"),
    unit("c", "c", "formula", "a + 10"),
    unit("a", "a", "input", "5"),
  ];
}

describe("拓扑次序与菱形依赖", () => {
  it("按依赖次序执行，菱形汇点只出现一次", () => {
    const units = diamond();
    const graph = buildGraph(units);
    const { order, cycle } = topologicalOrder(units, graph);
    expect(cycle).toBeNull();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    expect(order.filter((id) => id === "d")).toHaveLength(1);
  });

  it("计算出正确数值", () => {
    const { results } = runGraph(diamond());
    expect(results.a.value).toBe(5);
    expect(results.b.value).toBe(10);
    expect(results.c.value).toBe(15);
    expect(results.d.value).toBe(25);
  });

  it("受影响集合包含全部下游且菱形汇点不重复", () => {
    const graph = buildGraph(diamond());
    const affected = affectedDownstream(["a"], graph);
    expect([...affected].sort()).toEqual(["a", "b", "c", "d"]);
    expect(affectedDownstream(["b"], graph)).toEqual(new Set(["b", "d"]));
  });
});

describe("增量重算", () => {
  it("修改输入后只重算受影响下游，未受影响单元沿用旧结果", () => {
    const units = diamond();
    const first = runGraph(units);
    expect(first.executed).toContain("d");

    // 新增与菱形无关的单元 e，并只触发 e。
    const withE = [...units, unit("e", "e", "input", "100")];
    const second = runGraph(withE, ["e"], first.results);
    expect(second.executed).toEqual(["e"]);
    expect(second.results.d.value).toBe(25);
    expect(second.results.e.value).toBe(100);
  });

  it("修改菱形源头输入会重算 b、c、d", () => {
    const first = runGraph(diamond());
    const changed = diamond().map((u) => (u.id === "a" ? { ...u, value: "6" } : u));
    const second = runGraph(changed, ["a"], first.results);
    expect([...second.executed].sort()).toEqual(["a", "b", "c", "d"]);
    expect(second.results.d.value).toBe(28);
  });
});

describe("引用成环", () => {
  it("检测成环并在环上单元定位错误，不产出成功值", () => {
    const units = [
      unit("a", "a", "formula", "b + 1"),
      unit("b", "b", "formula", "c + 1"),
      unit("c", "c", "formula", "a + 1"),
    ];
    const { results, cycle, order } = runGraph(units, undefined, {});
    expect(cycle).not.toBeNull();
    expect(cycle!.sort()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(results[id].status).toBe("error");
      expect(results[id].value).toBeNull();
      expect(results[id].error).toContain("环");
    }
    expect(order).toEqual([]);
  });

  it("直接自引用报错", () => {
    const units = [unit("a", "a", "formula", "a + 1")];
    const { results } = runGraph(units);
    expect(results.a.status).toBe("error");
  });

  it("引用不存在的单元报错", () => {
    const units = [unit("a", "a", "formula", "z + 1")];
    const { results } = runGraph(units);
    expect(results.a.error).toContain("不存在");
  });

  it("环不连累独立计算，失败只落在环及其下游", () => {
    const units = [
      unit("a", "a", "formula", "b + 1"),
      unit("b", "b", "formula", "a + 1"),
      unit("c", "c", "formula", "a * 2"),
      unit("x", "x", "input", "5"),
      unit("y", "y", "formula", "x * 3"),
    ];
    const { results, cycle } = runGraph(units);
    expect(cycle).not.toBeNull();
    // 环成员与环的下游报错，且不带成功值。
    for (const id of ["a", "b", "c"]) {
      expect(results[id].status).toBe("error");
      expect(results[id].value).toBeNull();
    }
    expect(results.c.error).toContain("环");
    // 独立计算照常产出结果。
    expect(results.x).toMatchObject({ status: "ok", value: 5 });
    expect(results.y).toMatchObject({ status: "ok", value: 15 });
  });

  it("被阻断的结果带有完整依赖链", () => {
    const units = [
      unit("a", "a", "formula", "b + 1"),
      unit("b", "b", "formula", "a + 1"),
      unit("c", "c", "formula", "a * 2"),
      unit("d", "d", "formula", "c + 1"),
    ];
    const { results } = runGraph(units);
    expect(results.a.chain![0]).toBe("a");
    expect(results.a.chain![results.a.chain!.length - 1]).toBe("a");
    // d 的链从环出发、经过 c、到 d。
    expect(results.d.chain!.slice(-2)).toEqual(["c", "d"]);
    expect(results.d.chain!.length).toBeGreaterThanOrEqual(4);
  });

  it("断开环后局部恢复：只重算受阻部分，无关成功记录保留", () => {
    const cyclic = [
      unit("a", "a", "formula", "b + 1"),
      unit("b", "b", "formula", "a + 1"),
      unit("c", "c", "formula", "a * 2"),
      unit("x", "x", "input", "5"),
      unit("y", "y", "formula", "x * 3"),
    ];
    const blocked = runGraph(cyclic);
    expect(blocked.results.c.status).toBe("error");

    // 把 b 改成不依赖 a，环断开。
    const fixed = cyclic.map((u) => (u.id === "b" ? { ...u, expression: "x + 1" } : u));
    const healed = runGraph(fixed, ["b"], blocked.results);
    expect(healed.cycle).toBeNull();
    expect(healed.results.a).toMatchObject({ status: "ok", value: 7 });
    expect(healed.results.b).toMatchObject({ status: "ok", value: 6 });
    expect(healed.results.c).toMatchObject({ status: "ok", value: 14 });
    // 无关单元未被重算，成功记录原样保留。
    expect(healed.executed).not.toContain("x");
    expect(healed.executed).not.toContain("y");
    expect(healed.results.y).toMatchObject({ status: "ok", value: 15 });
  });

  it("删除环中单元后，幸存单元重算且不留旧成功预览", () => {
    const cyclic = [
      unit("a", "a", "formula", "b + 1"),
      unit("b", "b", "formula", "a + 1"),
      unit("x", "x", "input", "5"),
    ];
    const blocked = runGraph(cyclic);
    // 删除 b：a 引用不到 b 报错，x 保持成功。
    const remaining = cyclic.filter((u) => u.id !== "b");
    const after = runGraph(remaining, ["a"], blocked.results);
    expect(after.results.a.status).toBe("error");
    expect(after.results.a.value).toBeNull();
    expect(after.results.x).toMatchObject({ status: "ok", value: 5 });
    expect(after.results.b).toBeUndefined();
  });

  it("改名后旧结果指纹失效，不残留指向旧定义的成功预览", () => {
    const units = [unit("a", "a", "input", "5"), unit("f", "f", "formula", "a * 2")];
    const first = runGraph(units);
    expect(first.results.f.value).toBe(10);
    const renamed = units.map((u) => (u.id === "a" ? { ...u, name: "g" } : u));
    const second = runGraph(renamed, ["a"], first.results);
    // f 引用的 a 不复存在，必须报错而不是沿用 10。
    expect(second.results.f.status).toBe("error");
    expect(second.results.f.value).toBeNull();
    expect(second.results.a).toMatchObject({ status: "ok", value: 5 });
  });
});

describe("中途报错与旧值失效", () => {
  it("除零失败时清空旧成功值，下游不冒充成功", () => {
    const units = [
      unit("a", "a", "input", "4"),
      unit("z", "z", "input", "2"),
      unit("b", "b", "formula", "a / z"),
      unit("c", "c", "formula", "b + 1"),
    ];
    const first = runGraph(units);
    expect(first.results.b.value).toBe(2);
    expect(first.results.c.value).toBe(3);

    const broken = units.map((u) => (u.id === "z" ? { ...u, value: "0" } : u));
    const second = runGraph(broken, ["z"], first.results);
    expect(second.results.b.status).toBe("error");
    expect(second.results.b.value).toBeNull();
    expect(second.results.b.error).toContain("除数为零");
    expect(second.results.c.status).toBe("error");
    expect(second.results.c.value).toBeNull();
    expect(second.results.c.error).toContain("上游");
    // 未受影响的 a 保持成功值。
    expect(second.results.a.status).toBe("ok");
    expect(second.results.a.value).toBe(4);
  });

  it("修复后能恢复成功值", () => {
    const units = [
      unit("a", "a", "input", "4"),
      unit("z", "z", "input", "0"),
      unit("b", "b", "formula", "a / z"),
    ];
    const broken = runGraph(units);
    expect(broken.results.b.value).toBeNull();
    const fixed = units.map((u) => (u.id === "z" ? { ...u, value: "2" } : u));
    const healed = runGraph(fixed, ["z"], broken.results);
    expect(healed.results.b.status).toBe("ok");
    expect(healed.results.b.value).toBe(2);
  });

  it("非法输入报错且不产生数值", () => {
    const units = [unit("a", "a", "input", "abc")];
    const { results } = runGraph(units);
    expect(results.a.status).toBe("error");
    expect(results.a.value).toBeNull();
  });
});
