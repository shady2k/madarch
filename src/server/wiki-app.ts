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
import { basename as nameOf } from 'node:path';
import type { ProductWiki } from '../product-wiki/pages.js';
import { readProductDiscussions, writeProductDiscussion, writeProductDiscussionAction, writeProductPageDiscussion, restoreProductDiscussionAnchor } from '../product/discussion-writer.js';
import { readProductRepos } from '../product-wiki/repos.js';
import { readProductModel } from '../product-wiki/model.js';
import { architectureBundle } from '../product-wiki/architecture.js';
import { likec4Webcomponent } from '../product-wiki/likec4-webcomponent.js';
import { renderModel } from '../render/prepare.js';
import { readStagesIndex, type StagesIndex } from '../wiki/stages.js';
import { readProductRegistry, registryKit } from '../product/registry.js';
import { readFileSync, statSync, watch } from 'node:fs';
import { join as joinPath, normalize, resolve } from 'node:path';
import { readdirSync, readFileSync as readFillFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fillStatePaths, withFillControlLock } from '../product/fill-runtime.js';
import type { Handled, Refusal, ReplyMaker } from './http.js';

/** How long the event stream holds a burst of tree events back before it asks the wiki what changed. */
export const CHANGE_DEBOUNCE_MS = 200;

/** How often a tree that gave no watch events is asked again, so a change is never missed. */
const WATCH_FALLBACK_MS = 300;

/** The never-and-then-closer of a stream's tail: the encoded bytes one event line is written in. */
const eventBytes = new TextEncoder();

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
 * answered stream.
 */
