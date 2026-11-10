/** The resets a page test starts from: the app's module state, cleared through the app's own public store functions. */
import { closeTab, currentAddress, openInNewTab, syncFrontTabAddress, tabsState } from '../src/knowledge/tabs.js';
import { publishSettings } from '../src/knowledge/roles.js';
import { setShowGrounds } from '../src/knowledge/preferences.js';

/** One tab at the wiki's home, no tab the last test opened. */
export function resetTabs(): void {
  // A tab of its own at the page the window is on, with no title from the last case; the old tabs go.
  const address = currentAddress();
  while (tabsState().tabs.length > 1) closeTab(tabsState().tabs[0]!.key);
  openInNewTab('/__madarch_reset__');
  const active = tabsState().active;
  for (const tab of tabsState().tabs) if (tab.key !== active) closeTab(tab.key);
  window.history.replaceState({}, '', address);
  syncFrontTabAddress();
}

/** The settings as a reader who was never asked. */
export function resetSettings(): void {
  publishSettings({ loaded: false, role: 'everything', roles: [], asked: true, error: null });
}

/** The grounds switch as a reader who never touched it. */
export function resetPreferences(): void {
  window.localStorage.removeItem('madarch-show-grounds');
  setShowGrounds(false);
}
