import { resolve } from 'node:path';

/** Startup publication is separate from a fill: readers must not prepare schemas while it is in flight. */
export type ManifestPublicationState =
  | { readonly status: 'pending' }
  | { readonly status: 'published' }
  | { readonly status: 'failed'; readonly message: string };

const states = new Map<string, ManifestPublicationState>();

export function setManifestPublicationState(folder: string, state: ManifestPublicationState): void {
  states.set(resolve(folder), state);
}

/** No entry means the caller does not manage startup publication (CLI and standalone readers). */
export function manifestPublicationState(folder: string): ManifestPublicationState | undefined {
  return states.get(resolve(folder));
}

export function manifestPublicationReady(folder: string): boolean {
  const state = manifestPublicationState(folder);
  return state === undefined || state.status === 'published';
}
