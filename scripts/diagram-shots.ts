/**
 * diagram:shots (madarch-m38l.9): the acceptance walk of the graph diagrams. The built app in wiki/app is served by the
 * engine's own server over a products home holding the generated training repository (filled once), and headless
 * Chromium takes each page that carries a diagram at 1150 px and at phone width, in light and dark. For each picture it
 * prints the sizes of the labels (the font size as rendered, after the diagram's scale) and the overlaps found between
 * labels of one diagram, so the numbers go into the change record beside the pictures.
 *
 * Usage: bun scripts/diagram-shots.ts [--out <folder>] [--work <folder>] [--port <n>] [--binary <compiled madarch>]
 * With --binary the server is the compiled binary (its embedded app), not this checkout.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { DIAGRAM_MEASURES } from './diagram-measures.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const out = resolve(argument('out', 'shots'));
const work = resolve(argument('work', '/tmp/madarch-diagram-shots'));
const port = Number(argument('port', '4293'));
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const repository = generateTrainingRepository(join(work, 'repo'));
const home = join(work, 'home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
let name = 'shop';
let base = `http://127.0.0.1:${port}`;
let stop = async (): Promise<void> => undefined;
const binary = argument('binary', '');
if (binary === '') {
  const shop = makeProduct(home, name, repository);
  writeSamplePages(shop);
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
    env: { ...process.env, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  stop = async () => { child.kill('SIGTERM'); await child.exited; };
} else {
  // The compiled binary makes the product itself, with its own embedded starter set, and serves it with its embedded app.
  const created = spawnSync(resolve(binary), ['new', '--home', home, '--port', String(port), '--json', '--no-open'], { encoding: 'utf8', timeout: 120_000, cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: 'Diagram Shots', GIT_AUTHOR_EMAIL: 'shots@example.invalid', GIT_COMMITTER_NAME: 'Diagram Shots', GIT_COMMITTER_EMAIL: 'shots@example.invalid' } });
  if (created.status !== 0) throw new Error(`the binary could not make the product: ${created.stderr}${created.stdout}`);
  const facts = JSON.parse(created.stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop()!) as { folder: string; url: string };
  name = basename(facts.folder);
  base = new URL(facts.url).origin;
  const manifest = join(facts.folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'training', linked: true }));
  symlinkSync(repository, join(facts.folder, 'repos', 'training'));
  writeSamplePages(facts.folder);
  stop = async () => { spawnSync(resolve(binary), ['stop', '--home', home], { encoding: 'utf8', cwd: work }); };
}
for (let tries = 0; ; tries += 1) {
  try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not listening yet */ }
  if (tries > 120) throw new Error(`the server did not answer on ${base}`);
  await new Promise((rest) => setTimeout(rest, 500));
}

// The first open asks which role the reader reads as, over every page: the walk answers it the way the file does, so
// no picture carries the dialog (the owner's review of 2026-10-24).
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));

const started = await fetch(`${base}/products/${name}/api/k/fill`, { method: 'POST' });
if (!started.ok) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
for (const until = Date.now() + 900_000; ; ) {
  const status = (await (await fetch(`${base}/products/${name}/api/k/status`)).json()) as { fill: { state: string; message?: string } };
  if (status.fill.state === 'done') break;
  if (status.fill.state === 'failed') throw new Error(`the fill failed: ${status.fill.message}`);
  if (Date.now() > until) throw new Error('the fill did not finish in 15 minutes');
  await new Promise((rest) => setTimeout(rest, 3000));
}

