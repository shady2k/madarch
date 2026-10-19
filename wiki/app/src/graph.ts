/**
 * The graph's pages on the app's side (madarch-tzte.23.3; decision 0026, "Pages"):
 * the page set the server reads from the fill's fact store, the live channel that
 * reports which pages a publication touched, and the small pure rules the pages and
 * the navigation share.
 *
 * 0026: "Every graph node of a page-worthy kind has a live page at once … and
 * updated in the browser as facts arrive; it is a view, not a file in git." The
 * server answers the set (`GET /api/graph/pages`), one node's page
 * (`GET /api/graph/page?id=…`) and the changes (`GET /api/graph/events`); this
 * module reads them, and nothing here invents a fact: what a page shows is what the
 * server answered.
 *
 * **The live rule.** The channel is Server-Sent Events, woken by the publication
 * itself (`src/server/graph-pages.ts`), so there is no polling anywhere: one stream
 * per tab, opened from the `changeSeq` of the page set the app holds, and each
 * `pages` event names the pages one publication touched. The app reads the set again
 * when an event arrives (a new node joins the navigation) and a node's page again
 * only when the event names that node. A dropped stream reconnects with backoff from
 * the last change it saw, so nothing published in between is lost.
 *
 * **A server without the graph is not a failure.** An older server, or a product
 * whose server holds no fill's graph, answers no page set at all; the app then shows
 * the document pages exactly as before and no graph section at all. A server that
 * answers an empty set with its what-to-do message is a different thing: it is
 * live, and the app subscribes, because the pages appear as the fill publishes.
 */
import { useEffect, useRef, useState } from 'react';
import { appPath } from './app-base.js';
import {
  getGraphPages,
  getGraphPage,
  RequestError,
  type GraphCodeLink,
  type GraphPageChange,
  type GraphPageEntry,
  type GraphPageModel,
  type GraphPageSet,
  type RepoEntry,
} from './api.js';
import { byCodePoint } from './sort.js';
import { GRAPH_INDEX_ADDRESS, addressOfGraphPage } from './routes.js';

/** Where the graph's live channel answers. */
export const GRAPH_EVENTS_PATH = appPath('/api/graph/events');

/** The first gap before a dropped graph stream is asked for again; each miss doubles it. */
export const defaultGraphReconnectMs = 1000;

/** The longest gap a dropped graph stream waits before it is asked for again. */
const maxGraphReconnectMs = 15_000;

/** How many of one kind's nodes the navigation lists before it points at the graph's index page. */
export const NAV_NODES_PER_KIND = 12;

/** One kind's nodes of the page set, in the set's own order (code point of the label, then of the id). */
export type GraphKindGroup = { kind: string; entries: GraphPageEntry[] };

/**
 * The page set as the navigation and the index page show it: one group per kind, in
 * code point order of the kind (the server's own counts order), and the nodes inside
 * a group in the order the server answered them — already code point order of the
 * label, then of the id, so a group is never reordered here.
 */
export function graphKindGroups(set: GraphPageSet | null): GraphKindGroup[] {
  if (set === null) return [];
  const byKind = new Map<string, GraphPageEntry[]>();
  for (const entry of set.pages) {
    const held = byKind.get(entry.kind);
    if (held === undefined) byKind.set(entry.kind, [entry]);
    else held.push(entry);
  }
  return [...byKind.keys()].sort(byCodePoint).map((kind) => ({ kind, entries: byKind.get(kind) as GraphPageEntry[] }));
}

/**
 * The answer as a page set, or null when it is not one: `pages` a list and `total` a
 * number. A reader of a page set never trusts a shape it was not promised — a list it
 * cannot read would be a page of nothing.
 */
export function pageSetOf(answer: unknown): GraphPageSet | null {
  if (answer === null || typeof answer !== 'object') return null;
  const held = answer as Record<string, unknown>;
  if (!Array.isArray(held['pages'])) return null;
  if (typeof held['total'] !== 'number') return null;
  const pages = held['pages'].filter((entry): entry is GraphPageEntry => entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['id'] === 'string' && typeof (entry as Record<string, unknown>)['kind'] === 'string');
  return {
    product: typeof held['product'] === 'string' ? held['product'] : '',
    pages,
    counts: Array.isArray(held['counts']) ? (held['counts'] as GraphPageSet['counts']) : [],
    total: held['total'],
    changeSeq: typeof held['changeSeq'] === 'number' ? held['changeSeq'] : 0,
    readAt: typeof held['readAt'] === 'number' ? held['readAt'] : 0,
    message: typeof held['message'] === 'string' ? held['message'] : null,
  };
}

