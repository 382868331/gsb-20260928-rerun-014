const NAME_RE = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name.trim());
}

/** 单元内容指纹：结果只对相同 name+type+expr 有效 */
export function fingerprintCell(cell: { name: string; type: string; expr: string }): string {
  return `${cell.type}\u0000${cell.name}\u0000${cell.expr}`;
}
