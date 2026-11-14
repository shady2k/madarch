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
import { readFileSync, statSync } from 'node:fs';
import { join as joinPath, normalize, resolve } from 'node:path';
import { isWikiPagePath, wikiPageAddresses } from '../knowledge/addresses.js';
import type { Handled, ReplyMaker } from './http.js';

/** The never-and-then-closer of a stream's tail: the encoded bytes one event line is written in. */
const eventBytes = new TextEncoder();

/**
 * Graph changes that affect a page: the knowledge wiki's fill reads a commit into the graph
 * (decision 0029). They ride the wiki's one change stream: the revision the
 * stream compares carries `revision()`, and a notice from `subscribe` asks the
 * stream at once, so an open page reads again after every commit and no second
 * channel is needed.
 */
export interface OutsideChanges {
  revision(): string;
  subscribe(listener: () => void): () => void;
}

/** The graph revision stream. Product files affect pages only after a plugin writes graph opinions. */
function streamingEvents(changes: OutsideChanges, request: Request): Handled {
  let close: () => void = () => {};
  let cancelled = false;
  const stream = new ReadableStream({
    start: (into): void => {
      const write = (line: string): void => { into.enqueue(eventBytes.encode(line)); };
      let lastRevision: string | undefined;
      let ended = false;
      const ask = (): void => {
        if (ended) return;
        const revision = changes.revision();
        if (revision === lastRevision) return;
        lastRevision = revision;
        write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`);
      };
      const off = changes.subscribe(ask);
      const keepAlive = setInterval(() => write(': ping\n\n'), 30_000);
      close = (): void => {
        if (ended) return;
        ended = true;
        off();
        clearInterval(keepAlive);
        request.signal.removeEventListener('abort', close);
        if (!cancelled) into.close();
      };
      write('retry: 3000\n\n');
      ask();
      request.signal.addEventListener('abort', close);
      if (request.signal.aborted) close();
    },
    cancel: (): void => { cancelled = true; close(); },
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
  changes: OutsideChanges,
  appFolder: string | undefined,
): WikiPart {
  return {
    events: (request) => streamingEvents(changes, request),
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

function serveAppFiles(_json: ReplyMaker['json'], refused: ReplyMaker['refused'], appFolder: string, pathname: string): Handled {
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
    return refused(404, { message: `${import.meta.filename}:164: no such path "${pathname}": the server offers the wiki's API and the app's routes (${APP_ROUTE_PREFIXES.join(', ')})` });
  }
  try {
    const index = readFileSync(joinPath(root, 'index.html'));
    return { response: new Response(index, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  } catch (error) {
    return refused(404, {
      message: `${import.meta.filename}:171: no file answers "${pathname}" and the app folder ${JSON.stringify(appFolder)} holds no index.html: the app's built files were expected there (${(error as Error).message})`,
    });
  }
}

/** The address prefixes the app itself answers: the knowledge wiki's pages, and the front door. */
const APP_ROUTE_PREFIXES = wikiPageAddresses();

/** Whether the fallback to index.html may answer this path: only the app's own routes. */
function isAppRoute(pathname: string): boolean {
  return isWikiPagePath(pathname);
}
