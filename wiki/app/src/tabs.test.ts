/**
 * The window's open pages (the frame's own state): a press opens a page in the tab in front, a control or middle press in a
 * tab of its own, a tab comes forward when its page is asked for again, closes to the tab beside it, and keeps its name.
 */
import { describe, expect, test } from 'bun:test';
import {
  activateTab, activeAddress, closeTab, firstTabs, followWindow, navigateInTab, openInTab, openPage, recallTabs,
  rememberTabs, tabsKey, titleTab,
} from './tabs.js';

/** The window's storage as the page meets it: a map with the two calls the tabs use. */
function storage(): Storage {
  const held = new Map<string, string>();
  return {
    get length() { return held.size; },
    clear: () => { held.clear(); },
    getItem: (key: string) => held.get(key) ?? null,
    key: (at: number) => [...held.keys()][at] ?? null,
    removeItem: (key: string) => { held.delete(key); },
    setItem: (key: string, value: string) => { held.set(key, value); },
  };
}

describe('the window\'s tabs', () => {
  test('a window opens on the page it stands at, under one unnamed tab', () => {
    const state = firstTabs('/e/a.b/one');
    expect(state.tabs).toEqual([{ key: 't1', address: '/e/a.b/one', title: null }]);
    expect(state.active).toBe('t1');
    expect(activeAddress(state)).toBe('/e/a.b/one');
  });

  test('a plain press shows the page in the tab in front and forgets the name it had', () => {
    const named = titleTab(firstTabs('/'), 't1', 'Home');
    const moved = navigateInTab(named, '/p/catalogue');
    expect(moved.tabs).toHaveLength(1);
    expect(moved.tabs[0]).toEqual({ key: 't1', address: '/p/catalogue', title: null });
    // Pressing the address the tab already holds keeps its name.
    const again = navigateInTab(titleTab(moved, 't1', 'Catalogue'), '/p/catalogue');
    expect(again.tabs[0]?.title).toBe('Catalogue');
  });

  test('a control press opens a tab of its own beside the one in front, and the page already open comes forward', () => {
    const two = openInTab(firstTabs('/'), '/p/catalogue');
    expect(two.tabs.map((tab) => [tab.key, tab.address])).toEqual([['t1', '/'], ['t2', '/p/catalogue']]);
    expect(activeAddress(two)).toBe('/p/catalogue');
    const three = openInTab(two, '/p/glossary');
    expect(three.tabs.map((tab) => tab.key)).toEqual(['t1', 't2', 't3']);
    // A page another tab already holds is shown in that tab, never twice.
    const back = openPage(three, '/p/catalogue', true);
    expect(back.tabs).toHaveLength(3);
    expect(activeAddress(back)).toBe('/p/catalogue');
    // A plain press on a page another tab holds brings that tab forward too.
    const plain = openPage(three, '/', false);
    expect(plain.tabs).toHaveLength(3);
    expect(activeAddress(plain)).toBe('/');
  });

  test('a tab closed lets the one beside it come forward, and the last tab stays', () => {
    const state = openInTab(openInTab(firstTabs('/'), '/p/catalogue'), '/p/glossary');
    const closed = closeTab(activateTab(state, 't2'), 't2');
    expect(closed.tabs.map((tab) => tab.key)).toEqual(['t1', 't3']);
    expect(activeAddress(closed)).toBe('/p/glossary');
    const only = closeTab(firstTabs('/'), 't1');
    expect(only.tabs).toHaveLength(1);
    expect(only.active).toBe('t1');
    // A key no tab holds closes nothing.
    expect(closeTab(state, 't9')).toBe(state);
  });

  test('the window\'s own back and forward moves the tab in front, or brings the tab that holds the page forward', () => {
    const state = openInTab(openInTab(firstTabs('/'), '/p/catalogue'), '/p/glossary');
    const back = followWindow(state, '/p/catalogue');
    expect(back.active).toBe('t2');
    const fresh = followWindow(state, '/p/search?text=x');
    expect(fresh.active).toBe('t3');
    expect(fresh.tabs.at(-1)?.address).toBe('/p/search?text=x');
    expect(fresh.tabs.at(-1)?.title).toBeNull();
  });

  test('the tabs are kept for the window and come back with the page the window stands at in front', () => {
    const store = storage();
    const state = openInTab(titleTab(firstTabs('/'), 't1', 'Home'), '/p/catalogue');
    rememberTabs(store, '/products/shop', state);
    expect(store.getItem(tabsKey('/products/shop'))).not.toBeNull();
    // The window stands at another page — a link followed into the wiki — and the tab in front names it.
    expect(recallTabs(store, '/products/shop', '/p/glossary').tabs.map((tab) => tab.address)).toEqual(['/', '/p/glossary']);
    // Nothing kept, or something else under the key: one tab at the address the window stands at.
    expect(recallTabs(storage(), '/products/shop', '/p/catalogue').tabs).toHaveLength(1);
    store.setItem(tabsKey('/'), JSON.stringify({ tabs: [{ key: 4 }], active: 4 }));
    expect(recallTabs(store, '/', '/').tabs).toHaveLength(1);
  });

  test('a window that refuses storage opens one tab and keeps the tabs for the page\'s life', () => {
    expect(recallTabs(null, '/', '/p/catalogue').tabs).toHaveLength(1);
    expect(() => rememberTabs(null, '/', firstTabs('/'))).not.toThrow();
  });
});
