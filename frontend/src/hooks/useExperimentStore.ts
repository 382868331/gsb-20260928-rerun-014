import { useSyncExternalStore } from 'react';
import { ExperimentStore } from '../services/experimentStore';

let singleton: ExperimentStore | null = null;

export function getExperimentStore(): ExperimentStore {
  if (!singleton) singleton = new ExperimentStore();
  return singleton;
}

export function useExperimentStore(): ExperimentStore {
  const store = getExperimentStore();
  useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => `${store.getRevision()}:${store.getActiveId() ?? ''}`,
    () => null,
  );
  return store;
}
