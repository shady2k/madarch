/**
 * The server's HTTP layer: Bun's own server, no framework (decision 0008),
 * with the ways in (`POST /models`, `POST /views`, `POST /sources`,
 * `GET /sources`) held in one route table, so the next one slots in beside
 * them and authentication can later be added as one layer in front of
 * them, without reshaping either (decision 0012). `POST /sources` is the
 * rename claim: it binds a new name to the id a source already has, and
 * the old name — retired — never grows a second source.
 *
 * Every refusal is JSON `{"error": {"message", "field"?, "accepted"?}}`
 * with 400, 404, 405, 409 or 413; a failure of the server itself is 500,
 * its cause logged at error level, the answer saying it failed without
 * leaking a stack. The store's own refusals (a commit already stored
 * under another model or time) are the history's errors mapped onto 409.
 *
 * One line per request goes to the logger: method, path, status, the
 * source when the request names one, and milliseconds; a refusal adds its
 * message. No model content is ever logged.
 *
 * The body limit is checked twice on purpose: the `content-length` header
 * refuses an over-large body before a byte is read, and the byte count of
 * the read text catches a lying or absent header. Bodies past Bun's own
 * default (128 MB) are never reached by honest clients; a client that
 * lies by omission costs one read, then is refused.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join as joinPath, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import type { CompiledModel } from '../model/compile.js';
import { CompiledModel as CompiledModelSchema } from '../model/compiled-schema.js';
import { byCodePoint } from '../model/order.js';
import { renderAsyncOneViewLikeC4, renderAsyncOneViewMermaid, type OneViewError, type OneViewRequest } from '../render/one-view.js';
import type { Graphs } from './graphs.js';
import { createGraphs } from './graphs.js';
import type { SourceStoreResult, SourceStores } from './sources.js';
import { createSourceStores, sourceNameProblem } from './sources.js';
import { createWikiPart, fillAuth, serveAppAssets, type WikiPart } from './wiki-app.js';
import { createGraphPagesPart, emptyGraphPagesSource, type GraphPagesPart, type GraphPagesSource } from './graph-pages.js';
import { createGraphDiagramsPart, type GraphDiagramsPart } from './graph-diagrams.js';
import { openProductWiki, type ProductWiki } from '../product-wiki/pages.js';
import { listProducts } from '../product/list.js';
import { basename } from 'node:path';
import type { StartFillOptions, StartFillResult } from '../product/fill.js';
import { UNIT_TOOL_PATH, type UnitToolAnswer, type UnitToolCall } from '../fill/unit-tools.js';
import { readChosenModel, saveChosenAgent } from '../product/fill-wizard.js';
import { homeFromEnv } from '../product/home.js';

/** The largest body the server reads: 50 MB, far past any compiled model sent so far. */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** The only protocol version this server speaks. */
const PROTOCOL_VERSION = 1;

/** The supported protocol version range. */
const PROTOCOL_ACCEPTED = '[1, 1]';

/** What the server tells a sender whose `committedAt` it refused. */
const ISO_ACCEPTED = 'an ISO 8601 time with a UTC offset, like 2026-09-30T12:34:56Z or 2026-09-30T12:34:56+02:00';

/** What the server tells a requester whose `format` it refused. */
const FORMAT_ACCEPTED = '"mermaid" or "likec4"';

/** What the server tells a requester whose `depth` it refused. */
const DEPTH_ACCEPTED = 'a whole number from 1';

/** The command that sends a model, named in the answer to a source never sent; the command itself lands with the skill's send step. */
const SEND_COMMAND = "bun scripts/send-model.ts <repository> --server <this server's address>";

export interface ServerOptions {
  /** The machine-local state folder for per-source PGlite histories and sidecars, outside the product repository; required with the model routes, left out when only a product wiki is served. */
  dataFolder?: string;
  /** Shared owner of the server's graph-query database. Required with `dataFolder`; the caller chooses PostgreSQL for server mode or explicitly constructs PGlite for local mode. `startServer` owns and closes it. */
  queryDatabase?: AsyncQueryDatabase;
  /** The product folder served as its wiki: read once, then read fresh at every ask — never written, never asked a git question. */
  productFolder?: string;
  /** Shared fill entry point injected by the product host. */
  startFill?: (productFolder: string, options: StartFillOptions) => Promise<StartFillResult>;
  /** Products home for a single server with per-product URL prefixes. */
  productHome?: string;
  /** Serving-only opt-in for an existing directory with no manifest; defaults to strict product recognition. */
  allowNoManifest?: boolean;
  /** The folder the app's built files served from (stage 2's build); without it only the API answers. */
  appFolder?: string;
  /**
   * One product's graph pages (madarch-tzte.23.1; decision 0026, "Pages"), read
   * from the fill's fact store: the page set, a page's model and the change every
   * publication pushes. The background server passes the fill service's own source
   * (`src/product/daemon.ts`); a server that holds no fill's graph passes none, and
   * the routes answer the empty page set that says where the pages are served.
   *
   * The factory is asked once per served product, so a products home serves each
   * product's own pages, never one product's under another's address.
   */
  graphPages?: (productFolder: string) => GraphPagesSource | undefined;
  /**
   * The environment the wiki's own settings are read from — the diagram tab shown
   * first (`MADARCH_WIKI_DIAGRAM`, madarch-tzte.23.4) and the cache root the
   * generated diagram documents stand in (`MADARCH_WIKI_CACHE`). The process's own
   * when it is left out.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** The address to listen on; `127.0.0.1` unless said otherwise (decision 0012). */
  host?: string;
  /** The port to listen on; 4180 by default, 0 for a free port. */
  port?: number;
  /** Supplies recorded time; tests inject a fake clock. */
  clock?: Clock;
  /**
   * The fill's orchestrator, when this process owns one (decision 0027): the
   * background server creates it, holds it for the life of the process and
   * stops it here, so the fill runs beside the wikis it fills rather than in a
   * command of its own.
   *
   * Its `unitTool` answers the calls a unit's own MCP server forwards
   * (madarch-tzte.22.2): the background server owns the database and is its only
   * writer, so a unit's server is a thin proxy to this method, and the route that
   * carries a call stands only when it is given.
   */
  orchestrator?: {
    stop(): Promise<void>;
    unitTool?(request: UnitToolCall): Promise<UnitToolAnswer | null>;
  };
  /** Where request lines go; standard output by default. */
  log?: (line: string) => void;
  /** Where error-level lines go; standard error by default. */
  errorLog?: (line: string) => void;
}

export interface StartedServer {
  hostname: string;
  port: number;
  /** The base URL, no trailing slash. */
  url: string;
  /** Stops serving and closes the graphs and the sources' histories. */
  stop(): Promise<void>;
}

/** One refusal's content, the shape the error answers carry. */
export interface Refusal {
  message: string;
  field?: string;
  accepted?: string;
  /**
   * The refusal's own machine-readable name, when the route has one (`graph-pages/no-such-node`),
   * so a client can branch on what went wrong instead of reading the words. It rides in the
   * error envelope beside the message.
   */
  code?: string;
  /**
   * The same refusal as the log line may carry it — field paths, never
   * model values. Left out, the message itself is safe to log: it quotes
   * only request-field values, and no model content.
   */
  logMessage?: string;
}

/**
 * The answer-making the wiki part is given: the same shapes the handler
 * itself replies with, handed over so the wiki's refusals are built in one
 * place beside the model routes'. The wiki's refusal body is held flat as
 * `{"message"}` — held **beside** this project's own {"error": {...}}
 * envelope, both in one body — because the app's reader
 * (wiki/app/src/api.ts) reads the message from the body's top level, and
 * a reader of this server's refusals still finds the usual envelope even
 * in a wiki answer.
 */