/**
 * The host and path a repository's origin names, for a code link: an `https://` or
 * `ssh://` URL or the `git@host:path` form, on github.com or gitlab.com, the `.git`
 * suffix dropped. The same rule the wiki's own document links keep
 * (`src/wiki/documents.ts`, `originHost`): any other spelling — another scheme,
 * another host, a local path — is none, and the place is then shown as text and
 * links nothing, so a reader never lands on a broken address.
 */
export function originOf(url: string | undefined): { kind: 'github' | 'gitlab'; owner: string; repo: string } | undefined {
  if (url === undefined || url === '') return undefined;
  let host: string;
  let path: string;
  if (/^(?:https|ssh):\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } else {
    const scp = /^git@([^:/]+):(.+)$/.exec(url);
    if (scp === null) return undefined;
    host = scp[1]!.toLowerCase();
    path = scp[2]!.replace(/\/+$/, '');
  }
  const kind = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : undefined;
  if (kind === undefined) return undefined;
  const segments = path.replace(/\.git$/, '').split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return undefined;
  return { kind, owner: segments.slice(0, -1).join('/'), repo: segments[segments.length - 1]! };
}

/**
 * The address a fact's code link opens: the repository's own page on its host, at
 * the commit the fact was read at, at the lines it spans — or undefined when the
 * repository declares no origin the hosts spell, and the place is text alone.
 */
export function codeHref(link: GraphCodeLink, repos: readonly RepoEntry[]): string | undefined {
  const declared = repos.find((entry) => entry.name === link.repository);
  const origin = originOf(declared?.url);
  if (origin === undefined) return undefined;
  const path = link.file.split('/').filter((segment) => segment !== '').map((segment) => encodeURIComponent(segment)).join('/');
  const host = origin.kind === 'github' ? 'https://github.com' : 'https://gitlab.com';
  const lines = link.endLine > link.startLine ? `#L${link.startLine}-L${link.endLine}` : `#L${link.startLine}`;
  return `${host}/${origin.owner}/${origin.repo}/blob/${link.commit}/${path}${lines}`;
}

/** The place a code link names, as a reader reads it: the file and the lines it spans. */
export function codePlace(link: GraphCodeLink): string {
  return link.endLine > link.startLine ? `${link.file}:${link.startLine}-${link.endLine}` : `${link.file}:${link.startLine}`;
}

/** The page set, the live channel and what the app learned from them. */
export type GraphLive = {
  /** The product's page-worthy nodes, or null before the first answer. */
  readonly set: GraphPageSet | null;
  /** Whether the server answers graph pages at all: false when its read failed, and no graph section is shown then. */
  readonly available: boolean;
  /** Why the page set could not be read, when it could not; the reader sees it in place of the graph. */
  readonly error: string | null;
  /** The latest publication the channel reported: the pages it touched, and the change number it stands at. */
  readonly change: GraphPageChange | null;
};

/**
 * The page set and the live channel: one read at load, one stream per tab opened from
 * the set's own `changeSeq` (so nothing published between the read and the
 * subscription is lost), and a read of the set again for every publication the
 * channel reports. There is no polling: a quiet product makes no request at all
 * beyond the one stream.
 */
