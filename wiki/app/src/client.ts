/**
 * The app's one client (decision 0036, section 7): `POST /graphql` for the bootstrap and for one page's operation. The
 * app imports no other API function; a page's data comes from the graph and nowhere else.
 */
import type { Bootstrap } from '../../../src/page-contract/index.js';
import { reportOffline, reportOnline } from './connection.js';
import { CommandError, offlineWords, type FillPlanView, type FillRunDetail, type FillStatusAnswer } from './components/command.js';
import { withSpan } from './trace.js';
import { graphRefusalMessage } from './graph-refusal.js';

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
  /** The section of the sidebar the kind belongs to (`purpose:`), when the product declares purposes. */
  readonly purpose: string | null;
  /** The roles the kind is meant for (`audience:`), or null for every role. */
  readonly audience: readonly string[] | null;
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
    language
    home { id kind template }
    catalogueTemplate
    recordTemplates { kind template }
    ownTemplates { id template }
    templates { name body }
    roles
    roleLeads { role lead }
  }
  navigation(lang: $lang) {
    product
    groups { name labels short open parent }
    kinds { kind one many definition taken group nav count entryId purpose audience }
    purposes { id labels }
  }
}`;

/** The frame's navigation alone: what the sidebar, the home's kind counts and the catalogue's counts show. */
export const NAVIGATION_QUERY = `query Navigation($lang: String) {
  navigation(lang: $lang) {
    product
    groups { name labels short open parent }
    kinds { kind one many definition taken group nav count entryId purpose audience }
    purposes { id labels }
  }
}`;

export interface GraphqlError {
  readonly message: string;
  readonly extensions?: { readonly code?: string; readonly path?: string; readonly expected?: string; readonly actual?: unknown; readonly retryable?: boolean };
}

export interface GraphqlAnswer<T> {
  readonly data?: T;
  readonly errors: readonly GraphqlError[];
  /** The server could not be reached at all: the frame says so once, and no page shows the request's own words. */
  readonly offline?: boolean;
  /** The product's catalogue is being published or could not be: the frame says which, in its own words. */
  readonly publication?: PublicationState;
}

/** Why the graph answered nothing yet: the catalogue is `pending`, or it could not be published at all. */
export interface PublicationState {
  readonly status: 'pending' | 'failed';
  /** The server's own words for a failure; null for a publication still under way. */
  readonly message: string | null;
}

/** The publication a 503 names, when it is the server's own answer rather than a proxy's. */
async function publicationOf(response: Response): Promise<PublicationState | undefined> {
  try {
    const body = (await response.json()) as { publication?: unknown; message?: unknown };
    if (body.publication !== 'pending' && body.publication !== 'failed') return undefined;
    return { status: body.publication, message: typeof body.message === 'string' ? body.message : null };
  } catch {
    // A proxy in front of a server that is not there answers a 503 with no JSON of the server's.
    return undefined;
  }
}

/** The base path the app is served under: a products home serves each product's wiki below `/products/<name>`. */
export function basePathOf(pathname: string): string {
  const match = pathname.match(/^(\/products\/[^/]+)(?:\/|$)/u);
  return match?.[1] ?? '';
}

/** One operation through the product's one read API. */
export async function postQuery<T>(base: string, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<GraphqlAnswer<T>> {
  let response: Response;
  try {
    response = await withSpan('net.fetch', { 'http.method': 'POST', 'http.url': `${base}/graphql` }, async (span) => {
      const answer = await fetch(`${base}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      });
      span.setAttribute('http.status', answer.status);
      return answer;
    });
  } catch {
    reportOffline();
    return { errors: [], offline: true };
  }
  // A proxy in front of the server answers these when the server behind it is not there; the link, not the graph, is
  // what failed. A 503 is the server saying it is starting, or that the catalogue is being published: the frame says
  // which instead of an error, and only a server that answers nothing of its own reports the link down.
  if (response.status === 503) {
    const publication = await publicationOf(response);
    if (publication !== undefined) {
      reportOnline();
      return { errors: [], publication };
    }
    reportOffline('starting');
    return { errors: [], offline: true };
  }
  if (response.status === 502 || response.status === 504) {
    reportOffline();
    return { errors: [], offline: true };
  }
  reportOnline();
  if (!response.ok) {
    let body: { error?: unknown; errors?: GraphqlError[] } | undefined;
    try { body = await response.json() as typeof body; } catch { /* A proxy may answer without JSON. */ }
    if (Array.isArray(body?.errors)) {
      return { errors: body.errors.map(error => ({ ...error, message: graphRefusalMessage(error.extensions) ?? error.message })) };
    }
    const refusal = graphRefusalMessage(body?.error);
    return { errors: [{ message: refusal ?? `the graph answered ${String(response.status)}`, ...(refusal === undefined ? {} : { extensions: body?.error as NonNullable<GraphqlError['extensions']> }) }] };
  }
  const body = (await response.json()) as { data?: T; errors?: GraphqlError[] };
  return { data: body.data, errors: (body.errors ?? []).map(error => ({ ...error, message: graphRefusalMessage(error.extensions) ?? error.message })) };
}

