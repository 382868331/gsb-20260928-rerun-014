import { useState } from 'react';
import type { ExperimentStore } from '../services/experimentStore';

interface ExperimentListProps {
  store: ExperimentStore;
  onOpen: (id: string) => void;
}

export function ExperimentList({ store, onOpen }: ExperimentListProps) {
  const [name, setName] = useState('');
  const experiments = store.list();

  return (
    <div className="page">
      <header className="page-header">
        <h1>科研计算笔记本</h1>
        <p className="subtitle">带依赖的计算单元 · 增量重算 · 实验快照与参数支线</p>
      </header>
      <div className="new-experiment">
        <input
          value={name}
          placeholder="新实验名称，如 催化剂筛选-基线"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) {
              const created = store.create(name);
              setName('');
              onOpen(created.id);
            }
          }}
        />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            const created = store.create(name);
            setName('');
            onOpen(created.id);
          }}
        >
          新建实验
        </button>
      </div>
      <ul className="experiment-list">
        {experiments.map((experiment) => (
          <li key={experiment.id} className="experiment-card">
            <div className="experiment-main">
              <button type="button" className="experiment-title" onClick={() => onOpen(experiment.id)}>
                {experiment.title}
              </button>
              <div className="experiment-meta">
                <span>{experiment.cellCount} 个单元</span>
                <span>{experiment.cleanCount} 个成功</span>
                {experiment.errorCount > 0 && <span className="text-error">{experiment.errorCount} 个失败</span>}
                {experiment.parentId && <span className="tag">支线</span>}
              </div>
            </div>
            <div className="experiment-actions">
              <button
                type="button"
                onClick={() => {
                  const child = store.branch(experiment.id);
                  onOpen(child.id);
                }}
              >
                分出支线
              </button>
              <button type="button" className="danger" onClick={() => store.remove(experiment.id)}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {experiments.length === 0 && <p className="empty-hint">还没有实验，先创建一个基线实验。</p>}
    </div>
  );
}
