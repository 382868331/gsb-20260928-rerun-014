type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

type AstNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; arg: AstNode }
  | { kind: 'bin'; op: string; left: AstNode; right: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] };

const IDENT_START = /[A-Za-z_\u4e00-\u9fa5]/;
const IDENT_PART = /[A-Za-z0-9_\u4e00-\u9fa5]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < src.length && /[0-9.]/.test(src[j])) {
        if (src[j] === '.') dots += 1;
        j += 1;
      }
      if (/[eE]/.test(src[j] ?? '') && j + 1 < src.length && /[0-9+\-]/.test(src[j + 1])) {
        j += 2;
        while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      }
      const raw = src.slice(i, j);
      if (dots > 1 || !/^\d+(\.\d+)?([eE][+\-]?\d+)?$|^\.\d+([eE][+\-]?\d+)?$/.test(raw)) {
        throw new Error(`无法解析的数字 "${raw}"`);
      }
      tokens.push({ kind: 'num', value: Number(raw) });
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      tokens.push({ kind: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i += 1;
      continue;
    }
    throw new Error(`非法字符 "${ch}"`);
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    if (this.tokens.length === 0) throw new Error('表达式为空');
    const node = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new Error('表达式存在多余内容');
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('表达式不完整');
    this.pos += 1;
    return token;
  }

  private parseExpr(): AstNode {
    let left = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (token && token.kind === 'op' && (token.value === '+' || token.value === '-')) {
        this.next();
        left = { kind: 'bin', op: token.value, left, right: this.parseTerm() };
      } else {
        return left;
      }
    }
  }

  private parseTerm(): AstNode {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token && token.kind === 'op' && (token.value === '*' || token.value === '/' || token.value === '%')) {
        this.next();
        left = { kind: 'bin', op: token.value, left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): AstNode {
    const token = this.peek();
    if (token && token.kind === 'op' && (token.value === '-' || token.value === '+')) {
      this.next();
      const arg = this.parseUnary();
      return token.value === '-' ? { kind: 'neg', arg } : arg;
    }
    return this.parsePower();
  }

  private parsePower(): AstNode {
    const base = this.parsePrimary();
    const token = this.peek();
    if (token && token.kind === 'op' && token.value === '^') {
      this.next();
      return { kind: 'bin', op: '^', left: base, right: this.parseUnary() };
    }
    return base;
  }

  private parsePrimary(): AstNode {
    const token = this.next();
    if (token.kind === 'num') return { kind: 'num', value: token.value };
    if (token.kind === 'op' && token.value === '-') {
      return { kind: 'neg', arg: this.parseUnary() };
    }
    if (token.kind === 'lparen') {
      const node = this.parseExpr();
      const closing = this.next();
      if (closing.kind !== 'rparen') throw new Error('缺少右括号 ")"');
      return node;
    }
    if (token.kind === 'ident') {
      if (this.peek()?.kind === 'lparen') {
        this.next();
        const args: AstNode[] = [];
        if (this.peek()?.kind !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek()?.kind === 'comma') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        const closing = this.next();
        if (closing.kind !== 'rparen') throw new Error('缺少右括号 ")"');
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'var', name: token.value };
    }
    throw new Error('表达式语法错误');
  }
}

function compile(expr: string): AstNode {
  return new Parser(tokenize(expr)).parse();
}

/** 提取表达式中真正作为变量引用的标识符（排除函数名与常量） */
export function extractReferences(expr: string): string[] {
  const refs: string[] = [];
  const visit = (node: AstNode): void => {
    if (node.kind === 'var') refs.push(node.name);
    if (node.kind === 'bin') {
      visit(node.left);
      visit(node.right);
    }
    if (node.kind === 'neg') visit(node.arg);
    if (node.kind === 'call') node.args.forEach(visit);
  };
  visit(compile(expr));
  // 常量（pi/e）不是对其他单元的引用；函数名在 call 节点中，本就不会出现
  return refs.filter((name) => !Object.prototype.hasOwnProperty.call(CONSTANTS, name));
}

type FnImpl = (...args: number[]) => number;

const FUNCTIONS: Record<string, FnImpl> = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  exp: (x) => Math.exp(x),
  ln: (x) => Math.log(x),
  log: (x) => Math.log10(x),
  log2: (x) => Math.log2(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  pow: (x, y) => Math.pow(x, y),
  min: (...args) => {
    if (args.length === 0) throw new Error('min 至少需要 1 个参数');
    return Math.min(...args);
  },
  max: (...args) => {
    if (args.length === 0) throw new Error('max 至少需要 1 个参数');
    return Math.max(...args);
  },
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

function evalNode(node: AstNode, scope: Record<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'neg':
      return -evalNode(node.arg, scope);
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, node.name)) return CONSTANTS[node.name];
      throw new Error(`未定义的引用 "${node.name}"`);
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`未知函数 "${node.name}"`);
      const result = fn(...node.args.map((arg) => evalNode(arg, scope)));
      if (!Number.isFinite(result)) throw new Error(`函数 ${node.name} 的结果不是有限数值`);
      return result;
    }
    case 'bin': {
      const left = evalNode(node.left, scope);
      const right = evalNode(node.right, scope);
      let result: number;
      switch (node.op) {
        case '+': result = left + right; break;
        case '-': result = left - right; break;
        case '*': result = left * right; break;
        case '/':
          if (right === 0) throw new Error('除数为零');
          result = left / right;
          break;
        case '%':
          if (right === 0) throw new Error('除数为零');
          result = left % right; break;
        case '^': result = left ** right; break;
        default: throw new Error(`不支持的运算符 "${node.op}"`);
      }
      if (!Number.isFinite(result)) throw new Error('计算结果不是有限数值');
      return result;
    }
  }
}

/** 编译并求值；任何编译/运行问题都以 Error 抛出 */
export function evaluateExpression(expr: string, scope: Record<string, number> = {}): number {
  return evalNode(compile(expr), scope);
}
