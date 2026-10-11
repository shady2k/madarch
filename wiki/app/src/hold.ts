/**
 * The route the reader is on, shared with the Markdown renderer, and the one
 * way to move between pages on the client side: the new address pushed into
 * the history, so the server can answer it again directly on a reload
 * (requirement `app`, the app's routes). The same module holds the status
 * line: what the shell's bottom bar shows — the open document's facts,
 * published by whatever the shell holds.
 */
import { createContext } from 'react';
import type { Route } from './routes.js';

/** What a rendered document needs to know to answer a link: the page it is on, and the open stage's id when the route is a stage's. */
export type RouteData = { path?: string; stage?: string; architecture?: { kind: string; title: string }; heldPaths: ReadonlySet<string> };

export const routeContext = createContext<RouteData>({ heldPaths: new Set() });

/** The status line the shell's bottom edge shows: what is open publishes, the shell reads. `null` shows nothing. */
export type StatusPublish = {
  publish: (parts: readonly string[] | null) => void;
  parts: readonly string[] | null;
  connection: 'live' | 'reconnecting';
};

export const statusContext = createContext<StatusPublish>({
  publish: (): void => undefined,
  parts: null,
  connection: 'reconnecting',
});

/** Moves the app to an address without a full page load. */
export function navigateTo(address: string): void {
  window.history.pushState({}, '', address);
  window.dispatchEvent(new Event('popstate'));
}

export type { Route };
