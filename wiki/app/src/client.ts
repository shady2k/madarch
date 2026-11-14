/**
 * The app's one client (decision 0036, section 7): `POST /graphql` for the bootstrap and for one page's operation. The
 * app imports no other API function; a page's data comes from the graph and nowhere else.
 */
import type { Bootstrap } from '../../../src/page-contract/index.js';

/** The bootstrap the app reads once at start (section 6): the home, the templates, what opens each page, the roles. */
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
}`;

export interface GraphqlError {
  readonly message: string;
  readonly extensions?: { readonly code?: string };
}

export interface GraphqlAnswer<T> {
  readonly data?: T;
  readonly errors: readonly GraphqlError[];
}

/** The base path the app is served under: a products home serves each product's wiki below `/products/<name>`. */
export function basePathOf(pathname: string): string {
  const match = /^(\/products\/[^/]+)(?:\/|$)/u.exec(pathname);
  return match?.[1] ?? '';
}

/** One operation through the product's one read API. */
export async function postQuery<T>(base: string, query: string, variables: Record<string, unknown>): Promise<GraphqlAnswer<T>> {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    credentials: 'same-origin',
  });
  if (!response.ok) {
    return { errors: [{ message: `the graph answered ${String(response.status)}` }] };
  }
  const body = (await response.json()) as { data?: T; errors?: GraphqlError[] };
  return { data: body.data, errors: body.errors ?? [] };
}

/** The bootstrap, or the message the page shows when it could not be read. */
export async function readBootstrap(base: string, lang: string): Promise<{ bootstrap?: Bootstrap; message?: string }> {
  const answer = await postQuery<{ bootstrap?: Bootstrap }>(base, BOOTSTRAP_QUERY, { lang });
  if (answer.errors.length > 0) return { message: answer.errors.map((error) => error.message).join('; ') };
  if (answer.data?.bootstrap === undefined) return { message: 'the graph answered no bootstrap' };
  return { bootstrap: answer.data.bootstrap };
}

/** Every error's code the answer carried, so a stale schema can be told from a broken page. */
export function codesOf(errors: readonly GraphqlError[]): string[] {
  return errors.map((error) => error.extensions?.code ?? '').filter((code) => code !== '');
}
