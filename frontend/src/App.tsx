import { useState } from 'react';
import { useExperimentStore } from './hooks/useExperimentStore';
import { ExperimentList } from './components/ExperimentList';
import { NotebookEditor } from './components/NotebookEditor';

export default function App() {
  const store = useExperimentStore();
  const [activeId, setActiveId] = useState<string | null>(() => store.getActiveId());

  const open = (id: string) => {
    store.setActiveId(id);
    setActiveId(id);
  };

  const back = () => {
    store.setActiveId(null);
    setActiveId(null);
  };

  if (activeId) {
    const notebook = store.get(activeId);
    if (notebook) return <NotebookEditor notebook={notebook} store={store} onBack={back} onOpen={open} />;
  }
  return <ExperimentList store={store} onOpen={open} />;
}
