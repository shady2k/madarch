/**
 * The app's one client (decision 0036, section 7): `POST /graphql` for the bootstrap and for one page's operation. The
 * app imports no other API function; a page's data comes from the graph and nowhere else.
 */
import type { Bootstrap } from '../../../src/page-contract/index.js';
import { reportOffline, reportOnline } from './connection.js';

/** One kind of the product's navigation: its names in the reader's language, its group and what the graph holds. */
export interface NavigationKind {
  readonly kind: string;
  readonly one: string;
  readonly many: string;
  readonly definition: string | null;
  readonly taken: boolean;
  readonly group: string | null;
  /** `own-page` or `loop`: the kind's entities stand at a place of their own, not among the pages by kind. */
  readonly nav: string | null;
  readonly count: number;
  /** The id of the kind's catalogue entity: the page its row opens. */
  readonly entryId: string | null;
}

/** One group of the navigation: the manifest's own words for it, the group it stands under and whether it opens. */
export interface NavigationGroup {
  readonly name: string;
  readonly labels: Record<string, string>;
  readonly short: Record<string, string> | null;
  readonly open: boolean;
  readonly parent: string | null;
}

/** One purpose of the manifest: its id and its words in every interface language. */
export interface NavigationPurpose {
  readonly id: string;
  readonly labels: Record<string, string>;
}

/** The frame's whole data: the product's name, its groups and purposes, and the kinds it declares with their counts. */
export interface Navigation {
  readonly product: string | null;
  readonly groups: readonly NavigationGroup[];
  readonly kinds: readonly NavigationKind[];
  readonly purposes: readonly NavigationPurpose[];
}

/**
 * The bootstrap and the navigation the app reads once at start (sections 6 and 7): the home, the templates, what opens
 * each page, the roles, and the one read the frame draws the sidebar from. One document, one request.
 */
export const BOOTSTRAP_QUERY = `query Bootstrap($lang: String) {
  bootstrap(lang: $lang) {
    structureRevision
    home { id kind template }
    catalogueTemplate
    recordTemplates { kind template }
    ownTemplates { id template }
    templates { name body }
    roles
  }
  navigation(lang: $lang) {
    product
    groups { name labels short open parent }
    kinds { kind one many definition taken group nav count entryId }
    purposes { id labels }
  }
}`;

/** The frame's navigation alone: what the sidebar, the home's kind counts and the catalogue's counts show. */
export const NAVIGATION_QUERY = `query Navigation($lang: String) {
  navigation(lang: $lang) {
    product
    groups { name labels short open parent }
    kinds { kind one many definition taken group nav count entryId }
    purposes { id labels }
  }
}`;

export interface GraphqlError {
  readonly message: string;
  readonly extensions?: { readonly code?: string };
}

export interface GraphqlAnswer<T> {
  readonly data?: T;
  readonly errors: readonly GraphqlError[];
  /** The server could not be reached at all: the frame says so once, and no page shows the request's own words. */
  readonly offline?: boolean;
}

/** The base path the app is served under: a products home serves each product's wiki below `/products/<name>`. */
export function basePathOf(pathname: string): string {
  const match = /^(\/products\/[^/]+)(?:\/|$)/u.exec(pathname);
  return match?.[1] ?? '';
}

/** One operation through the product's one read API. */
export async function postQuery<T>(base: string, query: string, variables: Record<string, unknown>): Promise<GraphqlAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      credentials: 'same-origin',
    });
  } catch {
    reportOffline();
    return { errors: [], offline: true };
  }
  // A proxy in front of the server answers these when the server behind it is not there; the link, not the graph, is
  // what failed. A 503 is the server saying it is starting, and the frame says that instead of an error.
  if (response.status === 503) {
    reportOffline('starting');
    return { errors: [], offline: true };
  }
  if (response.status === 502 || response.status === 504) {
    reportOffline();
    return { errors: [], offline: true };
  }
  reportOnline();
  if (!response.ok) {
    return { errors: [{ message: `the graph answered ${String(response.status)}` }] };
  }
  const body = (await response.json()) as { data?: T; errors?: GraphqlError[] };
  return { data: body.data, errors: body.errors ?? [] };
}

/** The bootstrap and the navigation, or the message the page shows when they could not be read. */
export async function readBootstrap(base: string, lang: string): Promise<{ bootstrap?: Bootstrap; navigation?: Navigation; message?: string; offline?: boolean }> {
  const answer = await postQuery<{ bootstrap?: Bootstrap; navigation?: Navigation }>(base, BOOTSTRAP_QUERY, { lang });
  if (answer.offline === true) return { offline: true };
  if (answer.errors.length > 0) return { message: answer.errors.map((error) => error.message).join('; ') };
  if (answer.data?.bootstrap === undefined || answer.data.navigation === undefined) return { message: 'the graph answered no bootstrap' };
  return { bootstrap: answer.data.bootstrap, navigation: answer.data.navigation };
}

/** The navigation alone, for a page that stays open while a fill changes its counts. */
export async function readNavigation(base: string, lang: string): Promise<{ navigation?: Navigation; message?: string; offline?: boolean }> {
  const answer = await postQuery<{ navigation?: Navigation }>(base, NAVIGATION_QUERY, { lang });
  if (answer.offline === true) return { offline: true };
  if (answer.errors.length > 0) return { message: answer.errors.map((error) => error.message).join('; ') };
  if (answer.data?.navigation === undefined) return { message: 'the graph answered no navigation' };
  return { navigation: answer.data.navigation };
}

/** Every error's code the answer carried, so a stale schema can be told from a broken page. */
export function codesOf(errors: readonly GraphqlError[]): string[] {
  return errors.map((error) => error.extensions?.code ?? '').filter((code) => code !== '');
}
