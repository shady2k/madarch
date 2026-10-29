/**
 * The server's product mode: the wiki's change stream and the app's built
 * files, over one open product and one app folder.
 *
 * There is one wiki app (decision 0029), the knowledge wiki, and its routes
 * are `src/server/knowledge.ts`; what stands here is what every product's
 * wiki shares with it: the Server-Sent Events stream that tells an open page
 * to read again, and the built files of the app, so a page's address can be
 * opened, reloaded and linked.
 *
 * Serving reads the product and changes nothing in it: no write, no git
 * command, no document content in the log. Refusals are JSON naming what was
 * asked for and where it must be looked for, held at the top level as
 * `{"message"}` because the app's reader shows the message straight from that
 * field (wiki/app/src/api.ts).
 */
import type { ProductWiki } from '../product-wiki/pages.js';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join as joinPath, normalize, resolve, sep } from 'node:path';
import type { Handled, ReplyMaker } from './http.js';

/** How long the event stream holds a burst of tree events back before it asks the wiki what changed. */
export const CHANGE_DEBOUNCE_MS = 200;

/** How often a tree that gave no watch events is asked again, so a change is never missed. */
const WATCH_FALLBACK_MS = 300;

/** The never-and-then-closer of a stream's tail: the encoded bytes one event line is written in. */
const eventBytes = new TextEncoder();

/**
 * Changes that do not come from the product's working tree and still change what
 * a page shows: the knowledge wiki's fill reads a commit into the graph
 * (decision 0029). They ride the wiki's one change stream: the revision the
 * stream compares carries `revision()`, and a notice from `subscribe` asks the
 * stream at once, so an open page reads again after every commit and no second
 * channel is needed.
 */
export interface OutsideChanges {
  revision(): string;
  subscribe(listener: () => void): () => void;
}

/**
 * One long-lived Server-Sent Events stream of the wiki's changes: an initial
 * `retry:` line, then one `change` event each time the product's working
 * tree revision differs from the one the stream last sent — a burst of tree
 * events within `CHANGE_DEBOUNCE_MS` of each other is one event. The tree is
 * watched; where the platform gives no events (or none it shows), a fallback
 * timer asks for the revision at WATCH_FALLBACK_MS, so a change is never
 * missed on either ground. The revision itself is asked from the wiki — the
 * same digest every answer carries — so a stream never invents a change.
 * The stream ends when the asking side hangs up (`request.signal`); the
 * watcher and its timers end with it, so nothing keeps running past an
 * answered stream. Changes from outside the tree (`outside`) move the revision
 * and wake the stream the same way.
 */
