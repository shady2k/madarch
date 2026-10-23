/**
 * The reader's role (decision 0031): what the manifest says a role opens on a
 * page and puts first in the navigation, and the reader's choice kept on the
 * machine (`settings.json` in the madarch home, through the server), not in a
 * product and not in the browser. The role is never guessed from behaviour.
 *
 * One page serves every role: a block the role does not open stays on the page,
 * collapsed under its title. "Everything" opens every block and keeps the
 * manifest's order.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import { getSettings, setRole } from './api.js';
import type { Block, WikiStatus } from './types.js';

export type RoleDecls = NonNullable<WikiStatus['roles']>;

/** The roles a reader can read as; "everything" is every role at once. */
export const ROLES = ['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'everything'] as const;

/** Blocks that are the page's text itself: no role collapses them. */
const ALWAYS_OPEN = new Set<Block['type']>(['markdown', 'body', 'problem', 'term']);

/** Whether a block stands open for a role: when the manifest gives the role a list of open blocks, only those (and the page's text). */
export function blockOpen(block: { type: Block['type']; name?: string }, role: string, roles: RoleDecls): boolean {
  if (role === 'everything' || ALWAYS_OPEN.has(block.type)) return true;
  const open = roles[role]?.open;
  // The manifest names the template's block; a page from an older server names only the type.
  return open === undefined || open.includes(block.name ?? block.type);
}

/** The navigation's groups with the role's leading groups first, in the order the role names them; the rest keep the manifest's order. */
export function leadGroups<T extends { group: string | null }>(groups: readonly T[], role: string, roles: RoleDecls): T[] {
  const lead = role === 'everything' ? [] : roles[role]?.lead ?? [];
  if (lead.length === 0) return [...groups];
  const first = lead.flatMap((name) => groups.filter((entry) => entry.group === name));
  return [...first, ...groups.filter((entry) => !first.includes(entry))];
}

/** The role and the manifest's declarations for it, for the blocks and the navigation. */
export const RoleContext = createContext<{ role: string; roles: RoleDecls }>({ role: 'everything', roles: {} });
export const useRole = (): { role: string; roles: RoleDecls } => useContext(RoleContext);

// ---- the reader's settings on this machine ---------------------------------------------------------------------------

export interface SettingsState {
  /** Read from the server yet. */
  loaded: boolean;
  role: string;
  /** The reader was asked (chose or skipped). Until loaded it is true, so no card flashes before the answer. */
  asked: boolean;
  error: string | null;
}

let state: SettingsState = { loaded: false, role: 'everything', asked: true, error: null };
const listeners = new Set<() => void>();
const publish = (next: SettingsState): void => {
  state = next;
  for (const listener of listeners) listener();
};

/** Reads the settings once; a failure is kept in the state and shown, and the wiki reads as "everything". */
export async function loadSettings(signal?: AbortSignal): Promise<void> {
  try {
    const settings = await getSettings(signal);
    publish({ loaded: true, role: settings.role, asked: settings.asked, error: null });
  } catch (failure) {
    if (signal?.aborted) return;
    publish({ loaded: true, role: 'everything', asked: true, error: failure instanceof Error ? failure.message : String(failure) });
  }
}

/** Keeps a role (a skip is `everything`); the state follows the server's answer. */
export async function chooseRole(role: string): Promise<void> {
  try {
    const settings = await setRole(role);
    publish({ loaded: true, role: settings.role, asked: settings.asked, error: null });
  } catch (failure) {
    publish({ ...state, error: failure instanceof Error ? failure.message : String(failure) });
    throw failure;
  }
}

/** Forgets what was read (a test starts over). */
export function resetSettings(): void {
  publish({ loaded: false, role: 'everything', asked: true, error: null });
}

export function useSettings(): SettingsState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => state, () => state);
}
