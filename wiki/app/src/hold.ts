/**
 * The route the reader is on, shared with the Markdown renderer, and the one
 * way to move between pages on the client side: the new address pushed into
 * the history, so the server can answer it again directly on a reload
 * (requirement `app`, the app's routes).
 */
import { createContext } from 'react';
import type { Route } from './routes.js';

/** What a rendered document needs to know to answer a link: the page it is on. */
export type RouteData = { path?: string; heldPaths: ReadonlySet<string> };

export const routeContext = createContext<RouteData>({ heldPaths: new Set() });

/** Moves the app to an address without a full page load. */
export function navigateTo(address: string): void {
  window.history.pushState({}, '', address);
  window.dispatchEvent(new Event('popstate'));
}

export type { Route };