export function streamingEvents(wiki: ProductWiki, request: Request, outside?: OutsideChanges): Handled {
  const stream = new ReadableStream({
    start: (into): void => {
      const write = (line: string): void => {
        try {
          into.enqueue(eventBytes.encode(line));
        } catch {
          // A stream that stopped taking bytes is ending; the closer below runs.
        }
      };
      let lastRevision: string | undefined;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let fallback: ReturnType<typeof setInterval> | undefined;
      let watcher: ReturnType<typeof watch> | undefined;
      let ended = false;
      const closeHandlers: (() => void)[] = [];
      const close = (): void => {
        if (ended) return;
        ended = true;
        for (const off of closeHandlers.splice(0)) off();
        if (debounce !== undefined) clearTimeout(debounce);
        if (fallback !== undefined) clearInterval(fallback);
        watcher?.close();
        try {
          into.close();
        } catch {
          // Already closing or closed by the asking side.
        }
      };
      const ask = (): void => {
        const asked = wiki.pages();
        if (!asked.ok) return;
        // A product whose outside source has not moved answers the tree's revision alone, as it always did.
        const extra = outside?.revision() ?? '';
        const revision = extra === '' ? asked.revision : `${asked.revision}+${extra}`;
        if (revision === lastRevision) return;
        lastRevision = revision;
        write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`);
      };
      const debounced = (): void => {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          try {
            ask();
          } catch {
            // A tree unread at this instant is not an event: the next tree event or the fallback asks again.
          }
        }, CHANGE_DEBOUNCE_MS);
      };
      write(`retry: 3000\n\n`);
      // A notice from outside is already one per commit, so it asks at once: through the debounce a loop kept busy by a fill
      // lets the fallback timer reset the delay at every turn, and the notice would wait for the fill's end.
      if (outside !== undefined) {
        closeHandlers.push(outside.subscribe(() => {
          try {
            ask();
          } catch {
            // A tree unread at this instant is not an event: the next notice or the fallback asks again.
          }
        }));
      }
      // A quiet product still needs the server to say something: an SSE
      // comment every 30 s keeps proxies and the server's own idle timer
      // from closing a stream nothing changed on. A comment is no event.
      const keepAlive = setInterval(() => write(': ping\n\n'), 30_000);
      closeHandlers.push(() => clearInterval(keepAlive));
      // The fallback timer shares the debounced check with the watcher, so a
      // stream that gets both asks once per burst and never twice.
      fallback = setInterval(debounced, WATCH_FALLBACK_MS);
      try {
        watcher = watch(wiki.product.folder, { recursive: true }, debounced);
      } catch {
        // No watcher on this platform: the fallback timer stays alone.
        watcher = undefined;
      }
      request.signal.addEventListener('abort', close);
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    }),
  };
}

/** Which app files answer which requests, by extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

/** The change stream and the app's files, over one open product and one app folder. */
export interface WikiPart {
  /** `GET /api/events`: the one change stream. */
  events: (request: Request) => Handled;
  /** The app's built files and its routes' index.html; `undefined` where the server was given no app folder. */
  app: (pathname: string) => Handled | undefined;
}

export function createWikiPart(
  json: ReplyMaker['json'],
  refused: ReplyMaker['refused'],
  wiki: ProductWiki,
  appFolder: string | undefined,
  options: { env?: Readonly<Record<string, string | undefined>>; outside?: OutsideChanges } = {},
): WikiPart {
  return {
    events: (request) => streamingEvents(wiki, request, options.outside),
    app: appFolder === undefined
      ? (): Handled | undefined => undefined
      : (pathname): Handled | undefined => serveAppFiles(json, refused, appFolder, pathname),
  };
}

/**
 * One built app file under `assets/` — the styles and fonts other surfaces
 * (the products home) read from the same build as the wikis. A file answer
 * or undefined; there is no index fallback and nothing else is offered.
 */
export function serveAppAssets(appFolder: string, pathname: string): Response | undefined {
  let wanted: string | undefined;
  try { wanted = normalize(decodeURIComponent(pathname)).replace(/^\/+/, ''); } catch { return undefined; }
  // The built stylesheet names its fonts at the root (`/fonts/…`): a products home answers them too, or the app's own faces never load under a product's prefix.
  const folder = wanted?.startsWith('fonts/') === true ? 'fonts/' : 'assets/';
  if (wanted === undefined || !wanted.startsWith(folder) || wanted.split('/').includes('..')) return undefined;
  const rest = wanted.slice(folder.length).split('/');
  if (rest.some((part) => part === '')) return undefined;
  const full = joinPath(resolve(appFolder), ...wanted.split('/'));
  try {
    if (!statSync(full).isFile()) return undefined;
    const type = CONTENT_TYPES[full.slice(full.lastIndexOf('.'))] ?? 'text/html; charset=utf-8';
    return new Response(readFileSync(full), { status: 200, headers: { 'content-type': type } });
  } catch { return undefined; }
}

function serveAppFiles(json: ReplyMaker['json'], refused: ReplyMaker['refused'], appFolder: string, pathname: string): Handled {
  const root = resolve(appFolder);
  let wanted: string | undefined;
  try {
    wanted = normalize(decodeURIComponent(pathname)).replace(/^\/+/, '');
  } catch {
    wanted = undefined; // A path holding an unknown % escape names no file the app holds.
  }
  if (wanted !== undefined && !wanted.split('/').includes('..')) {
    const full = joinPath(root, ...wanted.split('/'));
    try {
      const file = statSync(full);
      if (file.isFile()) {
        const type = CONTENT_TYPES[full.slice(full.lastIndexOf('.'))] ?? 'text/html; charset=utf-8';
        return { response: new Response(readFileSync(full), { status: 200, headers: { 'content-type': type } }) };
      }
    } catch {
      // Not held as a file: an app route falls back to index.html below;
      // anything else is a named 404 (finding 6).
    }
  }
  if (!isAppRoute(pathname)) {
    return refused(404, { message: `no such path "${pathname}": the server offers the wiki's API and the app's routes (${APP_ROUTE_PREFIXES.join(', ')})` });
  }
  try {
    const index = readFileSync(joinPath(root, 'index.html'));
    return { response: new Response(withMarkdownSibling(index.toString('utf8'), pathname), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  } catch (error) {
    return refused(404, {
      message: `no file answers "${pathname}" and the app folder ${JSON.stringify(appFolder)} holds no index.html: the app's built files were expected there (${(error as Error).message})`,
    });
  }
}

/**
 * The Markdown address a page's HTML links to: the same address with `.md`
 * after it. The products home prefixes the link as it prefixes every other
 * absolute reference in the shell.
 */
function markdownSiblingOf(pathname: string): string | undefined {
  if (!pathname.startsWith('/k/e/') && !pathname.startsWith('/k/kind/')) return undefined;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (last === '' || last.endsWith('.md') || last.endsWith('.json')) return undefined;
  return `${pathname}.md`;
}

/** The app shell with the page's `<link rel="alternate" type="text/markdown">` in its head. */
function withMarkdownSibling(html: string, pathname: string): string {
  const markdown = markdownSiblingOf(pathname);
  if (markdown === undefined) return html;
  const link = `<link rel="alternate" type="text/markdown" href="${markdown}">`;
  const at = html.toLowerCase().indexOf('</head>');
  return at < 0 ? `${link}${html}` : `${html.slice(0, at)}${link}${html.slice(at)}`;
}

/** The address prefixes the app itself answers: the knowledge wiki under `/k`, and the front door. */
const APP_ROUTE_PREFIXES = ['/k', '/'];

/** Whether the fallback to index.html may answer this path: only the app's own routes. */
function isAppRoute(pathname: string): boolean {
  return pathname === '/' || pathname === '/k' || pathname.startsWith('/k/');
}
