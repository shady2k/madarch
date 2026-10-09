/**
 * The server's product mode (docs/changes/draft-product/capabilities/server.md,
 * requirement `serves-wiki`): the wiki API the app reads — `GET /api/product`
 * (the product's id and name), `GET /api/pages` (its pages with their paths,
 * titles and addresses, plus the revision), `GET /api/page?path=...` (one page
 * — and the app's built files served from the app folder the server is given,
 * so a page's address can be opened, reloaded and linked.
 *
 * The product is opened once, through `openProductWiki`; a folder whose
 * manifest cannot be read refuses the start. Serving reads the product and
 * changes nothing in it: no write, no git command, no document content in the
 * log — the log line is the handler's own, method, path and status only.
 *
 * Refusals are JSON naming what was asked for and where it must be looked
 * for. The wiki's refusal body is held at its top level as `{"message"}`
 * because the app's reader shows the message straight from that field
 * (wiki/app/src/api.ts); the model routes keep their own error envelope.
 */
import type { ProductWiki } from '../product-wiki/pages.js';
import { readFileSync, statSync } from 'node:fs';
import { join as joinPath, normalize, resolve } from 'node:path';
import type { Handled, Refusal, ReplyMaker } from './http.js';

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

/** The three wiki routes and the app files' answer, over one open product and one app folder. */
export interface WikiPart {
  /** `GET /api/product`: the product's id and name. */
  product: () => Handled;
  /** `GET /api/pages`: the pages with the wiki's revision. */
  pages: () => Handled;
  /** `GET /api/page?path=...`: one page, whole. */
  page: (request: Request) => Promise<Handled>;
  /** The app's files: called for a path outside the route table, answering a file or index.html. */
  app: (pathname: string) => Handled | undefined;
}

/** Builds the wiki part from an already-opened product wiki and the app folder's path. */
export function createWikiPart(
  json: ReplyMaker['json'],
  refused: ReplyMaker['refused'],
  wiki: ProductWiki,
  appFolder: string | undefined,
): WikiPart {
  return {
    product: (): Handled => ({ response: json(200, { id: wiki.product.id, name: wiki.product.name }) }),
    pages: (): Handled => {
      const asked = wiki.pages();
      if (!asked.ok) return refused(500, { message: `the pages of the product ${JSON.stringify(wiki.product.folder)} could not be read: ${asked.message}` });
      return { response: json(200, { revision: asked.revision, pages: asked.pages }) };
    },
    page: async (request: Request): Promise<Handled> => {
      const askedFor = new URL(request.url).searchParams.get('path');
      if (askedFor === null) {
        return refused(400, {
          field: 'path',
          accepted: 'a page path the product holds, like docs/vision.md',
          message: `"path" is required: the path within the product of the page asked for, like ${JSON.stringify('docs/vision.md')}`,
        });
      }
      const asked = wiki.page(askedFor);
      if (!asked.ok) return refused(404, { field: 'path', message: asked.message });
      return { response: json(200, { path: asked.page.path, title: asked.page.title, markdown: asked.page.markdown }) };
    },
    app: appFolder === undefined ? (): Handled | undefined => undefined : (pathname): Handled | undefined => serveAppFiles(json, refused, appFolder, pathname),
  };
}

/**
 * One path under the app's files, or index.html when the app holds no file
 * there — a page's address `/p/docs/vision.md` names no file, and index.html
 * answers it, so the app's own routes run; the same answer keeps reload and
 * links working. A path under /api/ never reaches here: it is answered by
 * the routes or refused. Everything else is tried as a file inside the app
 * folder, % escapes decoded, no path climbing out of it — then index.html —
 * then a refusal naming the path asked for and the app folder, when even
 * index.html is missing.
 */
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
    return { response: new Response(index, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  } catch (error) {
    return refused(404, {
      message: `no file answers "${pathname}" and the app folder ${JSON.stringify(appFolder)} holds no index.html: the app's built files were expected there (${(error as Error).message})`,
    });
  }
}

/** The address prefixes the app itself answers: a page's route and the home page. */
const APP_ROUTE_PREFIXES = ['/p/', '/'];

/** Whether the fallback to index.html may answer this path: only the app's own routes. */
function isAppRoute(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/p/');
}
