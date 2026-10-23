/**
 * The reader's own switches (madarch-m38l.6), kept in this browser: whether the
 * grounds of the statements are shown in the text. They are conveniences, so
 * the wiki works with storage blocked and a reader who never touches the switch
 * reads plain statements.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'madarch-show-grounds';
let shown: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (shown === null) {
    try {
      shown = window.localStorage.getItem(KEY) === '1';
    } catch {
      shown = false;
    }
  }
  return shown;
}

/** Sets whether the grounds are shown in the text. */
export function setShowGrounds(value: boolean): void {
  shown = value;
  try {
    window.localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // no storage: the switch holds for this page only
  }
  for (const listener of listeners) listener();
}

/** Forgets what was read, so the next read asks the storage again (a test starts over). */
export function resetPreferences(): void {
  shown = null;
  for (const listener of listeners) listener();
}

export function useShowGrounds(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, read, () => false);
}