export interface ReplyMaker {
  json: (status: number, body: unknown) => Response;
  refused: (status: number, error: Refusal) => Handled;
}

/** A plain JSON answer. */
function makeJson(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** A wiki refusal: the flat message the app reads, beside the usual error envelope; the log-safe message kept for the log line. */
function wikiRefused(status: number, error: Refusal): Handled {
  const { logMessage, ...clientError } = error;
  return { response: Response.json({ message: error.message, error: clientError }, { status }), refusal: logMessage ?? error.message };
}

/** What one route's handling produced, beside the answer itself: what the log line names. */
export interface Handled {
  response: Response;
  /** The source the request named, when it named one. */
  source?: string;
  /** The refusal's message, when the answer is a refusal. */
  refusal?: string;
}

/** A sent store request, every field checked and parsed. */
interface SentStore {
  source: string;
  commit: string;
  /** The commit time, parsed from the request's ISO 8601 text to UTC epoch milliseconds. */
  committedAtMs: number;
  model: CompiledModel;
}

/** A view request, every field checked and parsed; `depth` carries its default of 1. */
interface AskedView {
  source: string;
  element?: string;
  depth: number;
  format: 'mermaid' | 'likec4';
}

/** A rename claim, every field checked and parsed. */
interface ClaimedRename {
  /** The id the server assigned the source on its first send. */
  id: string;
  /** The source's new name. */
  source: string;
}

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const queryDatabase = options.queryDatabase;
  if (options.dataFolder === undefined && options.productFolder === undefined && options.productHome === undefined) {
    await queryDatabase?.close().catch(() => {});
    throw new Error("the server is started with neither a data folder nor a product folder: give --data <folder> for the sources' histories, --product <folder> for a product's wiki, or both");
  }
  if (options.dataFolder !== undefined && options.queryDatabase === undefined) {
    throw new Error('the server model routes need a shared graph-query database owner: pass queryDatabase explicitly (PostgreSQL in server mode, or PGlite in local mode); dataFolder selects only the source-history folder');
  }
  if (options.dataFolder === undefined && options.queryDatabase !== undefined) {
    await queryDatabase?.close().catch(() => {});
    throw new Error('a shared graph-query database owner is only used with the model routes: give dataFolder with queryDatabase');
  }
  let wiki: ReturnType<typeof openProductWiki> | undefined;
  let appFolder = options.appFolder;
  try {
    if (options.productFolder !== undefined) {
      wiki = openProductWiki(options.productFolder, { allowNoManifest: options.allowNoManifest });
      if (wiki !== undefined && !wiki.ok) throw new Error(`the product ${JSON.stringify(options.productFolder)} cannot be served as a wiki: ${wiki.message}`);
    }
    if ((options.productFolder !== undefined || options.productHome !== undefined) && appFolder === undefined) {
      const candidate = joinPath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wiki', 'app', 'dist');
      if (existsSync(joinPath(candidate, 'index.html'))) appFolder = candidate;
      else {
        const subject = options.productFolder !== undefined ? `the product ${JSON.stringify(options.productFolder)} cannot be served as a wiki: ` : '';
        throw new Error(`${subject}the app's built files are not at ${JSON.stringify(candidate)} — build the app first (bun install --frozen-lockfile && bun run build in wiki/app), or name the built folder with the app folder option`);
      }
    }
  } catch (error) {
    await queryDatabase?.close().catch(() => {});
    throw error;
  }
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  // The writer is the safe place: every line is escaped here once, so a
  // control character in a request field, a commit id or a cause can
  // never split a line again.
  const sink = options.log ?? ((line: string) => console.log(line));
  const errorSink = options.errorLog ?? ((line: string) => console.error(line));
  const log = (line: string) => sink(escapeControlCharacters(line));
  const errorLog = (line: string) => errorSink(escapeControlCharacters(line));
  const productWiki = wiki !== undefined && wiki.ok ? wiki.wiki : undefined;
  let sources: SourceStores | undefined;
  try {
    sources = options.dataFolder === undefined ? undefined : await createSourceStores({ dataFolder: options.dataFolder, clock, log });
  } catch (error) {
    await queryDatabase?.close().catch(() => {});
    throw error;
  }
  const graphs = sources === undefined || queryDatabase === undefined
    ? undefined
    : createGraphs({ historyOf: (source) => sources.historyOf(source), database: queryDatabase });
  /**
   * One product's graph pages, over the source this server was given for it: the
   * fill service's own in the background server, and — for a server that holds no
   * fill's graph — the empty source that answers a page set with the message saying
   * where the pages are served (0026: an empty graph answers a message, never an
   * error).
   */
  const graphPagesOf = (productFolder: string, product: string): GraphPagesPart =>
    createGraphPagesPart({ json: makeJson, refused: wikiRefused, errorLog }, options.graphPages?.(productFolder) ?? emptyGraphPagesSource(product));
  /**
   * One product's graph diagrams, over the same source its pages are read from: the
   * page's own diagrams, and the two documents the LikeC4 and archify tabs draw
   * (madarch-tzte.23.4). `mount` is the prefix the app is served under, which the
   * generated documents carry in their own links.
   */
  const env = options.env ?? process.env;
  const graphDiagramsOf = (productFolder: string, product: string): GraphDiagramsPart =>
    createGraphDiagramsPart({ json: makeJson, refused: wikiRefused, errorLog }, options.graphPages?.(productFolder) ?? emptyGraphPagesSource(product), { env });
  const handle = createHandler({
    env,
    sources,
    graphs,
    log,
    errorLog,
    wiki: productWiki === undefined ? undefined : createWikiPart(makeJson, wikiRefused, productWiki, appFolder, { env }),
    appFolder,
    startFill: options.startFill,
    productFolder: options.productFolder,
    unitTool: options.orchestrator?.unitTool,
    graphPages: productWiki === undefined ? undefined : graphPagesOf(productWiki.product.folder, productWiki.product.name),
    graphDiagrams: productWiki === undefined ? undefined : graphDiagramsOf(productWiki.product.folder, productWiki.product.name),
  });
  // The products home is served by one server: the home page lists the
  // products, and each product's wiki answers under `/products/<folder>/`.
  // The wiki app derives that prefix from its own address (app-base), so the
  // only server-side rewriting is the app shell's absolute asset references.
  // The home is re-read when its folder changes and at most every few
  // seconds, so a product created after the server started is served without
  // a restart, and no request pays for a re-read when nothing changed.
  interface ProductEntry { wiki: ProductWiki; handler: ServerHandler; }
  const productHome = options.productHome;
  const productEntries = new Map<string, ProductEntry>();
  let homeStamp = -1;
  let lastRefresh = 0;
  const refreshProducts = (): void => {
    if (productHome === undefined) return;
    let stamp = -1;
    try { stamp = statSync(productHome).mtimeMs; } catch { stamp = -1; }
    if (stamp === homeStamp && Date.now() - lastRefresh < 5000) return;
    homeStamp = stamp;
    lastRefresh = Date.now();
    const listed = listProducts({ home: productHome });
    if (listed.outcome !== 'listed') {
      errorLog(`the products home ${productHome} could not be listed: ${listed.message}`);
      return;
    }
    const next = new Map<string, ProductEntry>();
    for (const item of listed.products) {
      const opened = openProductWiki(item.folder);
      if (!opened.ok) {
        errorLog(`the product ${JSON.stringify(item.folder)} cannot be served as a wiki: ${opened.message}`);
        continue;
      }
      next.set(basename(item.folder), {
        wiki: opened.wiki,
        handler: createHandler({ env, sources, graphs, log, errorLog, wiki: createWikiPart(makeJson, wikiRefused, opened.wiki, appFolder, { env }), appFolder, startFill: options.startFill, productFolder: item.folder, unitTool: options.orchestrator?.unitTool, graphPages: graphPagesOf(item.folder, opened.wiki.product.name), graphDiagrams: graphDiagramsOf(item.folder, opened.wiki.product.name) }),
      });
    }
    productEntries.clear();
    for (const [name, entry] of next) productEntries.set(name, entry);
  };
  /**
 * One product card's one-line description: the problem the product itself
 * declares in its registry, folded to the first line, and nothing where the
 * product declares none — the card never invents words for it.
 */
  const cardDescription = (entry: ProductEntry): string => {
    try {
      const problem = entry.wiki.overview()?.problem;
      if (problem === undefined) return '';
      return problem.trim().split(/\s*\n\s*/)[0] ?? '';
    } catch { return ''; }
  };

  /** The built wiki app's stylesheet href (its design tokens and fonts), read from the app folder's index.html; undefined when none answers. */
  const appStylesheetHref = (distFolder: string | undefined): string | undefined => {
    if (distFolder === undefined) return undefined;
    let html: string;
    try { html = readFileSync(joinPath(distFolder, 'index.html'), 'utf8'); } catch { return undefined; }
    const link = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/.exec(html) ?? /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"[^>]*>/.exec(html);
    const href = link?.[1];
    return href !== undefined && href.startsWith('/assets/') ? href : undefined;
  };

  /**
   * The products home in the wiki app's own look: the same built stylesheet —
   * the tokens and fonts the app's shell reads — the shell's brand, toolbar
   * and reading area, one card per product with its name and the one-line
   * description the product itself declares, and the wiki's language switch,
   * which writes the same storage key the app reads
   * (`madarch-wiki-language`, en/ru). Without the built app's stylesheet the
   * plain page answers, so a home without a built app still reads.
   */
  const productsHomePage = (): Response => {
    refreshProducts();
    const names = [...productEntries.keys()].sort(byCodePoint);
    const stylesheet = appStylesheetHref(appFolder);
    if (stylesheet === undefined) {
      const items = names.map((name) => `<li><a href="/products/${encodeURIComponent(name)}/">${escapeHtml(productEntries.get(name)!.wiki.product.name)}</a></li>`).join('');
      const empty = names.length === 0 ? '<p>No products yet: run madarch new.</p>' : '';
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Madarch products</title></head><body><h1>Products</h1><ul>${items}</ul>${empty}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const cards = names.map((name) => {
      const entry = productEntries.get(name)!;
      const shown = escapeHtml(entry.wiki.product.name);
      const description = cardDescription(entry);
      return `<li><a class="home-row home-repository-row" href="/products/${encodeURIComponent(name)}/" data-testid="product-card"><strong class="home-repository-name">${shown}</strong>${description === '' ? '' : `<span class="home-repository-part">${escapeHtml(description)}</span>`}</a></li>`;
    }).join('');
    const empty = names.length === 0 ? '<p class="home-products-empty" data-testid="home-empty">No products yet: run madarch new.</p>' : '';
    const globe = '<svg aria-hidden="true" class="size-[21px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
    const brand = '<svg aria-hidden="true" class="size-[40px] shrink-0 text-ink" viewBox="0 0 50 32"><text x="0" y="25" fill="currentColor" font-family="Inter, sans-serif" font-size="31" font-weight="750" letter-spacing="-4">m<tspan fill="var(--text)">·</tspan></text></svg>';
    return new Response(`<!doctype html><html lang="en" id="products-home"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Madarch products</title><link rel="stylesheet" crossorigin href="${escapeHtml(stylesheet)}"></head><body><div class="flex h-dvh bg-page text-ink [font-family:var(--font-sans)] text-body"><aside class="hidden w-[240px] wide:w-[260px] shrink-0 flex-col border-r border-line bg-chrome px-[14px] wide:px-[18px] md:flex" aria-label="madarch"><a href="/" class="nav-brand flex items-center gap-2.5 px-2 py-[14px] text-ink no-underline hover:text-ink" data-testid="nav-brand">${brand}<strong class="text-[23px] font-[650] leading-none tracking-[-0.8px]">madarch</strong><small class="ml-auto rounded-[var(--radius-row)] border border-line px-[5px] py-0.5 text-[11px] leading-4 text-muted" data-testid="brand-concept">wiki</small></a></aside><div class="flex min-w-0 flex-1 flex-col"><header class="shell-toolbar flex min-h-[58px] items-center justify-between gap-3 border-b border-line px-4 wide:px-[35px]"><span class="shell-breadcrumb min-w-0 truncate text-small text-secondary"><span class="text-ink" data-testid="home-title">Products</span></span><span class="flex shrink-0 items-center gap-1"><button type="button" class="shell-language size-9" aria-label="Language" title="Language" data-testid="language-toggle">${globe}</button></span></header><div class="shell-document"><main><h1 data-testid="home-heading">Products</h1><section class="home-group" data-testid="home-products" aria-label="Products"><ul class="home-rows">${cards}</ul></section>${empty}</main></div></div></div><script>(function(){var TT={en:{title:"Products",concept:"wiki",empty:"No products yet: run madarch new.",label:"Language",ru:"Russian",en:"English"},ru:{title:"Продукты",concept:"вики",empty:"Продуктов пока нет: запустите madarch new.",label:"Язык",ru:"Русский",en:"Английский"}};var KEY="madarch-wiki-language";function pick(){try{var k=localStorage.getItem(KEY);if(k)return k.indexOf("ru")===0?"ru":"en";}catch(e){}try{var l=(navigator.languages&&navigator.languages[0])||navigator.language;return (l||"en").toLowerCase().indexOf("ru")===0?"ru":"en";}catch(e){return "en";}}var lang=pick();function say(sel,v){var el=document.querySelector(sel);if(el)el.textContent=v;}function render(){var t=TT[lang];say("[data-testid=home-title]",t.title);say("[data-testid=home-heading]",t.title);say("[data-testid=brand-concept]",t.concept);say("[data-testid=home-empty]",t.empty);say("#products-lang-label",t.label);say("#products-lang-ru span",t.ru);say("#products-lang-en span",t.en);document.documentElement.lang=lang;var b=document.querySelector("[data-testid=language-toggle]");if(b){b.setAttribute("aria-label",t.label);b.setAttribute("title",t.label);}}window.__setHomeLanguage=function(next){lang=next;try{localStorage.setItem(KEY,next);}catch(e){}render();var m=document.getElementById("products-language-menu");if(m)m.remove();};render();var b=document.querySelector("[data-testid=language-toggle]");if(b){b.addEventListener("click",function(){var m=document.getElementById("products-language-menu");if(m){m.remove();return;}m=document.createElement("div");m.id="products-language-menu";m.className="language-menu";m.setAttribute("data-state","open");m.style.position="fixed";var r=b.getBoundingClientRect();m.style.top=(r.bottom+7)+"px";m.style.right=(window.innerWidth-r.right)+"px";m.innerHTML='<div class="language-menu-label" id="products-lang-label"></div><div class="language-menu-separator"></div><button type="button" class="language-menu-item" id="products-lang-ru" data-lang="ru"><span class="language-menu-check">'+(lang==="ru"?"✓":"")+'</span><span></span></button><button type="button" class="language-menu-item" id="products-lang-en" data-lang="en"><span class="language-menu-check">'+(lang==="en"?"✓":"")+'</span><span></span></button>';m.querySelector("#products-lang-ru span:last-child").textContent=TT[lang].ru;m.querySelector("#products-lang-en span:last-child").textContent=TT[lang].en;m.querySelector("#products-lang-ru").addEventListener("click",function(){window.__setHomeLanguage("ru");});m.querySelector("#products-lang-en").addEventListener("click",function(){window.__setHomeLanguage("en");});document.body.appendChild(m);}});})();</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  /** One built app file at the home's own /assets: the styles and fonts the home reads ship with the app's own build; anything else is a named 404, never an app shell. */
  /** One built app file at the home's own /assets: the styles and fonts the home reads ship with the app's own build; anything else is a named 404, never an app shell. */
  const serveHomeAssets = (pathname: string): Response => {
    const answered = appFolder === undefined ? undefined : serveAppAssets(appFolder, pathname);
    if (answered !== undefined) return answered;
    if (appFolder === undefined) return notServed(`this server serves a products home: the products are listed at /, and each product's wiki answers under /products/<folder>/`);
    return notServed(`no built app file answers "${pathname}" under the app folder ${JSON.stringify(appFolder)}: the home reads the styles and fonts the app's own build ships`);
  };
const notServed = (message: string): Response => Response.json({ message }, { status: 404 });
  /** The app shell's absolute asset references must answer under the product's own prefix. */
  const withProductPrefix = async (response: Response, prefix: string): Promise<Response> => {
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    const html = (await response.text()).replaceAll('="/', `="${prefix}/`);
    return new Response(html, { status: response.status, headers });
  };
  const handleProductsHome = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') return productsHomePage();
    if (url.pathname === '/assets' || url.pathname.startsWith('/assets/')) return serveHomeAssets(url.pathname);
    // The fill's unit tools answer for the process, not for one served product: a unit's own MCP server
    // posts to the root path whether the server serves a home of products or one product (madarch-tzte.22.2).
    if (url.pathname === UNIT_TOOL_PATH) return handle(request);
    const match = /^\/products\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (match === null) return notServed(`this server serves a products home: the products are listed at ${new URL('/', url).href}, and each product's wiki answers under /products/<folder>/`);
    let name: string;
    try { name = decodeURIComponent(match[1]!); } catch { return notServed(`the product path ${JSON.stringify(url.pathname)} holds a percent escape the server cannot read: ask for the product by its folder name`); }
    refreshProducts();
    const entry = productEntries.get(name);
    if (entry === undefined) return notServed(`no product ${JSON.stringify(name)} is served: the products are listed at ${new URL('/', url).href}`);
    const rest = match[2] === undefined ? '/' : `/${match[2]}`;
    const forwarded = new Request(new URL(rest + url.search, url), request);
    return withProductPrefix(await entry.handler(forwarded), `/products/${encodeURIComponent(name)}`);
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.host ?? '127.0.0.1',
      port: options.port ?? 4180,
      fetch: (request) => (options.productHome === undefined ? handle(request) : handleProductsHome(request)),
      // A wiki's change stream goes quiet for minutes; the idle default would
      // end it. 255 s between incoming frames, plus the stream's own 30 s
      // comments, keeps one long-lived request alive without polling.
      idleTimeout: 255,
    });
  } catch (error) {
    await graphs?.close().catch(() => {});
    await queryDatabase?.close().catch(() => {});
    await sources?.close().catch(() => {});
    throw error;
  }
  return {
    hostname: server.url.hostname,
    port: server.url.port === '' ? (options.port ?? 4180) : Number(server.url.port),
    url: server.url.origin,
    async stop(): Promise<void> {
      server.stop(true);
      await handle.drain();
      let failure: unknown;
      try { await graphs?.close(); } catch (error) { failure ??= error; }
      try { await queryDatabase?.close(); } catch (error) { failure ??= error; }
      try { await sources?.close(); } catch (error) { failure ??= error; }
      try { await options.orchestrator?.stop(); } catch (error) { failure ??= error; }
      if (failure !== undefined) throw failure;
    },
  };
}

