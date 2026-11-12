/** A read-only page walk of an already served wiki. No fixture, agent or fill is started.
 * bun run wiki:shots --url http://localhost:4291/products/shop/ --out /tmp/walk
 * --role defaults to everything; this saves the reader's role on the served wiki.
 */
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import puppeteer, { type Page, type HTTPRequest } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { addressOfEntity, addressOfKind, WIKI_HOME, WIKI_CATALOGUE, WIKI_DOCS, WIKI_GLOSSARY, WIKI_QUESTIONS, WIKI_TASKS, WIKI_PROBLEMS, WIKI_FILL, WIKI_SETTINGS } from '../wiki/app/src/knowledge/routes.js';

function argument(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 && fallback !== undefined) return fallback;
  const value = process.argv[at + 1];
  if (at < 0 || !value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}
const base = new URL(argument('url'));
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('--url must be HTTP(S)');
base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
base.search = ''; base.hash = '';
const out = resolve(argument('out'));
const repo = resolve(import.meta.dir, '..');
let ancestor = out;
const suffix: string[] = [];
while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
const inside = relative(realpathSync(repo), join(realpathSync(ancestor), ...suffix));
if (!inside || (!inside.startsWith('..' + '/') && inside !== '..' && !isAbsolute(inside))) throw new Error('--out must be outside the repository');
mkdirSync(out, { recursive: true });
const urlOf = (path: string): string => new URL(path.replace(/^\//, ''), base).href;
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(urlOf(path), init);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
const started = Date.now();
const status = await api('api/status') as { kinds: { kind: string; count: number }[] };
const catalog = await api('api/catalog') as { kinds: { kind: string; count: number; page: boolean }[] };
writeFileSync(join(out, 'status.json'), JSON.stringify(status, null, 2));
writeFileSync(join(out, 'catalog.json'), JSON.stringify(catalog, null, 2));
const role = argument('role', 'everything');
await api('api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
type Visit = { name: string; url: string; view?: 'Table' | 'Graph' };
const visits: Visit[] = [];
function add(name: string, path: string, view?: Visit['view']): void {
  const url = urlOf(path);
  if (!visits.some((visit) => visit.url === url && visit.view === view)) visits.push({ name, url, view });
}
for (const [name, path] of [['home', WIKI_HOME], ['catalogue', WIKI_CATALOGUE], ['docs', WIKI_DOCS], ['glossary', WIKI_GLOSSARY], ['questions', WIKI_QUESTIONS], ['tasks', WIKI_TASKS], ['problems', WIKI_PROBLEMS], ['fill', WIKI_FILL], ['settings', WIKI_SETTINGS]]) add(name!, path!);
// Status includes non-page declarations; only the catalog defines routable kinds.
const kinds = [...new Set(catalog.kinds.filter((kind) => kind.page).map((kind) => kind.kind))].sort();
for (const kind of kinds) add(`kind ${kind}`, addressOfKind(kind));
// Query even zero-count kinds: the catalog can describe declarations rather than live records.
const representatives = new Map<string, string>();
let nextKind = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (nextKind < kinds.length) {
    const kind = kinds[nextKind++]!;
    const listing = await api(`api/entities?kind=${encodeURIComponent(kind)}&limit=1`) as { rows: { id: string }[] };
    if (listing.rows[0]) representatives.set(kind, listing.rows[0].id);
  }
}));
for (const kind of kinds) {
  const id = representatives.get(kind);
  if (id) add(`entity ${kind}`, addressOfEntity(id));
}
// code.file, doc.term and code.commit are included above, with the same entity routes the UI uses.
type Shot = { name: string; url: string; width: number; file: string; tiles: string[]; settleMs: number; errors: string[] };
const shots: Shot[] = [];
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });

/** Ignore streaming event connections; unlike networkidle they never prevent a settled page.
 * Scroll to mount deferred diagrams, then wait for finite requests, loaders and DOM mutations to stop.
 */
