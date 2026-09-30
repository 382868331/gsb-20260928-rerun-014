import type { Notebook } from '../compute/types';
import { useNotebookEditor } from '../hooks/useNotebookEditor';
import { CellRow } from './CellRow';
import type { ExperimentStore } from '../services/experimentStore';

interface NotebookEditorProps {
  notebook: Notebook;
  store: ExperimentStore;
  onBack: () => void;
  onOpen: (id: string) => void;
}

export function NotebookEditor({ notebook, store, onBack, onOpen }: NotebookEditorProps) {
  const editor = useNotebookEditor(notebook, store);
  const lineage = store.lineage(notebook.id);
  const errorCount = Object.values(editor.results).filter(
    (result) => result.status === 'error' || result.status === 'skipped',
  ).length;

  return (
    <div className="page">
      <header className="editor-header">
        <button type="button" className="link" onClick={onBack}>
          ← 实验列表
        </button>
        <input
          className="title-input"
          value={editor.title}
          aria-label="实验标题"
          onChange={(event) => editor.renameTitle(event.target.value)}
        />
        <div className="header-actions">
          <button type="button" onClick={editor.runAllNow} data-testid="run-all">
            全部重算
          </button>
          <button type="button" onClick={editor.saveNow} data-testid="save">
            保存快照
          </button>
          <button
            type="button"
            onClick={() => {
              const child = editor.branch();
              onOpen(child.id);
            }}
            data-testid="branch"
          >
            分出参数支线
          </button>
        </div>
      </header>

      {lineage.length > 1 && (
        <nav className="lineage" aria-label="支线谱系">
          {lineage.map((item, index) => (
            <span key={item.id} className="lineage-item">
              {index > 0 && <span className="lineage-sep">→</span>}
              <button
                type="button"
                className={item.id === notebook.id ? 'lineage-current' : 'link'}
                disabled={item.id === notebook.id}
                onClick={() => onOpen(item.id)}
              >
                {item.title}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="editor-summary">
        <span>共 {editor.cells.length} 个单元</span>
        <span className={errorCount > 0 ? 'text-error' : ''}>
          {errorCount > 0 ? `${errorCount} 个单元失败/被跳过` : '全部单元正常'}
        </span>
        <span className="hint">编辑后自动增量重算，仅受影响的下游单元会更新</span>
      </div>

      <div className="cell-list">
        {editor.cells.map((cell, index) => (
          <CellRow
            key={cell.id}
            cell={cell}
            index={index}
            total={editor.cells.length}
            result={editor.results[cell.id]}
            onChange={editor.updateCell}
            onRemove={editor.removeCell}
            onMove={editor.moveCell}
          />
        ))}
        {editor.cells.length === 0 && (
          <p className="empty-hint">添加输入单元开始实验，公式中可用其他单元的变量名引用其结果。</p>
        )}
      </div>

      <div className="add-bar">
        <button type="button" onClick={() => editor.addCell('input')} data-testid="add-input">
          + 添加输入单元
        </button>
        <button type="button" onClick={() => editor.addCell('formula')} data-testid="add-formula">
          + 添加公式单元
        </button>
      </div>
    </div>
  );
}