export interface ServerHandler {
  (request: Request): Promise<Response>;
  /** Waits for in-flight state requests before persistence closes. */
  drain(): Promise<void>;
}

/** The request handler used by Bun; exported so tests can drive HTTP requests with controlled async dependencies. */
export function createHandler(dependencies: {
  sources?: SourceStores;
  graphs?: Graphs;
  log: (line: string) => void;
  errorLog: (line: string) => void;
  /** The product's wiki routes and app files, when a product folder was given. */
  wiki?: WikiPart;
  appFolder?: string;
  startFill?: ServerOptions['startFill'];
  productFolder?: string;
  /** The fill's unit tools, when this process serves them (`POST /api/fill/unit/tool`). */
  unitTool?: (request: UnitToolCall) => Promise<UnitToolAnswer | null>;
  /** One product's graph pages (madarch-tzte.23.1): its page set, a node's page and the live channel of their changes. */
  graphPages?: GraphPagesPart;
  /** The graph's diagrams and their generated documents (madarch-tzte.23.4). */
  graphDiagrams?: GraphDiagramsPart;
  /** The environment the handler judges a request against; the process's own when it is left out (the fill's sign-in choice reads it). */
  env?: ServerOptions['env'];
}): ServerHandler {
  const { log, errorLog, wiki } = dependencies;
  const handlerEnv = dependencies.env ?? process.env;
  // The model routes are put in the table only when a data folder was
  // given, so their handlers below can never be entered without the
  // sources and the graphs: the types stay asserted, the guard is the
  // route table above, and a product-only server holds neither.
  const sources = dependencies.sources as SourceStores;
  const graphs = dependencies.graphs as Graphs;

  /** One way in. A new route is one more entry here, nothing else. */
  interface Route {
    method: string;
    path: string;
    handle: (request: Request) => Handled | Promise<Handled>;
  }

  // A store commits history before applying its graph report. A view reads
  // both, so allow model stores, rename claims and views one state operation
  // at a time; no view can pair a new history snapshot with an old graph.
  let stateTail: Promise<void> = Promise.resolve();
  async function serializeState<T>(operation: () => Promise<T>): Promise<T> {
    const previous = stateTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stateTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  // The model routes are the server's own; the wiki's answer beside them,
  // both kept apart by what the server was given.
  const startFill = dependencies.startFill;
  const fillProductFolder = dependencies.productFolder;
  const routes: Route[] = [
    // A unit's own MCP server forwards its tool calls here (madarch-tzte.22.2): the background server owns
    // the database and is its only writer, and the route stands only when this process serves the fill.
    ...(dependencies.unitTool === undefined ? [] : ([{ method: 'POST', path: UNIT_TOOL_PATH, handle: (request) => unitToolCall(request) }] as Route[])),
    ...(sources !== undefined
      ? ([
          { method: 'POST', path: '/models', handle: (request) => serializeState(() => storeModel(request)) },
          { method: 'POST', path: '/views', handle: (request) => serializeState(() => answerView(request)) },
          { method: 'POST', path: '/sources', handle: (request) => serializeState(() => claimRename(request)) },
          { method: 'GET', path: '/sources', handle: listSources },
        ] as Route[])
      : []),
    ...(wiki !== undefined ? ([
      { method: 'GET', path: '/api/product', handle: () => wiki.product() },
      { method: 'GET', path: '/api/questions', handle: () => wiki.questions() },
      { method: 'GET', path: '/api/pages', handle: () => wiki.pages() },
      { method: 'GET', path: '/api/page', handle: wiki.page },
      { method: 'GET', path: '/api/discussions', handle: wiki.discussions },
      { method: 'POST', path: '/api/discussions', handle: (request) => serializeState(() => wiki.discussion(request)) },
      { method: 'POST', path: '/api/questions/answer', handle: (request) => serializeState(() => wiki.answerQuestion(request)) },
      { method: 'GET', path: '/api/stages', handle: () => wiki.stages() },
      { method: 'GET', path: '/api/registry', handle: () => wiki.registry() },
      { method: 'GET', path: '/api/events', handle: wiki.events },
      ...(dependencies.graphPages === undefined ? [] : ([
        { method: 'GET', path: '/api/graph/pages', handle: (request: Request) => dependencies.graphPages!.pages(request) },
        { method: 'GET', path: '/api/graph/page', handle: (request: Request) => dependencies.graphPages!.page(request) },
        { method: 'GET', path: '/api/graph/events', handle: (request: Request) => dependencies.graphPages!.events(request) },
      ] as Route[])),
      ...(dependencies.graphDiagrams === undefined ? [] : ([
        { method: 'GET', path: '/api/graph/diagrams', handle: (request: Request) => dependencies.graphDiagrams!.diagrams(request) },
        { method: 'GET', path: '/api/graph/likec4.js', handle: (request: Request) => dependencies.graphDiagrams!.likec4(request) },
        { method: 'GET', path: '/api/graph/likec4.html', handle: (request: Request) => dependencies.graphDiagrams!.likec4Page(request) },
        { method: 'GET', path: '/api/graph/archify', handle: (request: Request) => dependencies.graphDiagrams!.archify(request) },
      ] as Route[])),
      { method: 'GET', path: '/api/fill', handle: () => wiki.fill() },
      { method: 'POST', path: '/api/fill/start', handle: async (request) => {
        if (!startFill || fillProductFolder === undefined) return refused(503, { message: 'The fill entry point is not configured for this server' });
        const { body, bad } = await jsonBody(request); if (bad) return bad;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return refused(400, { message: 'body must be an object with agent and maxUnits' });
        const asked = body as Record<string, unknown>;
        if (asked.agent !== 'claude' && asked.agent !== 'codex' && asked.agent !== 'omp') return refused(400, { message: 'agent must be claude, codex, or omp' });
        if (asked.maxUnits !== undefined && (!Number.isInteger(asked.maxUnits) || (asked.maxUnits as number) < 1 || (asked.maxUnits as number) > 10000)) return refused(400, { message: 'maxUnits must be a whole number from 1 through 10000' });
        if (asked.model !== undefined && typeof asked.model !== 'string') return refused(400, { message: 'model must be a string' });
        // The wizard's field is always sent for omp, an empty string
        // included: it means the reader left the field to the machine's
        // setting, so it must not become the choice yet not defeat the
        // environment the refusal message and both hints advertise.
        const askedModel = typeof asked.model === 'string' && asked.model !== '' ? asked.model : undefined;
        // How the fill pays is judged before anything is saved, and an
        // API-key fill of an agent whose variable is unset is refused by the
        // variable's name (fillAuth): madarch never asks for the key itself.
        const auth = fillAuth(asked.agent, asked.auth, handlerEnv);
        if ('refusal' in auth) return refused(400, { message: auth.refusal });
        // The omp adapter needs an explicit model and a gateway extension. The
        // model is the per-machine setting (the wizard's field, or the
        // environment the CLI reads); the extension stays environment-only.
        try {
          const settingsHome = homeFromEnv(handlerEnv);
          const candidateModel = askedModel ?? ((await readChosenModel(settingsHome)) || handlerEnv.MADARCH_FILL_MODEL);
          if (asked.agent === 'omp') {
            if (!candidateModel) return refused(400, { message: 'omp needs a model: set it in the wizard or through MADARCH_FILL_MODEL' });
            if (!handlerEnv.MADARCH_OMP_EXTENSION) return refused(400, { message: 'omp needs the gateway extension path: set MADARCH_OMP_EXTENSION' });
          }
          await saveChosenAgent(asked.agent, { ...(asked.auth === undefined ? {} : { auth: auth.auth }), ...(askedModel === undefined ? {} : { model: askedModel }) }, settingsHome);
          const chosenModel = (await readChosenModel(settingsHome)) || handlerEnv.MADARCH_FILL_MODEL;
          // The fill itself runs in this process's own environment (it is
          // spawned by src/product/fill-agents.ts), which is what the wizard's
          // `env` stands for when the server was given one.
          const ompOptions = { model: chosenModel, ompExecutable: handlerEnv.MADARCH_OMP_EXECUTABLE, ompExtension: handlerEnv.MADARCH_OMP_EXTENSION };
          void startFill(fillProductFolder!, { agent: asked.agent, ...(asked.maxUnits === undefined ? {} : { maxUnits: asked.maxUnits as number }), ...(asked.agent === 'omp' ? ompOptions : {}) }).catch((error) => errorLog(`fill start failed: ${(error as Error).message}`));
          return { response: json(202, { accepted: true, status: 'starting' }) };
        }
        catch (error) { return refused(409, { message: (error as Error).message }); }
      } },
      { method: 'GET', path: '/api/fill/wizard', handle: (request) => wiki.fillWizard(request) },
      { method: 'POST', path: '/api/fill/agent-install', handle: (request) => wiki.fillAgentInstall(request) },
      { method: 'GET', path: '/api/fill/inventory', handle: () => wiki.fillInventory() },
      { method: 'POST', path: '/api/fill/test', handle: (request) => wiki.fillAgentTest(request) },
      { method: 'POST', path: '/api/fill/control', handle: (request) => { const url = new URL(request.url); const action = url.searchParams.get('action'); if (action !== 'pause' && action !== 'stop') return refused(400, { message: 'fill action must be exactly pause or stop' }); return serializeState(() => wiki.fillControl(request, url.searchParams.get('runId') ?? '', action)); } },
      { method: 'GET', path: '/api/architecture', handle: () => wiki.architecture() },
      { method: 'GET', path: '/api/architecture/likec4.js', handle: () => wiki.likec4Script() },
      ...(wiki.reposDeclared ? ([{ method: 'GET', path: '/api/repos', handle: () => wiki.repos() }] as Route[]) : []),
    ] as Route[]) : []),
  ];

  function json(status: number, body: unknown, headers?: Record<string, string>): Response {
    return Response.json(body, { status, headers });
  }

  /** A refusal: the error body, the log-safe message kept for the log line — the log form never reaches the client. */
  function refused(status: number, error: Refusal, headers?: Record<string, string>): Handled {
    const { logMessage, ...clientError } = error;
    return { response: json(status, { error: clientError }, headers), refusal: logMessage ?? error.message };
  }

  /** Several collected problems joined into one refusal: the field named when they share one, what is accepted when one answer covers them. */
  function joinedRefusal(status: number, problems: Refusal[]): Handled {
    const error: Refusal = { message: problems.map((problem) => problem.message).join('; ') };
    const fields = new Set(problems.map((problem) => problem.field).filter((field) => field !== undefined));
    const accepteds = new Set(problems.map((problem) => problem.accepted).filter((accepted) => accepted !== undefined));
    if (fields.size === 1) error.field = [...fields][0];
    if (accepteds.size === 1) error.accepted = [...accepteds][0];
    return refused(status, { ...error, logMessage: problems.map((problem) => problem.logMessage ?? problem.message).join('; ') });
  }

  /** The parsed JSON body, or the refusal that replaces it: past the size limit, or not JSON at all. */
  async function jsonBody(request: Request): Promise<{ body?: unknown; bad?: Handled }> {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
      return { bad: refused(413, { message: `the body is ${declaredLength} bytes by its own content-length, past the ${MAX_BODY_BYTES}-byte (50 MB) limit` }) };
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      return { bad: refused(413, { message: `the body is ${Buffer.byteLength(text)} bytes, past the ${MAX_BODY_BYTES}-byte (50 MB) limit` }) };
    }
    try {
      return { body: JSON.parse(text) };
    } catch (error) {
      return { bad: refused(400, { message: `the body is not valid JSON: ${(error as Error).message}` }) };
    }
  }

  /**
   * One tool call a unit's MCP server forwarded: the token names the unit's
   * session, the tool names one of the ten, and the answer is the tool's own —
   * the same answer the agent would have read had it run in this process. A token
   * no open session holds is a refusal of this route, never an empty answer: a
   * unit whose attempt ended has no tools, and saying so is what lets the agent
   * stop instead of waiting.
   */
  async function unitToolCall(request: Request): Promise<Handled> {
    const unitTool = dependencies.unitTool;
    if (unitTool === undefined) return refused(503, { message: 'the fill\'s unit tools are not served by this server' });
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return refused(400, { message: 'body must be an object naming token, tool and the call\'s arguments' });
    }
    const asked = body as Record<string, unknown>;
    for (const key of Object.keys(asked).sort(byCodePoint)) {
      if (key !== 'token' && key !== 'tool' && key !== 'arguments') {
        return refused(400, { field: key, message: `"${key}" is not a field a unit\'s tool call takes: accepted fields are token, tool and arguments` });
      }
    }
    if (typeof asked.token !== 'string' || asked.token === '') {
      return refused(400, { field: 'token', message: `"token" is required: the token the host minted for the unit\'s session` });
    }
    if (typeof asked.tool !== 'string' || asked.tool === '') {
      return refused(400, { field: 'tool', message: `"tool" is required: the name of the tool of the unit\'s server to call` });
    }
    const answered = await unitTool({
      token: asked.token,
      tool: asked.tool,
      ...(asked.arguments === undefined ? {} : { arguments: asked.arguments }),
    });
    if (answered === null) {
      return refused(401, { field: 'token', message: 'no open unit session holds this token: a unit\'s tools answer only while its unit runs' });
    }
    return { response: json(200, answered) };
  }

  async function storeModel(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;
    const protocol = protocolProblem(body);
    if (protocol !== undefined) return protocol;
    const { sent, problems } = parseStoreRequest(body);
    if (sent === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    // The old name of a renamed source never grows a second source: the
    // refusal explains the rename and names the name to send under.
    const renamedTo = sources.retiredHead(sent.source);
    if (renamedTo !== undefined) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the source ${JSON.stringify(sent.source)} was renamed to ${JSON.stringify(renamedTo.source)} (id ${JSON.stringify(renamedTo.id)}): the old name holds no source of its own; send under the new name`,
        }),
        source: sent.source,
      };
    }

    let stored: SourceStoreResult;
    try {
      stored = await sources.store({
        source: sent.source,
        commit: sent.commit,
        committedAt: sent.committedAtMs,
        model: sent.model,
      });
    } catch (error) {
      // The store's history may already hold the commit — the sidecar
      // write is what failed — so a built engine may now sit behind the
      // history, and the retry this caller will make reports no rows
      // (already stored) that could bring it back in step. Drop the
      // built engines of the graphs listing the source: the next use
      // rebuilds them from the history through the clash check, never
      // from an older model (the precedent of `Graphs.applyStore` for a
      // multi-source graph).
      await graphs.dropBuilt(sent.source);
      throw error;
    }
    const { result, wasNew } = stored;
    if (result.errors.length > 0) {
      // The history refused (a commit already stored under another model
      // or time); its error names the commit and the source already.
      return { ...refused(409, { message: result.errors[0]!.message }), source: sent.source };
    }
    await graphs.applyStore(sent.source, result);
    if (wasNew) {
      return { response: json(201, { stored: true, source: sent.source, commit: sent.commit }), source: sent.source };
    }
    return { response: json(200, { stored: false, reason: 'already stored', source: sent.source, commit: sent.commit }), source: sent.source };
  }

  /**
   * Everything wrong with a sent store request, and, when nothing is
   * wrong, the request as the store takes it. Every field is checked;
   * none of them stops the rest from being checked too.
   */
  function protocolProblem(body: unknown): Handled | undefined {
    const value = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).protocol
      : undefined;
    if (value === 1) return undefined;
    if (value === undefined) {
      return refused(400, { field: 'protocol', message: '"protocol" is required: the protocol version the request uses' });
    }
    return refused(400, {
      field: 'protocol',
      accepted: PROTOCOL_ACCEPTED,
      message: `"protocol" ${JSON.stringify(value)} is not supported: accepted protocol versions are ${PROTOCOL_ACCEPTED}`,
    });
  }

  function parseStoreRequest(body: unknown): { sent?: SentStore; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming source, commit, committedAt and model' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'protocol' && key !== 'source' && key !== 'commit' && key !== 'committedAt' && key !== 'model') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are protocol, source, commit, committedAt, model` });
      }
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: `"source" is required: the name of the source the model belongs to, like "github.com/acme/shop"` });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    let commit: string | undefined;
    if (!('commit' in body) || body.commit === undefined) {
      problems.push({ field: 'commit', message: `"commit" is required: the id of the commit the model was read at` });
    } else if (typeof body.commit !== 'string' || body.commit.length === 0) {
      problems.push({ field: 'commit', message: `"commit" must be a non-empty string naming the commit the model was read at, but is ${JSON.stringify(body.commit)}` });
    } else {
      commit = body.commit;
    }

    let committedAtMs: number | undefined;
    if (!('committedAt' in body) || body.committedAt === undefined) {
      problems.push({ field: 'committedAt', message: `"committedAt" is required: the time the commit was made`, accepted: ISO_ACCEPTED });
    } else if (typeof body.committedAt !== 'string') {
      problems.push({
        field: 'committedAt',
        message: `"committedAt" must be a string holding an ISO 8601 time with an offset, but is ${JSON.stringify(body.committedAt)}`,
        accepted: ISO_ACCEPTED,
      });
    } else {
      const ms = parseIsoWithOffset(body.committedAt);
      if (ms === undefined) {
        problems.push({ field: 'committedAt', message: `"committedAt" ${JSON.stringify(body.committedAt)} is not an ISO 8601 time with an offset`, accepted: ISO_ACCEPTED });
      } else {
        committedAtMs = ms;
      }
    }

    let model: CompiledModel | undefined;
    if (!('model' in body) || body.model === undefined) {
      problems.push({ field: 'model', message: `"model" is required: the compiled model to store` });
    } else {
      const candidate: unknown = body.model;
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        // The value itself is model content: the refusal names the field
        // and the JSON type the field arrived as, never the value.
        const type = candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate;
        problems.push({ field: 'model', message: `"model" must be the compiled model as a JSON object, but is of type ${type}` });
      } else if (!Value.Check(CompiledModelSchema, candidate)) {
        const details = schemaProblems(Value.Errors(CompiledModelSchema, candidate), candidate);
        const detailText = details.map((detail) => (detail.path === '' ? detail.message : `${detail.path}: ${detail.message}`)).join('; ');
        // The log line carries the field paths only: the model's own
        // values stay in the answer to the client, never in the log.
        problems.push({
          field: 'model',
          message: `"model" does not match the compiled model's schema: ${detailText}`,
          logMessage: `"model" does not match the compiled model's schema: ${details.map((detail) => (detail.path === '' ? detail.message : detail.path)).join('; ')}`,
        });
      } else {
        model = candidate;
      }
    }

    if (problems.length > 0 || source === undefined || commit === undefined || committedAtMs === undefined || model === undefined) {
      return { problems };
    }
    return { sent: { source, commit, committedAtMs, model }, problems: [] };
  }

  /**
   * A rename claim: the new name is bound to the id the source already
   * has, the history and its sidecar move to the new name, and the old
   * name is retired — never a source of its own again. A repeat claim of
   * the name the source already holds answers as already answered, and
   * one of its own former names renames it back.
   */
  async function claimRename(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;
    const protocol = protocolProblem(body);
    if (protocol !== undefined) return protocol;
    const { claim, problems } = parseClaimRequest(body);
    if (claim === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    const heads = sources.heads();
    const claimed = heads.find((head) => head.id === claim.id);
    if (claimed === undefined) {
      const held = heads.length === 0
        ? 'the server holds no source yet'
        : `the server holds ${heads.map((head) => `"${head.source}" with id "${head.id}"`).join(', ')}`;
      return {
        ...refused(404, {
          field: 'id',
          message: `no source has the id ${JSON.stringify(claim.id)}: ${held}; GET /sources lists every source with its id`,
        }),
      };
    }
    if (claimed.source === claim.source) {
      await sources.rename(claim.id, claim.source);
      await graphs.remove(claim.source);
      return { response: json(200, { renamed: false, reason: 'already the name', source: claim.source, id: claim.id }), source: claim.source };
    }
    const holder = heads.find((head) => head.source === claim.source);
    if (holder !== undefined) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the claim renames ${JSON.stringify(claimed.source)} (id ${JSON.stringify(claim.id)}) to ${JSON.stringify(claim.source)}, but that name is already the name of the source with id ${JSON.stringify(holder.id)}: a claim names a name no other source holds`,
        }),
        source: claim.source,
      };
    }
    const retiredHolder = sources.retiredHead(claim.source);
    if (retiredHolder !== undefined && retiredHolder.id !== claim.id) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the claim renames ${JSON.stringify(claimed.source)} (id ${JSON.stringify(claim.id)}) to ${JSON.stringify(claim.source)}, but that name was renamed away from the source with id ${JSON.stringify(retiredHolder.id)} to ${JSON.stringify(retiredHolder.source)}: a claim names a name no other source holds`,
        }),
        source: claim.source,
      };
    }

    try {
      await sources.rename(claim.id, claim.source);
    } finally {
      const current = sources.heads().find((head) => head.id === claim.id);
      if (current?.source === claim.source) await graphs.remove(claimed.source);
    }
    return { response: json(200, { renamed: true, source: claim.source, formerSource: claimed.source, id: claim.id }), source: claim.source };
  }

  /**
   * Everything wrong with a rename claim, and, when nothing is wrong,
   * the claim as the rename takes it. Every field is checked; none of
   * them stops the rest from being checked too.
   */
  function parseClaimRequest(body: unknown): { claim?: ClaimedRename; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming id and source' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'protocol' && key !== 'id' && key !== 'source') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are protocol, id, source` });
      }
    }

    let id: string | undefined;
    if (!('id' in body) || body.id === undefined) {
      problems.push({ field: 'id', message: `"id" is required: the id the server assigned the source on its first send` });
    } else if (typeof body.id !== 'string' || body.id.length === 0) {
      problems.push({ field: 'id', message: `"id" must be a non-empty string naming the source's id, but is ${JSON.stringify(body.id)}` });
    } else {
      id = body.id;
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: `"source" is required: the source's new name, like "github.com/acme/shop"` });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    if (problems.length > 0 || id === undefined || source === undefined) {
      return { problems };
    }
    return { claim: { id, source }, problems: [] };
  }

  /**
   * A view request: answered from the source's graph's query engine and
   * the source's compiled model (the history's latest read of it), at the
   * current time and the first state — the engine's own defaults, which
   * reduce to the history's own times, so no clock moment of the server's
   * own leaks into the text. A request that cannot be answered is
   * explained, never answered with an empty diagram.
   */
  async function answerView(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;
    const protocol = protocolProblem(body);
    if (protocol !== undefined) return protocol;
    const { asked, problems } = parseViewRequest(body);
    if (asked === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    const heads = sources.heads();
    if (!heads.some((head) => head.source === asked.source)) {
      const renamedTo = sources.retiredHead(asked.source);
      if (renamedTo !== undefined) {
        return {
          ...refused(404, {
            field: 'source',
            message: `the source ${JSON.stringify(asked.source)} was renamed to ${JSON.stringify(renamedTo.source)} (id ${JSON.stringify(renamedTo.id)}): ask under the new name`,
          }),
          source: asked.source,
        };
      }
      const held = heads.map((head) => head.source);
      const holds = held.length === 0 ? 'the server holds no source yet' : `the server holds ${held.join(', ')}`;
      return {
        ...refused(404, {
          field: 'source',
          message: `no model has been sent for the source ${JSON.stringify(asked.source)}: ${holds}; send one with: ${SEND_COMMAND}`,
        }),
        source: asked.source,
      };
    }

    const read = await sources.historyOf(asked.source).read({ source: asked.source });
    if (read.model === undefined || read.errors.length > 0) {
      const why = read.errors.map((error) => error.message).join('; ');
      // The failure of the server itself is logged at error level with
      // its cause; the answer says what failed without a stack.
      const message = `the model of the source ${JSON.stringify(asked.source)} could not be read from its history: ${why || 'nothing was read'}`;
      errorLog(message);
      return {
        ...refused(500, { message }),
        source: asked.source,
      };
    }
    // A source-filtered read returns that source's own compiled model,
    // byte for byte what its store was given (the history's lossless rule).
    const model = read.model as CompiledModel;
    const engine = await graphs.graphForSource(asked.source).engine();
    const one: OneViewRequest = asked.element === undefined ? { depth: asked.depth } : { element: asked.element, depth: asked.depth };

    if (asked.format === 'mermaid') {
      const rendered = await renderAsyncOneViewMermaid(engine, model, one);
      if (rendered.page === undefined) return { ...renderRefusal(asked, rendered.errors), source: asked.source };
      return { response: new Response(rendered.page, { headers: { 'content-type': 'text/markdown; charset=utf-8' } }), source: asked.source };
    }
    const rendered = await renderAsyncOneViewLikeC4(engine, model, one);
    if (rendered.workspace === undefined) return { ...renderRefusal(asked, rendered.errors), source: asked.source };
    // A relation LikeC4 cannot draw (of an element to itself or its own
    // descendant) is named in one comment line at the top of the answer,
    // before the workspace text, in code point order of relation id, so
    // nothing the model holds is dropped silently and the text still
    // validates on its own; no model content goes to the log.
    const notDrawn = [...(rendered.notDrawn ?? [])].sort((a, b) => byCodePoint(a.relationId, b.relationId));
    const text = notDrawn.length === 0
      ? rendered.workspace
      : `${notDrawn.map((relation) => `// not drawn: ${relation.message}`).join('\n')}\n${rendered.workspace}`;
    return { response: new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }), source: asked.source };
  }

  /**
   * A view the renderer could not render: an element the source's model
   * does not hold now is a 404 naming the element and the source (the
   * explains requirement); every other renderer error is passed on with
   * its messages, never swallowed.
   */
  function renderRefusal(asked: AskedView, errors: OneViewError[]): Handled {
    if (asked.element !== undefined && errors.some((error) => error.query?.id === asked.element)) {
      return refused(404, {
        field: 'element',
        message: `the element ${JSON.stringify(asked.element)} does not exist in the source ${JSON.stringify(asked.source)} now`,
      });
    }
    // A renderer failure that is not the asked element's own (that one
    // is a 404 above) is the server failing: logged at error level.
    const message = errors.map((error) => error.message).join('; ');
    errorLog(message);
    return refused(500, { message });
  }

  /**
   * Everything wrong with a view request, and, when nothing is wrong, the
   * request as the answer takes it. Every field is checked; none of them
   * stops the rest from being checked too.
   */
  function parseViewRequest(body: unknown): { asked?: AskedView; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming source and format, with element and depth beside them when they are wanted' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'protocol' && key !== 'source' && key !== 'element' && key !== 'depth' && key !== 'format') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are protocol, source, element, depth, format` });
      }
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: '"source" is required: the name of the source the view is asked of, like "github.com/acme/shop"' });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    let element: string | undefined;
    if ('element' in body && body.element !== undefined) {
      if (typeof body.element === 'string' && body.element.length > 0) {
        element = body.element;
      } else {
        problems.push({ field: 'element', message: `"element" must be a string naming an element of the source's model, or left out for the landscape, but is ${JSON.stringify(body.element)}` });
      }
    }

    let depth = 1;
    if ('depth' in body && body.depth !== undefined) {
      const value: unknown = body.depth;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        depth = value;
      } else {
        problems.push({
          field: 'depth',
          message: typeof value === 'number' && Number.isInteger(value)
            ? `"depth" ${value} is below 1: the depth is ${DEPTH_ACCEPTED}`
            : `"depth" ${JSON.stringify(value)} is not ${DEPTH_ACCEPTED}`,
          accepted: DEPTH_ACCEPTED,
        });
      }
    }

    let format: AskedView['format'] | undefined;
    if (!('format' in body) || body.format === undefined) {
      problems.push({ field: 'format', message: '"format" is required: the format the view is rendered as', accepted: FORMAT_ACCEPTED });
    } else if (body.format === 'mermaid' || body.format === 'likec4') {
      format = body.format;
    } else {
      problems.push({ field: 'format', message: `"format" ${JSON.stringify(body.format)} is not a format the server renders`, accepted: FORMAT_ACCEPTED });
    }

    if (problems.length > 0 || source === undefined || format === undefined) {
      return { problems };
    }
    return { asked: { source, element, depth, format }, problems: [] };
  }

  function listSources(): Handled {
    const list = sources.heads().map((head) => ({
      source: head.source,
      id: head.id,
      commit: head.commit,
      committedAt: new Date(head.committedAt).toISOString(),
      storedAt: new Date(head.storedAt).toISOString(),
    }));
    return { response: json(200, list) };
  }

  const handle = async (request: Request): Promise<Response> => {
    const started = performance.now();
    const pathname = new URL(request.url).pathname;
    let handled: Handled;
    try {
      const onPath = routes.filter((each) => each.path === pathname);
      if (onPath.length === 0) {
        // Static serving and the SPA fallback answer GET and HEAD only:
        // any other method is a named 405, never an index.html answer.
        const readable = request.method === 'GET' || request.method === 'HEAD';
        const served = readable && (wiki === undefined || !pathname.startsWith('/api/')) ? wiki?.app(pathname) : undefined;
        if (served !== undefined) {
          handled = served;
        } else if (!readable && wiki !== undefined && !pathname.startsWith('/api/')) {
          const message = `"${request.method}" is not answered outside the API paths: static serving and the app's pages take GET and HEAD only`;
          handled = { response: json(405, { error: { message } }, { allow: 'GET, HEAD' }), refusal: message };
        } else {
          const offered = routes.map((each) => `${each.method} ${each.path}`).join(', ');
          // The wiki's reader reads the refusal's message from the body's
          // top level (see `wikiRefused`), so the wiki mode's refusals are
          // built with it too; the model mode's refusals keep their own
          // shape, exactly as they were.
          handled = wiki !== undefined
            ? wikiRefused(404, { message: `no such path "${pathname}": the server offers ${offered}` })
            : refused(404, {
                message: `no such path "${pathname}": the server offers ${offered}`,
              });
        }
      } else {
        const route = onPath.find((each) => each.method === request.method);
        if (route === undefined) {
          const offered = onPath.map((each) => each.method).join(', ');
          handled = refused(405, { message: `"${request.method}" is not offered on "${onPath[0]!.path}": use ${offered}` }, { allow: offered });
        } else {
          handled = await route.handle(request);
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? (error.stack ?? error.message) : String(error);
      errorLog(`the server failed to handle ${request.method} ${pathname}: ${cause}`);
      handled = { response: json(500, { error: { message: 'the request failed inside the server' } }) };
    }
    const ms = Math.max(0, Math.round(performance.now() - started));
    const named = handled.source === undefined ? '' : ` source=${JSON.stringify(handled.source)}`;
    const why = handled.refusal === undefined ? '' : `: ${handled.refusal}`;
    log(`${request.method} ${pathname} ${handled.response.status}${named} ${ms}ms${why}`);
    const headers = new Headers(handled.response.headers);
    headers.set('protocol', String(PROTOCOL_VERSION));
    return new Response(handled.response.body, { status: handled.response.status, statusText: handled.response.statusText, headers });
  };
  return Object.assign(handle, { drain: async () => { await stateTail; } });
}

/** The escape itself: the readable forms for the line breaks and the tab, `\uXXXX` for every other control character. */
function escapeControlCharacters(line: string): string {
  return line.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** The source a request body named, when it named one — even one arriving beside other broken fields. */
function namedSourceOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('source' in body)) return undefined;
  const candidate: unknown = body.source;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * The ISO 8601 times the server accepts, as UTC epoch milliseconds, or
 * `undefined` for anything else: a date, a time without its offset, a
 * month that does not exist. The parts are checked by hand rather than
 * handed to `Date.parse`, which accepts far more than ISO 8601 (and
 * rolls out-of-range parts over silently).
 */
function parseIsoWithOffset(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (match === null) return undefined;
  const year = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  const hour = match[4]!;
  const minute = match[5]!;
  const second = match[6]!;
  const fraction = match[7];
  const offset = match[8]!;
  if (Number(month) < 1 || Number(month) > 12) return undefined;
  if (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return undefined;
    offsetMinutes = (hours * 60 + minutes) * (offset[0] === '-' ? -1 : 1);
  }
  const fractionMs = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), fractionMs) - offsetMinutes * 60_000;
}

