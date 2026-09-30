import type { Cell, CellResult } from '../compute/types';
import { formatNumber } from '../services/format';

interface CellRowProps {
  cell: Cell;
  index: number;
  total: number;
  result: CellResult | undefined;
  onChange: (id: string, patch: Partial<Omit<Cell, 'id'>>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

const STATUS_LABEL: Record<CellResult['status'], string> = {
  clean: '成功',
  error: '错误',
  stale: '待重算',
  skipped: '已跳过',
  pending: '未执行',
};

export function CellRow({ cell, index, total, result, onChange, onRemove, onMove }: CellRowProps) {
  const status = result?.status ?? 'pending';
  return (
    <section className={`cell-row status-${status}`} data-testid={`cell-row-${cell.id}`}>
      <div className="cell-index">{index + 1}</div>
      <div className="cell-fields">
        <div className="cell-line">
          <select
            className="cell-type"
            value={cell.type}
            aria-label="单元类型"
            onChange={(event) => onChange(cell.id, { type: event.target.value as Cell['type'] })}
          >
            <option value="input">输入</option>
            <option value="formula">公式</option>
          </select>
          <input
            className="cell-name"
            value={cell.name}
            aria-label="单元名称"
            placeholder="变量名"
            onChange={(event) => onChange(cell.id, { name: event.target.value })}
          />
          <span className="cell-eq">=</span>
          <input
            className="cell-expr"
            value={cell.expr}
            aria-label="单元表达式"
            placeholder={cell.type === 'input' ? '数值，如 3.14' : '表达式，如 a + b * 2'}
            onChange={(event) => onChange(cell.id, { expr: event.target.value })}
          />
        </div>
        <div className="cell-meta">
          <span className={`badge badge-${status}`} data-testid={`status-${cell.id}`}>
            {STATUS_LABEL[status]}
          </span>
          {status === 'clean' && (
            <span className="cell-value" data-testid={`value-${cell.id}`}>
              {formatNumber(result?.value)}
            </span>
          )}
          {(status === 'error' || status === 'skipped') && (
            <span className="cell-error" data-testid={`error-${cell.id}`}>
              {result?.error}
            </span>
          )}
          {status === 'stale' && <span className="cell-hint">输入已变更，等待重算…</span>}
          {result?.deps && result.deps.length > 0 && (
            <span className="cell-deps">依赖 {result.deps.length} 个上游</span>
          )}
        </div>
      </div>
      <div className="cell-actions">
        <button type="button" onClick={() => onMove(cell.id, -1)} disabled={index === 0} aria-label="上移">
          ↑
        </button>
        <button type="button" onClick={() => onMove(cell.id, 1)} disabled={index === total - 1} aria-label="下移">
          ↓
        </button>
        <button type="button" className="danger" onClick={() => onRemove(cell.id)} aria-label="删除单元">
          删除
        </button>
      </div>
    </section>
  );
}
