import { useEffect, useState } from "react";
import { useNotebook } from "./store/useNotebook";
import { ExperimentList } from "./pages/ExperimentList";
import { NotebookPage } from "./pages/NotebookPage";
import { UnitEditor } from "./pages/UnitEditor";

export function App() {
  const hydrate = useNotebook((s) => s.hydrate);
  const activeId = useNotebook((s) => s.activeId);
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    setEditingUnitId(null);
  }, [activeId]);

  if (!activeId) return <ExperimentList />;
  if (editingUnitId) {
    return <UnitEditor unitId={editingUnitId} onBack={() => setEditingUnitId(null)} />;
  }
  return <NotebookPage onEditUnit={setEditingUnitId} />;
}