export function useGraphPages(options: { reconnectMs?: number } = {}): GraphLive {
  const reconnectMs = options.reconnectMs ?? defaultGraphReconnectMs;
  const [set, setSet] = useState<GraphPageSet | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<GraphPageChange | null>(null);
  useEffect(() => {
    let alive = true;
    let misses = 0;
    let timer: number | undefined;
    let stream: AbortController | undefined;
    // Where the stream stands: the set's own change number until an event moves it.
    let seq: number | undefined;
    let reading = false;
    let again = false;
    // Whether this server answers a graph at all: a server that answers no page set has
    // no channel either, and asking one every few seconds would be polling a route the
    // server does not offer.
    let offered = true;
    const loadSet = async (): Promise<void> => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const next = await getGraphPages();
        if (!alive) return;
        // An answer that is no page set (a server of another shape, an address answered by
        // something else) is no graph: the app shows the document pages, and never reads a
        // list it was not given.
        const shaped = pageSetOf(next);
        if (shaped === null) {
          setAvailable(false);
          setError('the server answered /api/graph/pages with no page set');
          return;
        }
        setSet(shaped);
        setAvailable(true);
        setError(null);
        if (seq === undefined) seq = next.changeSeq;
      } catch (caught: unknown) {
        if (!alive) return;
        // A server that answers no page set holds no fill's graph (an older server, a
        // foreground serve): the app shows the document pages and no graph section, and
        // its failure is not the wiki's.
        setAvailable(false);
        offered = false;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        reading = false;
        if (again && alive) {
          again = false;
          void loadSet();
        }
      }
    };
    const open = async (): Promise<void> => {
      if (!alive || !offered || seq === undefined) return;
      stream = new AbortController();
      const address = `${GRAPH_EVENTS_PATH}?after=${seq}`;
      try {
        const response = await fetch(address, { signal: stream.signal });
        // An answer that is no event stream is no channel: this server does not offer the
        // graph's live updates (an older server, or an address answered by something else).
        // The page set is still read, and no retry is made — a stream asked again every few
        // seconds would be polling.
        const type = response.headers.get('content-type') ?? '';
        if (!response.ok || response.body === null || !type.includes('text/event-stream')) {
          offered = false;
          return;
        }
        misses = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let frame = '';
        while (alive) {
          const next = await reader.read();
          if (next.done) break;
          frame += decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = frame.indexOf('\n\n')) !== -1) {
            const lines = frame.slice(0, end).split('\n');
            frame = frame.slice(end + 2);
            const kind = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
            if (kind !== 'pages') continue;
            const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (data === undefined) continue;
            let event: GraphPageChange;
            try {
              event = JSON.parse(data) as GraphPageChange;
            } catch {
              continue; // a frame this app cannot read is no event, never a crash
            }
            if (!alive) return;
            seq = Math.max(seq ?? 0, event.seq);
            setChange(event);
            void loadSet();
          }
        }
        throw new Error(`the stream to ${address} ended`);
      } catch (caught: unknown) {
        const stop = !alive || (caught instanceof DOMException && caught.name === 'AbortError');
        if (stop || !alive || !offered) return;
        misses += 1;
        const wait = Math.min(maxGraphReconnectMs, reconnectMs * 2 ** (misses - 1));
        timer = window.setTimeout(() => {
          void open();
        }, wait);
      }
    };
    void (async () => {
      await loadSet();
      if (alive) void open();
    })();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.abort();
      stream = undefined;
    };
  }, [reconnectMs]);
  return { set, available, error, change };
}

/** One node's page as the app reads it: the model, or the refusal naming why the graph holds none. */
export type GraphPageRead = {
  readonly page: GraphPageModel | null;
  /** Why the page could not be read, when it could not. */
  readonly error: string | null;
  /** Whether the graph holds no page of this id (a page that disappeared, or one not published yet). */
  readonly missing: boolean;
};

/**
 * One node's page, read at the id and again for every publication that names it: the
 * channel says which pages a publication touched, so a page of a node nothing touched
 * is never asked for again. A 404 is the page standing nowhere — a node whose facts
 * another publication dropped, or one the graph does not hold yet — and it is shown
 * as the refusal's own words, never as an empty page.
 */
export function useGraphPage(id: string, change: GraphPageChange | null): GraphPageRead {
  const [page, setPage] = useState<GraphPageModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  // The publication that names this page, as one number the read depends on: a
  // publication that touches other pages asks for nothing here.
  const touchedAt = change !== null && change.nodes.includes(id) ? change.seq : 0;
  const heldRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    // A page whose id changed starts empty: the previous node's model is never shown
    // under the new node's name.
    if (heldRef.current !== id) {
      heldRef.current = id;
      setPage(null);
      setError(null);
      setMissing(false);
    }
    const controller = new AbortController();
    getGraphPage(id, controller.signal)
      .then((next) => {
        if (!alive) return;
        setPage(next);
        setError(null);
        setMissing(false);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const gone = caught instanceof RequestError && caught.status === 404;
        setMissing(gone);
        setError(caught instanceof Error ? caught.message : String(caught));
        if (gone) setPage(null);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id, touchedAt]);
  return { page, error, missing };
}

/** The address of one graph node's page, as every link of the app spells it. */
export const graphPageAddress = addressOfGraphPage;

/** The graph's index page address. */
export const graphIndexAddress = GRAPH_INDEX_ADDRESS;
