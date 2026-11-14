/**
 * The app's addresses (decision 0036, section 7): `/` is the home, `/e/<kind>/<id>` an entity, `/p/<template>` a
 * template bound to no entity. A query parameter binds a variable the template declares, and `lang` and `role` are the
 * reader's own: they are passed to the page's operation, never stored in it.
 */
import type { PageAddress } from '../../../src/page-contract/index.js';

/** One address of the app, as the page is composed from it. */
export interface AppAddress {
  readonly page: PageAddress;
  /** Whether the address is the product's home, whose entity the bootstrap names. */
  readonly home: boolean;
  /** The paths that name no page: the app says so instead of composing one. */
  readonly unknown: boolean;
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
  if (path === '' || path === '/') return { page: { ...shared, home: true }, home: true, unknown: false };
  const entity = /^\/e\/([^/]+)\/([^/]+)\/?$/u.exec(path);
  if (entity !== null) return { page: { ...shared, kind: decode(entity[1]!), id: decode(entity[2]!) }, home: false, unknown: false };
  const template = /^\/p\/([^/]+)\/?$/u.exec(path);
  if (template !== null) return { page: { ...shared, template: decode(template[1]!) }, home: false, unknown: false };
  return { page: shared, home: false, unknown: true };
}
