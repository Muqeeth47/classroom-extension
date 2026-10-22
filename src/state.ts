import type { AppState } from './types';

/** The empty starting state. Shared so the background worker and the popup can never disagree on its shape. */
export function freshState(): AppState {
  return {
    phase: 'idle',
    className: '',
    progress: { done: 0, total: 0, label: '' },
    files: [],
    skipped: [],
    dl: { total: 0, done: 0, failed: 0, failures: [], lastId: null, folder: '' },
    log: [],
    error: '',
  };
}
