/**
 * The wiki's open pages: every page the reader opens stands as a tab of the window (the first version had them). A plain
 * press shows a page in the tab in front, a control, command or middle press opens it in a new tab, a tab is switched to
 * and closed, and the address bar always names the page of the tab in front, so a reload or a copied link opens it.
 *
 * The tabs are the reader's own state of one window: they are kept in `sessionStorage` under the address the app is
 * served at, and the wiki works without it. Nothing here knows a page: a tab holds the address the app opens.
 */

/** One open page: its key, the address inside the product's wiki, and the name the page gave itself once it loaded. */
export interface WikiTab {
  readonly key: string;
  readonly address: string;
  readonly title: string | null;
}

/** The window's tabs, the tab in front, and the number the next key counts from. */
export interface TabsState {
  readonly tabs: readonly WikiTab[];
  readonly active: string;
  readonly counter: number;
}

/** The window's storage for its tabs, or null where the window refuses it: the tabs then live as long as the page. */
export function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Where a window keeps its tabs: one key per address the app is served at. */
export function tabsKey(base: string): string {
  return `madarch-tabs:${base === '' ? '/' : base}`;
}

/** The one tab a window opens with: the page it stands at, named once the page says its own name. */
export function firstTabs(address: string): TabsState {
  return { tabs: [{ key: 't1', address, title: null }], active: 't1', counter: 1 };
}

function isTab(value: unknown): value is WikiTab {
  if (value === null || typeof value !== 'object') return false;
  const held = value as Partial<WikiTab>;
  return typeof held.key === 'string' && typeof held.address === 'string' && (typeof held.title === 'string' || held.title === null);
}

/**
 * The tabs this window kept, or the one tab the address opens. A window that stands at another page — a link followed
 * into the wiki — keeps the tabs and shows that page in the tab in front, as the reload of that link would.
 */
/** The number a tab's key ends with, or undefined when it holds none: the digits of its own text, read as one number. */
function digitsOf(text: string): number | undefined {
  let digits = '';
  for (const character of text) if (character >= '0' && character <= '9') digits += character;
  return digits === '' ? undefined : Number(digits);
}

export function recallTabs(storage: Storage | null, base: string, address: string): TabsState {
  if (storage !== null) {
    try {
      const raw = storage.getItem(tabsKey(base));
      const held = raw === null ? null : (JSON.parse(raw) as Partial<TabsState>);
      const tabs = held !== null && Array.isArray(held.tabs) ? held.tabs.filter(isTab) : [];
      if (held !== null && typeof held.active === 'string' && tabs.length > 0 && tabs.some((tab) => tab.key === held.active)) {
        const counter = tabs.reduce((most, tab) => Math.max(most, digitsOf(tab.key) ?? 0), 0);
        return {
          tabs: tabs.map((tab) => (tab.key === held.active ? { ...tab, address } : tab)),
          active: held.active,
          counter,
        };
      }
    } catch {
      // A window that refuses storage, or holds something else under the key, opens one tab.
    }
  }
  return firstTabs(address);
}

/** Keeps the tabs for this window's next page; a window that refuses storage keeps them for as long as the page does. */
export function rememberTabs(storage: Storage | null, base: string, state: TabsState): void {
  if (storage === null) return;
  try {
    storage.setItem(tabsKey(base), JSON.stringify(state));
  } catch {
    // A window that refuses storage keeps the tabs for as long as the page does.
  }
}

/** The tab in front. */
export function activeTab(state: TabsState): WikiTab {
  return state.tabs.find((tab) => tab.key === state.active) ?? state.tabs[0]!;
}

/** The page the tab in front names: the address the window stands at. */
export function activeAddress(state: TabsState): string {
  return activeTab(state).address;
}

/** A page opened in the tab in front: the address changes, and the name is read again for it. */
export function navigateInTab(state: TabsState, address: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === state.active ? { ...tab, address, title: tab.address === address ? tab.title : null } : tab)),
  };
}

/**
 * A page opened in a tab of its own: a tab that already holds it comes forward, else a new one stands beside the tab in
 * front and takes the window.
 */
export function openInTab(state: TabsState, address: string): TabsState {
  const open = state.tabs.find((tab) => tab.address === address);
  if (open !== undefined) return { ...state, active: open.key };
  const counter = state.counter + 1;
  const key = `t${String(counter)}`;
  const at = state.tabs.findIndex((tab) => tab.key === state.active);
  const tabs = [...state.tabs.slice(0, at + 1), { key, address, title: null }, ...state.tabs.slice(at + 1)];
  return { tabs, active: key, counter };
}

/**
 * A press on an address: a tab of its own when the press asked for one, else the tab in front — or the tab that already
 * holds that page, which comes forward rather than standing twice.
 */
export function openPage(state: TabsState, address: string, newTab: boolean): TabsState {
  if (newTab) return openInTab(state, address);
  const held = state.tabs.find((tab) => tab.address === address);
  return held === undefined ? navigateInTab(state, address) : { ...state, active: held.key };
}

/** A tab the reader pressed comes to the front; a key no tab holds changes nothing. */
export function activateTab(state: TabsState, key: string): TabsState {
  return state.tabs.some((tab) => tab.key === key) ? { ...state, active: key } : state;
}

/** A tab closed: the tab beside it comes forward when the one in front went, and the last tab stays. */
export function closeTab(state: TabsState, key: string): TabsState {
  if (state.tabs.length <= 1) return state;
  const at = state.tabs.findIndex((tab) => tab.key === key);
  if (at < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  if (state.active !== key) return { ...state, tabs };
  const next = tabs[Math.min(at, tabs.length - 1)]!;
  return { ...state, tabs, active: next.key };
}

/** The name a page gave itself, written on its tab. */
export function titleTab(state: TabsState, key: string, title: string): TabsState {
  const held = state.tabs.find((tab) => tab.key === key);
  if (held === undefined || held.title === title) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, title } : tab)) };
}

/**
 * The window moved without a press of the app's own — the back and forward buttons, or a link the browser followed: the
 * tab that already holds that page comes forward, else the tab in front names it and forgets the name it had.
 */
export function followWindow(state: TabsState, address: string): TabsState {
  const held = state.tabs.find((tab) => tab.key !== state.active && tab.address === address);
  if (held !== undefined) return { ...state, active: held.key };
  return navigateInTab(state, address);
}