/** The number of days in a month, leap years included (`Date.UTC(y, m, 0)` lands on the month's last day). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** One path that does not match the compiled model's schema, named the way the refusals name paths. */
interface SchemaDetail {
  path: string;
  message: string;
}

/**
 * TypeBox's raw errors turned into one clear detail per actual problem —
 * the same reading `src/model/load.ts` does for file errors, kept to the
 * schema's own shapes here: an unknown field named at its own path once
 * (not twice), a missing field named at the field's own path, a literal
 * or a union of literals answered with everything it could have been,
 * and every other complaint kept only where nothing clearer replaces it.
 */
function schemaProblems(
  raw: Iterable<{ keyword: string; instancePath: string; params: Record<string, unknown>; message: string }>,
  root: unknown,
): SchemaDetail[] {
  const byPath = new Map<string, string>();
  const constGroups = new Map<string, unknown[]>();
  const deferred: { path: string; message: string }[] = [];

  for (const error of raw) {
    if (error.keyword === 'const') {
      const group = constGroups.get(error.instancePath);
      if (group === undefined) constGroups.set(error.instancePath, [error.params.allowedValue]);
      else group.push(error.params.allowedValue);
    } else if (error.keyword === 'boolean') {
      continue; // the unknown-field error at the same shape is clearer
    } else if (error.keyword === 'additionalProperties') {
      const names = Array.isArray(error.params.additionalProperties) ? error.params.additionalProperties : [];
      for (const name of names) byPath.set(`${error.instancePath}/${String(name)}`, `unknown field "${String(name)}"`);
    } else if (error.keyword === 'required') {
      const names = Array.isArray(error.params.requiredProperties) ? error.params.requiredProperties : [];
      for (const name of names) byPath.set(`${error.instancePath}/${String(name)}`, `missing required field "${String(name)}"`);
    } else {
      deferred.push({ path: error.instancePath, message: error.message });
    }
  }
  for (const { path, message } of deferred) {
    if (!constGroups.has(path) && !byPath.has(path)) byPath.set(path, message);
  }
  for (const [path, allowed] of constGroups) {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const field = segments[segments.length - 1] ?? path;
    byPath.set(path, `${JSON.stringify(valueAtPointer(root, path))} is not a known "${field}": expected one of ${allowed.map((each) => JSON.stringify(each)).join(', ')}`);
  }
  return [...byPath].map(([path, message]) => ({ path, message })).sort((a, b) => byCodePoint(a.path, b.path));
}

/** Reads the value a JSON pointer names, for saying what was actually there. */
function valueAtPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of pointer.split('/')) {
    if (segment.length === 0) continue;
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escapeHtml(text: string): string { return text.replace(/[&<>"\']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "\'":"&#39;"}[char]!)); }
