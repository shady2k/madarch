import { resolve } from 'node:path';

/** Startup publication is separate from a fill: readers must not prepare schemas while it is in flight. */
export type ManifestPublicationState =
  | { readonly status: 'pending' }
  | { readonly status: 'published' }
  | { readonly status: 'failed'; readonly message: string };

const states = new Map<string, ManifestPublicationState>();
const waiters = new Map<string, Set<(state: ManifestPublicationState) => void>>();

export function setManifestPublicationState(folder: string, state: ManifestPublicationState): void {
  const key = resolve(folder);
  states.set(key, state);
  if (state.status !== 'pending') {
    const waiting = waiters.get(key);
    waiters.delete(key);
    for (const settle of waiting ?? []) settle(state);
  }
}

/** No entry means the caller does not manage startup publication (CLI and standalone readers). */
export function manifestPublicationState(folder: string): ManifestPublicationState | undefined {
  return states.get(resolve(folder));
}

export function manifestPublicationReady(folder: string): boolean {
  const state = manifestPublicationState(folder);
  return state === undefined || state.status === 'published';
}

/** Waits for startup publication without opening the store or scheduling a polling timer. */
export function waitForManifestPublication(folder: string, signal?: AbortSignal): Promise<ManifestPublicationState | undefined> {
  const key = resolve(folder);
  const state = states.get(key);
  if (state?.status !== 'pending') return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const waiting = waiters.get(key) ?? new Set();
    const cleanup = () => {
      waiting.delete(settle);
      if (waiting.size === 0) waiters.delete(key);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (next: ManifestPublicationState) => {
      cleanup();
      resolve(next);
    };
    const abort = () => {
      cleanup();
      reject(new Error('the wiki is shutting down'));
    };
    if (signal?.aborted) { abort(); return; }
    waiting.add(settle);
    waiters.set(key, waiting);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