export function streamingEvents(wiki: ProductWiki, request: Request): Handled {
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
        if (!asked.ok || asked.revision === lastRevision) return;
        lastRevision = asked.revision;
        write(`event: change\ndata: ${JSON.stringify({ revision: asked.revision })}\n\n`);
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

/** The three wiki routes and the app files' answer, over one open product and one app folder. */
export interface WikiPart {
  /** `GET /api/product`: the product's id and name. */
  product: () => Handled;
  /** `GET /api/questions`: the product's questions as the set's form computes them. */
  questions: () => Handled;
  /** `GET /api/architecture`: the whole Architecture bundle, read fresh. */
  architecture: () => Handled | Promise<Handled>;
  /** `GET /api/architecture/likec4.js`: the LikeC4 webcomponent bundle of the rendered workspace. */
  likec4Script: () => Handled | Promise<Handled>;
  /** `GET /api/pages`: the pages with the wiki's revision. */
  pages: () => Handled;
  /** `GET /api/page?path=...`: one page, whole. */
  page: (request: Request) => Promise<Handled>;
  /** `GET /api/discussions?path=...`: read valid comments for one product page. */
  discussions: (request: Request) => Handled;
  /** `POST /api/discussions`: validate and write one discussion action. */
  discussion: (request: Request) => Promise<Handled>;
  /** `GET /api/stages`: the stage index, read from the product's files now. */
  stages: () => Handled;
  /** `GET /api/registry`: the product's kinds registry as the wiki reads it — the kinds and stages, or the refusals, or absence. */
  registry: () => Handled;
  /** `GET /api/fill`: current fill run, units and normalized journal. */
  fill: () => Handled;
  /** `POST /api/fill/<run-id>/{pause|stop}`: persist a control request for the fill coordinator. */
  fillControl: (request: Request, runId: string, action: 'pause' | 'stop') => Promise<Handled>;
  /** `GET /api/events`: the wiki's change stream, held open until the asker hangs up. */
  events: (request: Request) => Handled;
  /** `GET /api/repos`: the declared code repositories, their checkouts, HEADs and READMEs. */
  repos: () => Handled;
  /** Whether the manifest declares any repository: the `/r` route exists only then. */
  reposDeclared: boolean;
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
    product: (): Handled => {
      // Every overview value comes from the product registry's declared page
      // and section. The old top-level audience remains an exact alias.
      const overview = wiki.overview();
      const identity = wiki.product.manifest === 'present'
        ? { id: wiki.product.id, name: wiki.product.name, folder: nameOf(wiki.product.folder) }
        : { name: wiki.product.name, folder: nameOf(wiki.product.folder) };
      const audience = overview?.audience;
      return {
        response: json(200, {
          ...identity,
          ...(overview === undefined ? {} : { overview }),
          ...(audience === undefined ? {} : { audience }),
        }),
      };
    },
    questions: (): Handled => {
      const asked = wiki.questions();
      if (!asked.ok) return { response: json(500, { message: asked.message }) };
      return { response: json(200, { questions: asked.questions, openCount: asked.openCount }) };
    },
    architecture: async (): Promise<Handled> => {
      const product = readProductModel(wiki.product);
      const pages = new Map<string, string>();
      const listed = wiki.pages();
      if (listed.ok) {
        for (const entry of listed.pages) {
          const asked = wiki.page(entry.path);
          if (asked.ok) pages.set(entry.path, asked.page.markdown);
        }
      }
      const bundle = product.model === undefined
        ? { notes: product.notes, errors: product.errors, warnings: product.warnings, sources: product.sources }
        : await architectureBundle(product.model, product.notes, product.warnings, product.sources, pages);
      return { response: json(200, bundle) };
    },
    likec4Script: async (): Promise<Handled> => {
      const product = readProductModel(wiki.product);
      if (product.model === undefined) {
        return refused(200, {
          message: [
            'the product model does not compile, so there is no LikeC4 workspace to serve',
            ...product.errors.map((error) => `${error.file}:${error.line}: ${error.path}: ${error.message}`),
          ].join('\n'),
        });
      }
      const rendering = await renderModel(product.model, { source: 'product-model', commit: 'product', at: 0 });
      if (rendering.workspace === undefined) {
        return refused(200, {
          message: [
            'the product model does not render, so there is no LikeC4 workspace to serve',
            ...rendering.errors.map((message) => `model: ${message}`),
          ].join('\n'),
        });
      }
      const bundle = likec4Webcomponent(rendering.workspace);
      if (!bundle.ok) return refused(500, { message: bundle.message });
      return {
        response: new Response(bundle.script, {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
        }),
      };
    },
    pages: (): Handled => {
      const asked = wiki.pages();
      if (!asked.ok) return refused(500, { message: `the pages of the product ${JSON.stringify(wiki.product.folder)} could not be read: ${asked.message}` });
      // The registry's serving state rides the answer only when the
      // product holds a registry: without one the answer keeps its shape
      // before registries, and the app's banner has nothing to say.
      return asked.contract === undefined
        ? { response: json(200, { revision: asked.revision, pages: asked.pages }) }
        : { response: json(200, { revision: asked.revision, pages: asked.pages, contract: asked.contract }) };
    },
    discussions: (request: Request): Handled => {
      const document = new URL(request.url).searchParams.get('path');
      if (document === null) return refused(400, { field: 'path', message: 'path is required: name a product-relative Markdown page under docs/' });
      const result = readProductDiscussions(wiki.product.folder, document);
      if (!result.ok) return refused(result.status, { field: 'path', message: result.message });
      return { response: json(200, { discussions: result.entries }) };
    },
    discussion: async (request: Request): Promise<Handled> => {
      const declared = request.headers.get('content-length');
      if (declared !== null && Number(declared) > 1_000_000) return refused(413, { message: 'the discussion request is larger than 1 MB' });
      const text = await request.text();
      if (Buffer.byteLength(text) > 1_000_000) return refused(413, { message: 'the discussion request is larger than 1 MB' });
      let body: unknown;
      try { body = JSON.parse(text); } catch { return refused(400, { message: 'the discussion request body must be valid JSON' }); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return refused(400, { message: 'the discussion request must be an object' });
      const value = body as Record<string, unknown>;
      const document = value.document;
      const range = value.range;
      const messageBody = value.body;
      if (typeof document !== 'string' || (value.action !== 'resolve' && typeof messageBody !== 'string'))
        return refused(400, { message: 'the discussion request needs a document and the fields required by its action' });
      if (value.action === 'reply' || value.action === 'resolve') {
        if (typeof value.thread !== 'string' || (value.action === 'reply' && typeof messageBody !== 'string')) return refused(400, { message: 'reply/resolve needs a thread ULID and reply body' });
        const result = writeProductDiscussionAction(wiki.product.folder, { document, thread: value.thread, action: value.action, ...(typeof messageBody === 'string' ? { body: messageBody } : {}) });
        if (!result.ok) return refused(result.status, { field: 'thread', message: result.message });
        return { response: json(201, result) };
      }
      if (value.action === 'page') {
        if (typeof messageBody !== 'string') return refused(400, { message: 'page comment needs a message body' });
        const result = writeProductPageDiscussion(wiki.product.folder, { document, body: messageBody });
        if (!result.ok) return refused(result.status, { field: 'document', message: result.message });
        return { response: json(201, result) };
      }
      if (value.action === 'recover') {
        if (typeof value.thread !== 'string' || range === null || typeof range !== 'object' || Array.isArray(range)) return refused(400, { message: 'anchor recovery needs a thread ULID and selected range' });
        const chosen = range as Record<string, unknown>;
        if (typeof chosen.start !== 'number' || typeof chosen.end !== 'number' || typeof chosen.quote !== 'string' || typeof chosen.before !== 'string' || typeof chosen.after !== 'string' || typeof chosen.paragraph !== 'number' || typeof chosen.from !== 'number' || typeof chosen.to !== 'number') return refused(400, { message: 'anchor recovery range is incomplete' });
        const result = restoreProductDiscussionAnchor(wiki.product.folder, { document, thread: value.thread, range: { start: chosen.start, end: chosen.end, quote: chosen.quote, before: chosen.before, after: chosen.after, paragraph: chosen.paragraph, from: chosen.from, to: chosen.to } });
        if (!result.ok) return refused(result.status, { field: 'thread', message: result.message });
        return { response: json(201, result) };
      }
      if (range === null || typeof range !== 'object' || Array.isArray(range)) return refused(400, { message: 'a selected-text comment needs a range' });
      const mapped = range as Record<string, unknown>;
      if (typeof mapped.start !== 'number' || typeof mapped.end !== 'number' || typeof mapped.quote !== 'string' || typeof mapped.before !== 'string' || typeof mapped.after !== 'string' || typeof mapped.paragraph !== 'number' || typeof mapped.from !== 'number' || typeof mapped.to !== 'number')
        return refused(400, { message: 'the discussion range needs numeric start/end offsets and quote/before/after text' });
      if (typeof messageBody !== 'string') return refused(400, { message: 'discussion body must be text' });
      const result = writeProductDiscussion(wiki.product.folder, {
        document,
        range: { start: mapped.start, end: mapped.end, quote: mapped.quote, before: mapped.before, after: mapped.after, paragraph: mapped.paragraph, from: mapped.from, to: mapped.to },
        body: messageBody,
      });
      if (!result.ok) return refused(result.status, { field: 'document', message: result.message });
      return { response: json(201, result) };
    },
    page: async (request: Request): Promise<Handled> => {
      const askedFor = new URL(request.url).searchParams.get('path');
      if (askedFor === null) {
        return refused(400, {
          field: 'path',
          accepted: 'a page path the product holds, like docs/example.md',
          message: `"path" is required: the path within the product of the page asked for, like ${JSON.stringify('docs/example.md')}`,
        });
      }
      const asked = wiki.page(askedFor);
      // Absence or an invalid ask is a 404; a filesystem failure is the
      // server failing, answered with 500 and the cause kept (finding 2.10).
      if (!asked.ok) {
        return asked.notFound
          ? refused(404, { field: 'path', message: asked.message })
          : refused(500, { field: 'path', message: asked.message });
      }
      return {
        response: json(200, {
          path: asked.page.path,
          title: asked.page.title,
          markdown: asked.page.markdown,
          changedAt: asked.page.changedAt,
          document: asked.page.document,
          findings: asked.page.findings,
          structural: asked.page.structural,
          check: asked.page.check,
        }),
      };
    },
    registry: (): Handled => {
      const read = readProductRegistry(wiki.product.folder);
      if (!read.present) return { response: json(200, { present: false }) };
      if ('refused' in read) {
        return {
          response: json(200, {
            present: true,
            refused: read.refused.map((error) => ({ file: error.file, line: error.line, path: error.path, message: error.message })),
          }),
        };
      }
      // The kit's own normalization applies (a left-out cardinality reads
      // as many), so the answer carries the same defaults the page reader
      // walked the kinds by — and readProductRegistry reads fresh per ask.
      const kit = registryKit(read);
      if (kit === undefined) return { response: json(200, { present: true, refused: [] }) };
      return {
        response: json(200, {
          present: true,
          stages: kit.stages.map((stage) => ({ id: stage.id, ...(stage.name === undefined ? {} : { name: stage.name }), ...(stage.labels === undefined ? {} : { labels: stage.labels }), ...(stage.expected === undefined ? {} : { expected: stage.expected }) })),
          goals: kit.goals,
          overview: kit.overview,
          reservations: kit.reservations,
          kinds: kit.kinds.map((kind) => ({
            name: kind.name,
            ...(kind.labels === undefined ? {} : { labels: kind.labels }),
            questions: kind.questions,
            prefix: kind.prefix,
            folder: kind.folder,
            stage: kind.stage,
            hint: kind.hint,
            storage: kind.storage,
            evidence: kind.evidence,
            statuses: kind.statuses === undefined ? undefined : [...kind.statuses],
            links: kind.links === undefined ? undefined : kind.links.map((link) => ({
              field: link.field,
              targets: [...link.targets],
              backlink: link.backlink,
              cardinality: link.cardinality,
              required: link.required,
            })),
          })),
        }),
      };
    },
    stages: (): Handled => {
      let index: StagesIndex;
      try {
        index = readStagesIndex(wiki.product.folder);
      } catch (error) {
        // A product folder that cannot be read at all is the server failing:
        // 500, the folder named, the cause kept for the log line.
        return refused(500, {
          message: `the stage index of the product ${JSON.stringify(wiki.product.folder)} could not be read: ${(error as Error).message}`,
        });
      }
      return { response: json(200, index) };
    },
    fill: (): Handled => {
      const paths = fillStatePaths(wiki.product.folder);
      try {
        const run = JSON.parse(readFillFileSync(paths.run, 'utf8'));
        const units = readdirSync(paths.units).filter((entry) => entry.endsWith('.json')).sort().map((entry) => JSON.parse(readFillFileSync(joinPath(paths.units, entry), 'utf8')));
        let events: unknown[] = [];
        try { events = readFillFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return { response: json(200, { run, units, events }) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { response: json(404, { message: 'No fill run is active' }) };
        return refused(500, { message: `the fill state in ${JSON.stringify(paths.root)} could not be read: ${(error as Error).message}` });
      }
    },
    async fillControl(request, runId, action): Promise<Handled> {
      const paths = fillStatePaths(wiki.product.folder);
      return withFillControlLock(wiki.product.folder, async () => {
      try {
        const run = JSON.parse(readFillFileSync(paths.run, 'utf8')) as { id?: string; status?: string; controlOpen?: boolean };
        if (run.id !== runId) return refused(404, { message: `no fill run has id ${JSON.stringify(runId)}` });
        if (run.controlOpen === false || (run.status !== 'running' && run.status !== 'paused')) return refused(409, { message: `fill run ${JSON.stringify(runId)} is final and cannot accept control requests` });
        if (action === 'pause' && run.status !== 'running') return refused(409, { message: `fill run ${JSON.stringify(runId)} is not running` });
        mkdirSync(paths.root, { recursive: true });
        const file = joinPath(paths.root, 'control.json');
        let pending: { runId?: string; action?: string } | undefined;
        try { pending = JSON.parse(readFillFileSync(file, 'utf8')) as { runId?: string; action?: string }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (pending?.runId === runId && pending.action === 'stop' && action === 'pause') return refused(409, { message: 'a stop request is already pending for this fill run' });
        const acceptedAction = pending?.runId === runId && pending.action === 'stop' ? 'stop' : action;
        if (run.status === 'paused' && acceptedAction === 'stop') {
          writeFileSync(file, `${JSON.stringify({ runId, action: 'stop', requestedAt: new Date().toISOString() })}\n`);
          writeFileSync(paths.run, `${JSON.stringify({ ...run, status: 'stopped', controlOpen: false, updatedAt: new Date().toISOString() }, null, 2)}\n`);
          return { response: json(202, { runId, action: 'stop', accepted: true }) };
        }
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify({ runId, action: acceptedAction, requestedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
        renameSync(temporary, file);
        return { response: json(202, { runId, action: acceptedAction, accepted: true }) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refused(404, { message: 'No fill run is active' });
        return refused(500, { message: `could not request ${action} for fill run ${JSON.stringify(runId)}: ${(error as Error).message}` });
      }
      });
    },
    events: (request) => streamingEvents(wiki, request),
    repos: (): Handled => {
      const asked = readProductRepos(wiki.product);
      return { response: json(200, { repos: asked.repos }) };
    },
    reposDeclared: wiki.product.repos.length > 0,
    app: appFolder === undefined
      ? (): Handled | undefined => undefined
      : (pathname): Handled | undefined => serveAppFiles(json, refused, appFolder, pathname, wiki.product.repos.length > 0),
  };
}

/**
 * One path under the app's files, or index.html when the app holds no file
 * there — the app's own routes, `/` and `/p/…` only, fall back to index.html
 * when no file answers: a page's address `/p/docs/example.md` names no file,
 * and index.html answers it, so the app's own routes run; the same answer
 * keeps reload and links working. A path under /api/ never reaches here: it
 * is answered by the routes or refused. Any other path is tried as a file
 * inside the app folder, % escapes decoded, no path climbing out of it — and
 * when no file answers it, it is a named 404, never index.html (finding 6).
 */
function serveAppFiles(json: ReplyMaker['json'], refused: ReplyMaker['refused'], appFolder: string, pathname: string, reposDeclared: boolean): Handled {
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
  if (!isAppRoute(pathname, reposDeclared)) {
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

/** The address prefixes the app itself answers: a page's route, the questions view, a stage's route and the home page; `/r` stands among them only where repositories are declared. */
const APP_ROUTE_PREFIXES = ['/p/', '/questions', '/r', '/s/', '/'];

/** Whether the fallback to index.html may answer this path: only the app's own routes, `/r` only where the manifest declares repositories. */
function isAppRoute(pathname: string, reposDeclared: boolean): boolean {
  return pathname === '/' || pathname === '/questions' || pathname.startsWith('/questions/')
    || pathname.startsWith('/p/') || pathname.startsWith('/s/')
    || (reposDeclared && pathname === '/r');
}

