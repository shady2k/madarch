/**
 * The app's addresses (decision 0036, section 7): `/` is the home, `/e/<kind>/<id>` an entity, `/p/<template>` a
 * template bound to no entity. A query parameter binds a variable the template declares, and `lang` and `role` are the
 * reader's own: they are passed to the page's operation, never stored in it.
 *
 * The catalogue and the glossary are still the frame's own placeholders, so each opens a page that says it is being
 * rebuilt. The fill, the problems, the sources and the product's settings are product templates at their own addresses
 * (`/p/fill`, `/p/problems`, `/p/sources`, `/p/settings`), and one fill run is another (`/p/run?run=<id>`).
 */
import type { PageAddress } from '../../../src/page-contract/index.js';

/**
 * The frame's sections, by the address each stands at. The app answers `/`, `/e/` and `/p/` (decision 0036, section 7),
 * so a section of the frame stands at a template address of its own name until its page is a template from the product.
 */
export const FRAME_PAGES = {
  catalogue: '/p/catalogue',
  glossary: '/p/glossary',
  kit: '/p/kit',
} as const;

/** Every page the frame's sidebar links to: the placeholders above and the product templates the frame draws. */
export const PAGE_ADDRESSES = {
  ...FRAME_PAGES,
  problems: '/p/problems',
  sources: '/p/sources',
  settings: '/p/settings',
} as const;

/** The fill page, a template of the product (`/p/fill`): its command component chooses the kinds and starts a run. */
export const FILL_PAGE = '/p/fill';

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
  const template = /^\/p\/([^/]+)\/?$/u.exec(path);
  if (template !== null) {
    const name = decode(template[1]!);
    // A section of the frame answers at its own name; any other name is a template the product's files hold.
    if (Object.hasOwn(FRAME_PAGES, name)) return { page: shared, home: false, unknown: false, frame: name as FramePage };
    return { page: { ...shared, template: name }, home: false, unknown: false, frame: null };
  }
  return { page: shared, home: false, unknown: true, frame: null };
}
