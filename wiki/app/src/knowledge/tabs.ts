/**
 * The knowledge wiki's tabs (madarch-m38l.6; the first version had them): every
 * page the reader opens stands as a tab of the wiki. A plain click on a link
 * opens its page in the tab the reader is on; a middle click or a control click
 * opens it in a new tab; a tab is switched to and closed. The address bar always
 * names the page of the tab in front, so a reload or a copied link opens it.
 *
 * The tabs are the reader's own state of one browser tab: they are kept in
 * `sessionStorage` (a reload keeps them) and the wiki works without it.
 */
import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { appBase, appPath, appRoute } from '../app-base.js';

export interface Tab {
  key: string;
  /** The page's address inside the product's wiki: path, query and hash, without the product's mount. */
  address: string;
  /** The page's name once it has loaded. */
  title: string | null;
}

interface TabsState {
  tabs: Tab[];
  active: string;
}

const listeners = new Set<() => void>();
let state: TabsState | null = null;
let counter = 0;

const storeKey = (): string => `madarch-tabs:${appBase() || '/'}`;

/** The address of the page the window is on, inside the wiki. */
export function currentAddress(): string {
  return `${appRoute(window.location.pathname)}${window.location.search}${window.location.hash}`;
}

function remember(): void {
  try {
    if (state !== null) window.sessionStorage.setItem(storeKey(), JSON.stringify(state));
  } catch {
    // no storage: the tabs live as long as the page does
  }
}

function recall(): TabsState | null {
  try {
    const raw = window.sessionStorage.getItem(storeKey());
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    if (!Array.isArray(parsed.tabs) || typeof parsed.active !== 'string') return null;
    const tabs = parsed.tabs.filter((tab): tab is Tab => tab !== null && typeof tab === 'object' && typeof tab.key === 'string' && typeof tab.address === 'string' && (typeof tab.title === 'string' || tab.title === null));
    if (tabs.length === 0 || !tabs.some((tab) => tab.key === parsed.active)) return null;
    counter = Math.max(counter, ...tabs.map((tab) => Number(tab.key.replace(/\D/g, '')) || 0));
    return { tabs, active: parsed.active };
  } catch {
    return null;
  }
}

function current(): TabsState {
  if (state !== null) return state;
  const address = currentAddress();
  const held = recall();
  if (held !== null) {
    // The window is on the page the front tab names, or the reader followed a link into a fresh load: that page is the front tab's.
    state = { tabs: held.tabs.map((tab) => (tab.key === held.active ? { ...tab, address } : tab)), active: held.active };
  } else {
    counter += 1;
    state = { tabs: [{ key: `t${counter}`, address, title: null }], active: `t${counter}` };
  }
  return state;
}

function set(next: TabsState): void {
  state = next;
  remember();
  for (const listener of listeners) listener();
}

/** Forgets every tab (a test starts over; a product opened anew starts with its one tab). */
export function resetTabs(): void {
  state = null;
  counter = 0;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', onPop);
  };
};

/** The window moved to a page (a link, the back button): the tab in front shows it. */
function onPop(): void {
  const now = current();
  const address = currentAddress();
  const front = now.tabs.find((tab) => tab.key === now.active);
  if (front?.address === address) return;
  set({ ...now, tabs: now.tabs.map((tab) => (tab.key === now.active ? { ...tab, address, title: null } : tab)) });
}

export function useTabs(): TabsState {
  return useSyncExternalStore(subscribe, current, current);
}

/** The tab in front. */
export const frontTab = (): Tab => current().tabs.find((tab) => tab.key === current().active)!;

function show(address: string): void {
  if (currentAddress() !== address) window.history.pushState({}, '', appPath(address));
}

/** Opens a page in a new tab and brings it to the front; a page already open in a tab is switched to instead. */
export function openInNewTab(address: string): void {
  const now = current();
  const open = now.tabs.find((tab) => tab.address === address);
  if (open !== undefined) {
    activateTab(open.key);
    return;
  }
  counter += 1;
  const key = `t${counter}`;
  const at = now.tabs.findIndex((tab) => tab.key === now.active);
  const tabs = [...now.tabs.slice(0, at + 1), { key, address, title: null }, ...now.tabs.slice(at + 1)];
  show(address);
  set({ tabs, active: key });
}

export function activateTab(key: string): void {
  const now = current();
  const tab = now.tabs.find((candidate) => candidate.key === key);
  if (tab === undefined) return;
  show(tab.address);
  set({ ...now, active: key });
}

/** Closes a tab; the tab beside it comes to the front when it was the one in front. The last tab stays. */
export function closeTab(key: string): void {
  const now = current();
  if (now.tabs.length <= 1) return;
  const at = now.tabs.findIndex((tab) => tab.key === key);
  if (at < 0) return;
  const tabs = now.tabs.filter((tab) => tab.key !== key);
  if (now.active !== key) {
    set({ ...now, tabs });
    return;
  }
  const next = tabs[Math.min(at, tabs.length - 1)]!;
  show(next.address);
  set({ tabs, active: next.key });
}

/** The page the window is on changed without a move (a link to a section of the same document): the tab in front names it, so coming back to the tab opens the same place. */
export function syncFrontTabAddress(): void {
  const now = current();
  const address = currentAddress();
  const front = now.tabs.find((tab) => tab.key === now.active);
  if (front === undefined || front.address === address) return;
  set({ ...now, tabs: now.tabs.map((tab) => (tab.key === now.active ? { ...tab, address } : tab)) });
}

/** Names a tab by the page it holds. */
export function setTabTitle(key: string, title: string): void {
  const now = current();
  const tab = now.tabs.find((candidate) => candidate.key === key);
  if (tab === undefined || tab.title === title) return;
  set({ ...now, tabs: now.tabs.map((candidate) => (candidate.key === key ? { ...candidate, title } : candidate)) });
}

/** Whether a click asks for a new tab: control or command, or the middle button. */
export const wantsNewTab = (event: { ctrlKey: boolean; metaKey: boolean; button: number }): boolean => event.ctrlKey || event.metaKey || event.button === 1;

/** Whether a click is left to the browser: shift (a window of its own) or alt. */
const leftToBrowser = (event: { shiftKey: boolean; altKey: boolean; button: number }): boolean => event.shiftKey || event.altKey || (event.button !== 0 && event.button !== 1);

/**
 * The handlers of a link to an address inside the wiki: a plain click shows the page in the tab in front, a control or
 * middle click in a new tab.
 */
export function linkHandlers(address: string, before?: () => void): { onClick: (event: MouseEvent<HTMLElement>) => void; onAuxClick: (event: MouseEvent<HTMLElement>) => void } {
  const go = (event: MouseEvent<HTMLElement>): void => {
    if (leftToBrowser(event)) return;
    event.preventDefault();
    before?.();
    if (wantsNewTab(event)) openInNewTab(address);
    else {
      window.history.pushState({}, '', appPath(address));
      window.dispatchEvent(new Event('popstate'));
    }
  };
  return {
    onClick: go,
    // The middle button arrives as `auxclick`; other auxiliary buttons are the browser's.
    onAuxClick: (event) => { if (event.button === 1) go(event); },
  };
}

/** Names the tab in front by the page this view shows; null while the page loads. */
export function useTabTitle(title: string | null): void {
  const { active } = useTabs();
  useEffect(() => {
    if (title !== null && title !== '') setTabTitle(active, title);
  }, [active, title]);
}
