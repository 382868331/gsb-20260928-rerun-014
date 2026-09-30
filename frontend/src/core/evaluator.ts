/**
 * 安全的算术表达式求值器：支持 + - * / % ^、括号、数字、以及对其他单元名的引用。
 * 引用通过 resolver 解析为数值；解析失败（缺名/非数/除零）会抛错，由上层定位。
 */

export class EvalError extends Error {}

type Resolver = (name: string) => number;

interface Token {
  type: "num" | "name" | "op" | "lp" | "rp";
  value: string;
}

const NAME_RE = /[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/y;

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ type: "lp", value: ch }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "rp", value: ch }); i++; continue; }
    if ("+-*/%^".includes(ch)) { tokens.push({ type: "op", value: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.eE]/.test(expr[j])) j++;
      const raw = expr.slice(i, j);
      if (Number.isNaN(Number(raw))) throw new EvalError(`无法解析数字 "${raw}"`);
      tokens.push({ type: "num", value: raw });
      i = j;
      continue;
    }
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(expr);
    if (m) {
      tokens.push({ type: "name", value: m[0] });
      i = NAME_RE.lastIndex;
      continue;
    }
    throw new EvalError(`非法字符 "${ch}"`);
  }
  return tokens;
}

export function extractReferences(expression: string): string[] {
  try {
    return tokenize(expression).filter((t) => t.type === "name").map((t) => t.value);
  } catch {
    return [];
  }
}

/** 递归下降解析并求值。文法：expr := term (('+'|'-') term)* ... */
export function evaluate(expression: string, resolve: Resolver): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new EvalError("表达式为空");
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];

  function parseExpr(): number {
    let left = parseTerm();
    while (peek()?.type === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (peek()?.type === "op" && (peek()!.value === "*" || peek()!.value === "/" || peek()!.value === "%")) {
      const op = tokens[pos++].value;
      const right = parseFactor();
      if (op === "*") left = left * right;
      else if (op === "/") {
        if (right === 0) throw new EvalError("除数为零");
        left = left / right;
      } else {
        if (right === 0) throw new EvalError("模数为零");
        left = left % right;
      }
    }
    return left;
  }

  function parseFactor(): number {
    let sign = 1;
    if (peek()?.type === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      if (tokens[pos++].value === "-") sign = -1;
    }
    let base = parsePower() * sign;
    return base;
  }

  function parsePower(): number {
    const base = parsePrimary();
    if (peek()?.type === "op" && peek()!.value === "^") {
      tokens[pos++];
      const exp = parseFactor();
      return base ** exp;
    }
    return base;
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new EvalError("表达式不完整");
    if (t.type === "num") {
      pos++;
      return Number(t.value);
    }
    if (t.type === "name") {
      pos++;
      const v = resolve(t.value);
      if (typeof v !== "number" || Number.isNaN(v)) throw new EvalError(`单元 "${t.value}" 没有有效数值`);
      return v;
    }
    if (t.type === "lp") {
      pos++;
      const v = parseExpr();
      if (peek()?.type !== "rp") throw new EvalError("缺少右括号");
      pos++;
      return v;
    }
    throw new EvalError(`意外的符号 "${t.value}"`);
  }

  const value = parseExpr();
  if (pos !== tokens.length) throw new EvalError(`多余的符号 "${tokens[pos].value}"`);
  if (!Number.isFinite(value)) throw new EvalError("计算结果不是有限数");
  return value;
}