/** The bootstrap and the navigation, or the message the page shows when they could not be read. */
export async function readBootstrap(base: string, lang: string): Promise<{ bootstrap?: Bootstrap; navigation?: Navigation; message?: string; codes?: readonly string[]; offline?: boolean; publication?: PublicationState }> {
  const answer = await postQuery<{ bootstrap?: Bootstrap; navigation?: Navigation }>(base, BOOTSTRAP_QUERY, { lang });
  if (answer.offline === true) return { offline: true };
  if (answer.publication !== undefined) return { publication: answer.publication };
  if (answer.errors.length > 0) return { message: answer.errors.map((error) => error.message).join('; '), codes: codesOf(answer.errors) };
  if (answer.data?.bootstrap === undefined || answer.data.navigation === undefined) return { message: 'the graph answered no bootstrap' };
  return { bootstrap: answer.data.bootstrap, navigation: answer.data.navigation };
}

/** One product this server serves: its name, the folder its wiki answers under, and madarch's own wiki when it is. */
export interface ProductChoice {
  readonly name: string;
  readonly folder: string;
  readonly own?: true;
}

/** The products this server serves, and the one whose wiki is in front. */
export interface ProductsAnswer {
  readonly current: string | null;
  readonly products: readonly ProductChoice[];
}

/** One field of the one read API that the layer owning the state answers (madarch-64o5.136 restore). */
async function serviceField<T>(base: string, query: string, variables: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<T> {
  const answer = await postQuery<Record<string, T | null>>(base, query, variables, signal);
  if (answer.offline === true) throw new CommandError(offlineWords(), 'offline');
  if (answer.errors.length > 0) throw new CommandError(answer.errors.map((error) => error.message).join('; '), answer.errors[0]?.extensions?.code ?? 'failed');
  const held = answer.data?.[key];
  if (held === null || held === undefined) throw new CommandError(`the graph answered no ${key}`, 'failed');
  return held;
}

/** The products the server serves, for the product menu and madarch's own docs. */
export async function fetchProducts(base: string, signal?: AbortSignal): Promise<ProductsAnswer> {
  return await serviceField<ProductsAnswer>(base, 'query Products { products }', {}, 'products', signal);
}

/** The product's fill state, as the home and the missing-manifest page read it. */
export async function fetchFillStatus(base: string, signal?: AbortSignal): Promise<FillStatusAnswer> {
  return await serviceField<FillStatusAnswer>(base, 'query FillStatus { fillStatus }', {}, 'fillStatus', signal);
}

/** The product's fill runs, newest first, or one run by its id. */
export async function fetchFillRuns(base: string, run?: string, signal?: AbortSignal): Promise<{ readonly runs: readonly FillRunDetail[] }> {
  return { runs: await serviceField<readonly FillRunDetail[]>(base, 'query FillRuns($run: String) { fillRuns(run: $run) }', { run: run ?? null }, 'fillRuns', signal) };
}

/** The plan one selection would run: its kinds, their plugins and what the agent takes. */
export async function fetchFillPlan(base: string, selected: readonly string[], pluginsOnly = false, signal?: AbortSignal): Promise<{ readonly plan: FillPlanView }> {
  return { plan: await serviceField<FillPlanView>(base, 'query FillPlan($selected: [String!], $pluginsOnly: Boolean) { fillPlan(selected: $selected, pluginsOnly: $pluginsOnly) }', { selected, pluginsOnly }, 'fillPlan', signal) };
}

/** The navigation alone, for a page that stays open while a fill changes its counts. */
export async function readNavigation(base: string, lang: string): Promise<{ navigation?: Navigation; message?: string; offline?: boolean; publication?: PublicationState }> {
  const answer = await postQuery<{ navigation?: Navigation }>(base, NAVIGATION_QUERY, { lang });
  if (answer.offline === true) return { offline: true };
  if (answer.publication !== undefined) return { publication: answer.publication };
  if (answer.errors.length > 0) return { message: answer.errors.map((error) => error.message).join('; ') };
  if (answer.data?.navigation === undefined) return { message: 'the graph answered no navigation' };
  return { navigation: answer.data.navigation };
}

/** Every error's code the answer carried, so a stale schema can be told from a broken page. */
export function codesOf(errors: readonly GraphqlError[]): string[] {
  return errors.map((error) => error.extensions?.code ?? '').filter((code) => code !== '');
}