// Read every declared page through JSON before taking pictures. Keep every response and every failure, not a sample.
const statusResponse = await fetch(`${base}/products/${name}/api/k/status`);
if (!statusResponse.ok) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')}:116: status HTTP ${statusResponse.status}`);
const wikiStatus = await statusResponse.json() as { kinds: { kind: string }[] };
const apiPages: Record<string, unknown>[] = [];
mkdirSync(join(out, 'pages'), { recursive: true });
for (const kind of [...wikiStatus.kinds].sort((a,b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)) {
  let after: string | null = null;
  do {
    const query = new URLSearchParams({kind:kind.kind,limit:'500', ...(after === null ? {} : {after})});
    const listingResponse = await fetch(`${base}/products/${name}/api/k/entities?${query}`);
    if (!listingResponse.ok) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')}:125: kind ${kind.kind}: HTTP ${listingResponse.status}`);
    const listing = await listingResponse.json() as { rows: { id: string }[]; next: string | null };
    for (const row of listing.rows) for (const lang of ['en','ru']) {
      const response = await fetch(`${base}/products/${name}/api/k/page?${new URLSearchParams({id:row.id,lang,full:'1'})}`);
      const body = await response.json() as { id?: string; blocks?: { type: string }[]; message?: string };
      const file = `${String(apiPages.length).padStart(5,'0')}-${lang}.json`;
      writeFileSync(join(out,'pages',file),JSON.stringify(body,null,2));
      apiPages.push({id:row.id,lang,status:response.status,file:`pages/${file}`,blocks:body.blocks?.map(b=>b.type) ?? [],error:response.ok ? null : body.message ?? body});
      writeFileSync(join(out,'page-walk.json'),JSON.stringify(apiPages,null,2));
    }
    if (listing.next === after && after !== null) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')}:138: kind ${kind.kind}: repeated pagination cursor ${after}`);
    after = listing.next;
  } while (after !== null);
}
console.log(`JSON page walk: ${apiPages.length} observations; ${apiPages.filter(p=>p['status']!==200).length} failures`);

const encode = encodeURIComponent;
const at = (id: string): string => `/products/${name}/k/e/${encode(id)}`;
const key = (kind: string, rest: string): string => `${kind}:${rest}`;
const pages: { name: string; url: string; wait: string }[] = [
  { name: 'home', url: `/products/${name}/k`, wait: '[data-diagram=views] [data-testid=view]' },
  // The domain list: the map of the domains with the services behind them (the owner's first ask).
  { name: 'domain-list', url: `/products/${name}/k/kind/domain`, wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'domain-payment', url: at('domain:payment'), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'route-post-orders', url: at(key('code.route', 'services/orders/internal/api/router.go#POST:/orders')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'route-post-checkout', url: at(key('code.route', 'services/checkout/src/api/routes.ts#POST:/checkout')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'service-payments', url: at('code.service:payments'), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'service-orders', url: at('code.service:orders'), wait: '[data-diagram=treemap] [data-testid=treemap-file]' },
  { name: 'file-order-go', url: at(key('code.file', 'services/orders/internal/domain/order.go')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'function-pay', url: at(key('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'table-orders', url: at(key('code.table', 'orders/public.orders')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'database-orders', url: at(key('code.database', 'orders')), wait: '[data-diagram=views] [data-testid=view]' },
];
const views = [{ tag: '1150-light', width: 1150, scheme: 'light' as const }, { tag: '1150-dark', width: 1150, scheme: 'dark' as const }, { tag: '390-light', width: 390, scheme: 'light' as const }, { tag: '390-dark', width: 390, scheme: 'dark' as const }];

const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
const report: Record<string, unknown> = {};

/** Rendered label sizes and overlaps of the SVG texts of each diagram on the page. */
async function measure(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};
    document.querySelectorAll('[data-diagram]').forEach((diagram, index) => {
      const name = `${diagram.getAttribute('data-diagram')}#${index}`;
      const texts = [...diagram.querySelectorAll('svg text')].filter((node) => (node.textContent ?? '').trim() !== '') as SVGTextElement[];
      const boxes = texts.map((node) => ({ node, rect: node.getBoundingClientRect(), size: parseFloat(getComputedStyle(node).fontSize) * (typeof node.getScreenCTM === 'function' ? node.getScreenCTM()?.a ?? 1 : 1) }));
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!.rect; const b = boxes[j]!.rect;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1.5 && h > 1.5) overlaps.push(`${boxes[i]!.node.textContent} / ${boxes[j]!.node.textContent}`);
      }
      const frame = diagram.querySelector('svg')?.getBoundingClientRect();
      const clipped = frame === undefined ? [] : boxes.filter((box) => box.rect.width > 0 && (box.rect.right > frame.right + 1 && !diagram.querySelector('.dg-scroll'))).map((box) => box.node.textContent ?? '');
      result[name] = { texts: boxes.length, minFontPx: Math.round(Math.min(...boxes.map((box) => box.size)) * 10) / 10, overlaps: overlaps.slice(0, 8), clipped: clipped.slice(0, 5) };
    });
    return result;
  });
}

/**
 * Walks every views block of a page: each view tab, each renderer tab under it, and — for every one of them — the page's
 * own viewport as a reader sees it, plus the diagram in full screen. The tabs are re-read on every step (a step replaces
 * the block's state), and a renderer the tab does not offer is never asked for.
 */
async function walkViews(page: Page, entry: { name: string }, tag: string, lang: string): Promise<void> {
  const blocks = await page.evaluate(() => document.querySelectorAll('[data-diagram=views]').length);
  for (let blockAt = 0; blockAt < blocks; blockAt += 1) {
    const viewTabs = await page.evaluate((at) => [...document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid=view-tab]')].map((node) => (node.textContent ?? '').trim()), blockAt);
    const steps = Math.max(1, viewTabs.length);
    for (let viewAt = 0; viewAt < steps; viewAt += 1) {
      await page.evaluate(([at, step]) => {
        const block = document.querySelectorAll('[data-diagram=views]')[at];
        const tab = block?.querySelectorAll('[data-testid=view-tab]')[step];
        if (tab instanceof HTMLElement) tab.click();
      }, [blockAt, viewAt]);
      await new Promise((rest) => setTimeout(rest, 400));
      const type = await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view]')?.getAttribute('data-view') ?? 'view', blockAt);
      const renderers = await page.evaluate((at) => [...document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid^=renderer-]')].map((node) => node.getAttribute('data-testid')!.slice('renderer-'.length)), blockAt);
      for (const renderer of renderers) {
        await page.evaluate(([at, name]) => {
          const block = document.querySelectorAll('[data-diagram=views]')[at];
          const tab = block?.querySelector(`[data-testid=renderer-${name}]`);
          if (tab instanceof HTMLElement) tab.click();
        }, [blockAt, renderer]);
        let drawn = true;
        const rendererErrors: string[] = [];
        try {
          // Each renderer is waited for where it really appears: Mermaid draws in the page, LikeC4 draws its laid-out
          // model in the page, and the archify tab frames the page the server rendered.
          if (renderer === 'mermaid') await page.waitForFunction((at) => Boolean(document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view-picture] svg')), { timeout: 60_000 }, blockAt);
          else if (renderer === 'likec4') await page.waitForFunction((at) => {
            const frame = document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view-frame-likec4]');
            if (!frame) return false;
            const hasNode = (root) => {
              if (root.querySelector('.react-flow__node, [data-node-id]')) return true;
              return [...root.querySelectorAll('*')].some((node) => node.shadowRoot !== null && hasNode(node.shadowRoot));
            };
            return hasNode(frame) || frame.querySelector('[role=alert]') !== null;
          }, { timeout: 60_000 }, blockAt);
          else await page.waitForFunction((at) => {
            const block = document.querySelectorAll('[data-diagram=views]')[at];
            const frame = block?.querySelector<HTMLIFrameElement>('iframe[data-renderer=archify]');
            return Boolean(frame?.contentDocument?.querySelector('svg, [data-frame-error]')
              || block?.querySelector('[data-testid=renderer-fallback]'));
          }, { timeout: 60_000 }, blockAt);
          // A frame that answered with an error page is not a drawing: the walk says so instead of counting it.
          if (renderer === 'archify') {
            const blocks = await page.$$('[data-diagram=views]');
            const handle = await blocks[blockAt]?.$('iframe[data-renderer=archify]');
            const frame = await handle?.contentFrame();
            if (frame !== null && frame !== undefined) {
              const failed = await frame.evaluate(() => document.querySelector('[data-frame-error]') !== null).catch(() => false);
              if (failed) { drawn = false; rendererErrors.push('archify answered [data-frame-error]'); }
            }
          }
        } catch (error) { drawn = false; rendererErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
        await new Promise((rest) => setTimeout(rest, 900));
        const label = `${entry.name}-${type}-${renderer}-${tag}-${lang}`;
        // The picture is the reader's own column, not a crop of the block.
        await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.scrollIntoView({ block: 'center' }), blockAt);
        await new Promise((rest) => setTimeout(rest, 200));
        const measures = await measureBlock(page, blockAt, renderer);
        await page.screenshot({ path: join(out, `${label}.png`) });
        const selected = await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view]')?.getAttribute('data-renderer'), blockAt);
        if (selected !== renderer) { drawn = false; rendererErrors.push(`requested ${renderer}, selected ${String(selected)}`); }
        if (renderer === 'archify' && (measures?.['texts'] === undefined || measures?.['texts'] === 0)) drawn = false;
        // Full screen: the same diagram over the whole window, which is how a dense view is read.
        let full = false;
        let fullscreenError = '';
        let fullMeasures: Record<string, unknown> | undefined;
        try {
          await page.evaluate((at) => {
            const block = document.querySelectorAll('[data-diagram=views]')[at];
            const button = block?.querySelector('[data-testid=fullscreen-button]');
            if (button instanceof HTMLElement) button.click();
          }, blockAt);
          await page.waitForFunction((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=fullscreenable]')?.getAttribute('data-fullscreen') === 'true', { timeout: 10_000 }, blockAt);
          await new Promise((rest) => setTimeout(rest, 700));
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          full = true;
        } catch (error) { full = false; fullscreenError = error instanceof Error ? error.stack ?? error.message : String(error); }
        if (full) {
          fullMeasures = await measureBlock(page, blockAt, renderer);
          await page.screenshot({ path: join(out, `${label}-full.png`) });
          await page.keyboard.press('Escape');
          await new Promise((rest) => setTimeout(rest, 300));
        }
        // Captions and edge labels are diagnostics, not the review's title-size acceptance floor.
        const valid = (value: Record<string, unknown> | undefined): boolean => value?.['measurementStatus'] === 'measured' && Number(value['totalTitles']) > 0 && typeof value['smallestTitlePx'] === 'number' && Number.isFinite(value['smallestTitlePx']) && value['smallestTitlePx'] > 0 && typeof value['wholeFit'] === 'boolean' && typeof value['scale'] === 'number' && Number.isFinite(value['scale']) && value['scale'] > 0;
        report[label] = { drawn: drawn && valid(measures), rendererErrors, full, measurementValid: valid(measures), ...(measures ?? {}), fullMeasurementValid: full && valid(fullMeasures), fullMeasures: fullMeasures ?? { measurementStatus: 'error', measurementError: `${resolve(import.meta.dir, 'diagram-shots.ts')}:215: ${label}: full-screen observation unavailable: ${fullscreenError}`, wholeFit: null, scale: null, smallestTitlePx: null, titlesVisibleInFull: null, clippedTitles: null, totalTitles: null } };
      }
    }
  }
}

/** The actual browser geometry of one block, including titles outside its viewport. */
async function measureBlock(page: Page, blockAt: number, renderer: string): Promise<Record<string, unknown>> {
  try {
    const options = JSON.stringify({ blockAt, renderer });
    if (renderer !== 'archify') return await page.evaluate(`(${DIAGRAM_MEASURES})(${options})`) as Record<string, unknown>;
    const blocks = await page.$$('[data-diagram=views]');
    const handle = await blocks[blockAt]?.$('iframe[data-renderer=archify]');
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) throw new Error('the block-scoped archify iframe has no document');
    await frame.waitForSelector('.diagram-container svg', { timeout: 10_000 });
    const parentViewport = await handle!.evaluate((node) => {
      const r = node.getBoundingClientRect();
      let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let at = node.parentElement; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at), box = at.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      const frame = node as HTMLIFrameElement;
      const sx = r.width / frame.offsetWidth, sy = r.height / frame.offsetHeight;
      const x = r.left + frame.clientLeft * sx, y = r.top + frame.clientTop * sy;
      return { left: (left - x) / sx, top: (top - y) / sy, right: (right - x) / sx, bottom: (bottom - y) / sy };
    });
    return await frame.evaluate(`(${DIAGRAM_MEASURES})(${JSON.stringify({ blockAt, renderer, parentViewport })})`) as Record<string, unknown>;
  } catch (error) {
    return { measurementStatus: 'error', measurementError: `${resolve(import.meta.dir, 'diagram-measures.ts')}:1: [data-diagram=views] block ${blockAt}, renderer ${renderer}: ${error instanceof Error ? error.stack ?? error.message : String(error)}; observation caller: ${new Error().stack}`, texts: 0, minFontPx: null, wholeFit: null, scale: null, smallestTitlePx: null, titlesVisibleInFull: null, clippedTitles: null, totalTitles: null };
  }
}

for (const lang of ['en', 'ru'] as const) {
  for (const view of views) {
    for (const entry of pages) {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument((language) => { try { localStorage.setItem('madarch-wiki-language', language); } catch { /* storage off */ } }, lang);
      await page.setViewport({ width: view.width, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: view.scheme }]);
      page.on('pageerror', (error) => console.error(`page error at ${entry.url} ${lang}: ${error.message}`));
      await page.goto(`${base}${entry.url}`, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForSelector(entry.wait, { timeout: 90_000 });
      } catch (error) {
        console.error(`${entry.name} ${view.tag} ${lang}: ${entry.wait} never appeared: ${(error as Error).message}`);
      }
      await new Promise((rest) => setTimeout(rest, 800));
      // The page picture is the whole page in the reader's own column: the viewport is the width asked for, and the
      // capture takes its height, so the column never changes from one picture to the next.
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('main, [data-testid=entity-page]')].map((element) => element.scrollHeight)));
      await page.setViewport({ width: view.width, height: Math.min(9000, Math.max(900, height)) });
      await new Promise((rest) => setTimeout(rest, 800));
      await page.screenshot({ path: join(out, `${entry.name}-${view.tag}-${lang}.png`) });
      report[`${entry.name}-${view.tag}-${lang}`] = await measure(page);
      // The diagrams are walked in a plain viewport again: a window as tall as the page would stretch every frame.
      await page.setViewport({ width: view.width, height: 900 });
      await new Promise((rest) => setTimeout(rest, 500));
      await walkViews(page, entry, view.tag, lang);
      await page.close();
    }
  }
}
writeFileSync(join(out, 'measures.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
await browser.close();
await stop();
