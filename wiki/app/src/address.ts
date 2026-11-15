/**
 * The app's addresses (decision 0036, section 7): `/` is the home, `/e/<kind>/<id>` an entity, `/p/<template>` a
 * template bound to no entity. A query parameter binds a variable the template declares, and `lang` and `role` are the
 * reader's own: they are passed to the page's operation, never stored in it.
 *
 * The catalogue, the glossary, the problems, the sources, the product's settings, the runs and the preparation panel are
 * product templates at their own addresses (`/p/catalogue`, `/p/glossary`, `/p/problems`, `/p/sources`, `/p/settings`,
 * `/p/runs`, `/p/prepare`), and one fill run is another (`/p/run?run=<id>`). The kit is the frame's own placeholder.
 */
import type { PageAddress } from '../../../src/page-contract/index.js';

/**
 * The frame's own sections, by the address each stands at. The app answers `/`, `/e/` and `/p/` (decision 0036, section
 * 7); only the kit is still a frame page, and every other address is a template the product's files hold.
 */
export const FRAME_PAGES = {
  kit: '/p/kit',
} as const;

/** Every page the frame's sidebar links to: the placeholder above and the product templates the frame draws. */
export const PAGE_ADDRESSES = {
  ...FRAME_PAGES,
  catalogue: '/p/catalogue',
  glossary: '/p/glossary',
  problems: '/p/problems',
  sources: '/p/sources',
  settings: '/p/settings',
  runs: '/p/runs',
  logs: '/p/logs',
} as const;

/**
 * The Logs page: every log madarch keeps, filtered and followed live. A `run` filters it to one run, and `q` and `level`
 * narrow it further — the run journal links a failure straight to the row that states it.
 */
export function logsAddress(run?: string, options: { readonly q?: string; readonly level?: string } = {}): string {
  const query = new URLSearchParams();
  if (run !== undefined && run !== '') query.set('run', run);
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.level !== undefined && options.level !== '') query.set('level', options.level);
  const text = query.toString();
  return text === '' ? PAGE_ADDRESSES.logs : `${PAGE_ADDRESSES.logs}?${text}`;
}

/** The runs page: the history of fills, always reachable, and the way to choose a new fill. */
export const RUNS_PAGE = '/p/runs';

/** The preparation panel for a set of kinds; `pluginsOnly` leaves the agent's fields unfilled. */
export function prepareAddress(kinds: readonly string[], pluginsOnly = false, wizard = false): string {
  const query = new URLSearchParams({ kinds: [...new Set(kinds)].sort().join(',') });
  if (pluginsOnly) query.set('pluginsOnly', '1');
  if (wizard) query.set('wizard', '1');
  return `/p/prepare?${query.toString()}`;
}

/** The catalogue in selection mode with these kinds checked; the server adds their prerequisites. */
export function catalogueSelectionAddress(kinds: readonly string[] = []): string {
  const query = new URLSearchParams({ select: '1' });
  if (kinds.length > 0) query.set('kinds', [...new Set(kinds)].sort().join(','));
  return `/p/catalogue?${query.toString()}`;
}

/** One fill run's page, the `run` template with the run's id as its variable. */
export function runAddress(runId: string): string {
  return `/p/run?run=${encodeURIComponent(runId)}`;
}

/** One of the frame's own sections. */
export type FramePage = keyof typeof FRAME_PAGES;

/** One address of the app, as the page is composed from it. */
export interface AppAddress {
  readonly page: PageAddress;
  /** Whether the address is the product's home, whose entity the bootstrap names. */
  readonly home: boolean;
  /** The paths that name no page: the app says so instead of composing one. */
  readonly unknown: boolean;
  /** The frame's section the address names, when it names one. */
  readonly frame: FramePage | null;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The address of one entity's page. */
export function entityAddress(kind: string, id: string): string {
  return `/e/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/** An address read from the app's own path and query, with the base the app is served under taken away. */
export function parseAddress(pathname: string, search: string, base: string): AppAddress {
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const query = new URLSearchParams(search);
  const params: Record<string, string> = {};
  for (const [key, value] of query) if (key !== 'lang' && key !== 'role') params[key] = value;
  const lang = query.get('lang') ?? undefined;
  const role = query.get('role') ?? undefined;
  const shared = { params, ...(lang === undefined ? {} : { lang }), ...(role === undefined ? {} : { role }) };
  if (path === '' || path === '/') return { page: { ...shared, home: true }, home: true, unknown: false, frame: null };
  const entity = /^\/e\/([^/]+)\/([^/]+)\/?$/u.exec(path);
  if (entity !== null) return { page: { ...shared, kind: decode(entity[1]!), id: decode(entity[2]!) }, home: false, unknown: false, frame: null };
  // The old fill address opens the catalogue's selection mode: the separate fill list page is gone.
  if (path === '/p/fill') return { page: { ...shared, template: 'catalogue', params: { ...params, select: '1' } }, home: false, unknown: false, frame: null };
  const template = /^\/p\/([^/]+)\/?$/u.exec(path);
  if (template !== null) {
    const name = decode(template[1]!);
    // A search is shared as `?q=`, and the search template names its words `text`: a link in the other spelling searches
    // the same words instead of quietly answering nothing (madarch-64o5.83).
    if (name === 'search' && params['text'] === undefined && params['q'] !== undefined) params['text'] = params['q']!;
    // A section of the frame answers at its own name; any other name is a template the product's files hold.
    if (Object.hasOwn(FRAME_PAGES, name)) return { page: shared, home: false, unknown: false, frame: name as FramePage };
    return { page: { ...shared, template: name }, home: false, unknown: false, frame: null };
  }
  return { page: shared, home: false, unknown: true, frame: null };
}
