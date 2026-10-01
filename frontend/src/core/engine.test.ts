import { describe, expect, it } from "vitest";
import { affectedDownstream, buildGraph, findCycles, runGraph, topologicalOrder } from "./engine";
import type { ComputeUnit } from "./types";

let seq = 0;
function unit(id: string, name: string, kind: "input" | "formula", body: string): ComputeUnit {
  seq += 1;
  return kind === "input"
    ? { id, name, kind, value: body, version: seq }
    : { id, name, kind, expression: body, version: seq };
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
    const order = topologicalOrder(units, graph, new Set());
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
    expect([...affectedDownstream(["a"], graph)].sort()).toEqual(["a", "b", "c", "d"]);
    expect(affectedDownstream(["b"], graph)).toEqual(new Set(["b", "d"]));
  });
});

describe("增量重算", () => {
  it("修改输入后只重算受影响下游，未受影响单元沿用旧结果", () => {
    const units = diamond();
    const first = runGraph(units);
    expect(first.executed).toContain("d");

    const withE = [...units, unit("e", "e", "input", "100")];
    const second = runGraph(withE, ["e"], first.results);
    expect(second.executed).toEqual(["e"]);
    expect(second.results.d.value).toBe(25);
    expect(second.results.e.value).toBe(100);
  });

  it("修改菱形源头输入会重算 b、c、d，且新结果不会误用旧值", () => {
    const first = runGraph(diamond());
    const changed = diamond().map((u) => (u.id === "a" ? { ...u, value: "6" } : u));
    const second = runGraph(changed, ["a"], first.results);
    expect([...second.executed].sort()).toEqual(["a", "b", "c", "d"]);
    expect(second.results.d.value).toBe(28);
    // 旧 revision 与新输入不一致，沿用保护必须拒绝旧成功值。
    expect(second.results.a.revision).not.toBe(first.results.a.revision);
  });
});

describe("引用环的受阻范围隔离", () => {
  /** p <-> q 成环，r 依赖环被阻塞；独立常量 k 与其下游 h 必须照常计算。 */
  function ringWithIndependent(): ComputeUnit[] {
    return [
      unit("p", "p", "formula", "q + 1"),
      unit("q", "q", "formula", "p + 1"),
      unit("r", "r", "formula", "p * 3"),
      unit("k", "k", "input", "7"),
      unit("h", "h", "formula", "k * 2"),
    ];
  }

  it("Tarjan 找到环成员", () => {
    const units = ringWithIndependent();
    const cycles = findCycles(units, buildGraph(units));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(["p", "q"]);
  });

  it("环只阻塞环及其下游；独立常量和其下游照常产出结果", () => {
    const { results, order, cycleIds, blockedIds } = runGraph(ringWithIndependent());
    expect([...cycleIds].sort()).toEqual(["p", "q"]);
    expect(blockedIds).toEqual(new Set(["r"]));
    // 独立部分正常成功。
    expect(results.k.status).toBe("ok");
    expect(results.k.value).toBe(7);
    expect(results.h.status).toBe("ok");
    expect(results.h.value).toBe(14);
    // 环与下游失败且无值。
    for (const id of ["p", "q", "r"]) {
      expect(results[id].status).toBe("error");
      expect(results[id].value).toBeNull();
    }
    expect(results.p.errorKind).toBe("cycle");
    expect(results.r.errorKind).toBe("upstream");
    // 执行次序只包含可执行单元。
    expect(order.sort()).toEqual(["h", "k"]);
  });

  it("断开环后只恢复环与其下游，独立单元不重算", () => {
    const units = ringWithIndependent();
    const first = runGraph(units);

    // 断开环：q 改为引用独立常量 k。
    const healedDefs = units.map((u) =>
      u.id === "q" ? { ...u, expression: "k + 1", version: u.version + 1 } : u,
    );
    const second = runGraph(healedDefs, ["q"], first.results);
    expect(second.results.p.status).toBe("ok");
    expect(second.results.q.status).toBe("ok");
    expect(second.results.q.value).toBe(8);
    expect(second.results.p.value).toBe(9);
    expect(second.results.r.status).toBe("ok");
    expect(second.results.r.value).toBe(27);
    // k、h 未受影响，沿用旧成功结果，不在 executed 中。
    expect(second.executed).not.toContain("k");
    expect(second.executed).not.toContain("h");
    expect(second.results.h.value).toBe(14);
  });

  it("一个情景形成环不影响另一独立分支：再次成环后独立结果仍保留", () => {
    const units = ringWithIndependent();
    const first = runGraph(units);
    // 重新制造环（p 改表达式仍引用 q，本身已是环，这里改 r 再引用 r 之外不动），独立结果沿用。
    const again = units.map((u) => (u.id === "h" ? { ...u, expression: "k * 3", version: u.version + 1 } : u));
    const second = runGraph(again, ["h"], first.results);
    expect(second.results.h.value).toBe(21);
    expect(second.results.p.status).toBe("error");
    expect(second.results.k.status).toBe("ok");
  });

  it("直接自引用与引用不存在分别报定义错误", () => {
    const selfRef = [unit("a", "a", "formula", "a + 1")];
    expect(runGraph(selfRef).results.a.error).toContain("自身");
    const missing = [unit("a", "a", "formula", "z + 1")];
    expect(runGraph(missing).results.a.error).toContain("不存在");
  });
});

describe("中途报错与旧值失效", () => {
  it("除零失败时清空旧成功值，下游不冒充成功；未受影响输入保留", () => {
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
    expect(second.results.c.status).toBe("error");
    expect(second.results.c.value).toBeNull();
    expect(second.results.a.value).toBe(4);
  });

  it("修复后自动恢复成功值", () => {
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
});