async function settle(page: Page, pending: Set<HTTPRequest>): Promise<void> {
  await page.waitForSelector('[data-testid=knowledge-app], .ui-kit-page', { timeout: 20_000 });
  await page.evaluate(() => {
    const state = window as unknown as { walkMutationAt: number; walkObserver?: MutationObserver };
    state.walkObserver?.disconnect(); state.walkMutationAt = Date.now();
    state.walkObserver = new MutationObserver(() => { state.walkMutationAt = Date.now(); });
    state.walkObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const until = Date.now() + 20_000;
  let bottom = 0;
  for (;;) {
    const ready = await page.evaluate((previousBottom) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid=shell-content]') ?? document.scrollingElement!;
      const height = scroller.scrollHeight;
      if (previousBottom < height) scroller.scrollTop = Math.min(previousBottom, height);
      const state = window as unknown as { walkMutationAt: number };
      const loaders = [...document.querySelectorAll('[data-testid=page-loading], [data-diagram=deferred], [data-testid=diagram-loading], [data-testid=mermaid-loading]')];
      return { height, bottom: scroller.scrollTop + scroller.clientHeight,
        quiet: Date.now() - state.walkMutationAt >= 250,
        loading: loaders.some((element) => !element.querySelector('[data-testid=diagram-failure], [data-testid=mermaid-error], [data-testid=likec4-error]')) };
    }, bottom);
    bottom = ready.bottom;
    if (bottom >= ready.height && ready.quiet && !ready.loading && pending.size === 0) break;
    if (Date.now() > until) throw new Error(`settle timeout: ${pending.size} requests; loaders=${ready.loading}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  await page.evaluate(async () => { (document.querySelector<HTMLElement>('[data-testid=shell-content]') ?? document.scrollingElement!).scrollTop = 0; await document.fonts.ready; await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
}

try {
  // Discover optional pages from real navigation, not a SPA's HTTP-200 fallback.
  const probe = await browser.newPage();
  await probe.goto(urlOf('catalogue'), { waitUntil: 'domcontentloaded' });
  await probe.waitForSelector('[data-testid=catalogue-group], [data-testid=catalogue-page]', { timeout: 15_000 }).catch(() => undefined);
  const links = await probe.$$eval('a[href]', (elements) => elements.map((element) => (element as HTMLAnchorElement).href));
  const graph = links.find((url) => new URL(url).pathname.endsWith('/dependencies'));
  if (graph) add('catalogue Graph', graph);
  for (const link of links) if (new URL(link).pathname.replace(/\/$/, '').endsWith('/kit')) add('kit', link);
  const controls = await probe.$$eval('button, [role=tab]', (elements) => elements.map((element) => element.textContent?.trim()));
  if (controls.includes('Table') && controls.includes('Graph')) {
    const index = visits.findIndex((visit) => visit.name === 'catalogue');
    visits[index]!.view = 'Table'; add('catalogue Graph', 'catalogue', 'Graph');
  }
  await probe.close();
  writeFileSync(join(out, 'plan.json'), JSON.stringify({ base: base.href, role, visits }, null, 2));
  const jobs = visits.flatMap((visit, index) => [1400, 390].map((width) => ({ visit, width, index })));
  let next = 0;
  // Isolated contexts avoid the per-origin connection limit consumed by the wiki's SSEs.
  await Promise.all(Array.from({ length: 4 }, async () => {
    const context = await browser.createBrowserContext();
    try {
      while (next < jobs.length) {
        const { visit, width, index } = jobs[next++]!;
        const page = await context.newPage();
        const errors: string[] = [];
        let collecting = true;
        const pending = new Set<HTTPRequest>();
        page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
        page.on('pageerror', (error) => errors.push(`page: ${error instanceof Error ? error.message : String(error)}`));
        page.on('request', (request) => { if (!['eventsource', 'websocket'].includes(request.resourceType())) pending.add(request); });
        page.on('requestfinished', (request) => pending.delete(request));
        page.on('requestfailed', (request) => { pending.delete(request); if (collecting) errors.push(`request: ${request.url()} ${request.failure()?.errorText}`); });
        page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
        await page.setViewport({ width, height: 900 });
        const began = Date.now();
        try {
          await page.goto(visit.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          if (visit.view) {
            await page.waitForFunction((view) => [...document.querySelectorAll('button, [role=tab]')].some((element) => element.textContent?.trim() === view), { timeout: 15_000 }, visit.view);
            const control = await page.evaluateHandle((view) => [...document.querySelectorAll('button, [role=tab]')].find((element) => element.textContent?.trim() === view), visit.view);
            const element = control.asElement();
            if (!element) throw new Error(`missing ${visit.view} control`);
            await (element as import('puppeteer').ElementHandle<Element>).click();
            await control.dispose();
          }
          await settle(page, pending);
          const visibleErrors = await page.$$eval('[data-testid=page-error], [data-testid=block-problem], [data-testid=diagram-failure], [data-testid=mermaid-error], [data-testid=likec4-error]', (elements) => elements.map((element) => element.textContent ?? 'page error'));
          errors.push(...visibleErrors);
        } catch (error) { errors.push(String(error)); }
        // Keep the real renderer error even when readiness timed out.
        if (errors.length) errors.push(...await page.$$eval('[data-testid=page-error], [data-testid=block-problem], [data-testid=diagram-failure], [data-testid=mermaid-error], [data-testid=likec4-error]', (elements) => elements.map((element) => element.textContent ?? 'page error')).catch(() => []));
        const settleMs = Date.now() - began;
        const file = `${String(index + 1).padStart(3, '0')}-${width}.png`;
        const tiles: string[] = [];
        try {
          await page.screenshot({ path: join(out, file), fullPage: true });
          // A fixed shell's content does not appear in Puppeteer's fullPage image.
          // Preserve its normal viewport layout and capture overlapping scroll tiles instead.
          let previous = 0;
          for (;;) {
            const position = await page.evaluate(() => {
              const scroller = document.querySelector<HTMLElement>('[data-testid=shell-content]');
              if (!scroller) return 0;
              scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * .9, scroller.scrollHeight - scroller.clientHeight);
              return scroller.scrollTop;
            });
            if (position <= previous) break;
            previous = position;
            await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const tile = file.replace('.png', `-scroll-${tiles.length + 1}.png`);
            await page.screenshot({ path: join(out, tile), fullPage: true });
            tiles.push(tile);
          }
        } catch (error) { errors.push(`screenshot: ${String(error)}`); }
        shots.push({ name: visit.name, url: visit.url, width, file, tiles, settleMs, errors });
        console.log(`${visit.name} ${width}: ${settleMs}ms, ${errors.length} errors`);
        // Closing deliberately aborts SSE/background requests; those are not visit failures.
        collecting = false;
        await page.close();
      }
    } finally { await context.close(); }
  }));
} finally {
  await browser.close();
  shots.sort((a, b) => a.file.localeCompare(b.file));
  const elapsedMs = Date.now() - started;
  writeFileSync(join(out, 'results.json'), JSON.stringify({ elapsedMs, pages: visits.length, shots, role }, null, 2));
  const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wiki walk</title><style>body{font:16px system-ui;margin:2rem}article{border:2px solid #bbb;padding:1rem;margin:2rem 0}.error{border-color:#c00}.error h2{color:#c00}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Wiki walk</h1><p>${visits.length} pages, ${shots.length} shots; ${(elapsedMs / 1000).toFixed(1)}s. Role: ${escape(role)}. Red borders mark errors.</p>${shots.map((shot) => `<article class="${shot.errors.length ? 'error' : ''}"><h2>${shot.errors.length ? '🔴 ' : ''}${escape(shot.name)} — ${shot.width}px</h2><a href="${escape(shot.url)}">${escape(shot.url)}</a><p>Settle: ${shot.settleMs}ms</p><pre>${escape(shot.errors.join('\n') || 'No errors')}</pre>${[shot.file, ...shot.tiles].map((file) => `<a href="${file}"><img loading="lazy" src="${file}" alt="${escape(shot.name)} at ${shot.width}px — ${file}"></a>`).join('')}</article>`).join('')}</html>`);
  console.log(`${visits.length} pages, ${shots.length} shots in ${elapsedMs}ms → ${out}/index.html`);
}
if (shots.length !== visits.length * 2 || shots.some((shot) => shot.errors.length)) process.exitCode = 1;
