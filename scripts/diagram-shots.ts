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

const started = await fetch(`${base}/products/${name}/api/k/fill`, { method: 'POST' });
if (!started.ok) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
for (const until = Date.now() + 900_000; ; ) {
  const status = (await (await fetch(`${base}/products/${name}/api/k/status`)).json()) as { fill: { state: string; message?: string } };
  if (status.fill.state === 'done') break;
  if (status.fill.state === 'failed') throw new Error(`the fill failed: ${status.fill.message}`);
  if (Date.now() > until) throw new Error('the fill did not finish in 15 minutes');
  await new Promise((rest) => setTimeout(rest, 3000));
}

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
      const boxes = texts.map((node) => ({ node, rect: node.getBoundingClientRect(), size: parseFloat(getComputedStyle(node).fontSize) * (node.getScreenCTM()?.a ?? 1) }));
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

/** Label sizes and overlaps of everything a renderer drew inside a root (the page, or a frame), through shadow roots. */
const MEASURE_LABELS = `(() => {
  const found = [];
  const walk = (root) => {
    root.querySelectorAll('*').forEach((node) => {
      if (node.shadowRoot) walk(node.shadowRoot);
      const own = [...node.childNodes].filter((child) => child.nodeType === 3 && (child.textContent || '').trim() !== '').map((child) => child.textContent.trim()).join(' ');
      if (own === '') return;
      if (node.closest && node.closest('button, script, style, [data-testid=view-legend]')) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return;
      const scale = node instanceof SVGElement ? (node.getScreenCTM() ? node.getScreenCTM().a : 1) : (node.offsetHeight > 0 ? rect.height / node.offsetHeight : 1);
      found.push({ text: own, rect, size: parseFloat(style.fontSize) * scale });
    });
  };
  walk(document);
  const overlaps = [];
  for (let i = 0; i < found.length; i += 1) for (let j = i + 1; j < found.length; j += 1) {
    const a = found[i].rect; const b = found[j].rect;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 1.5 && h > 1.5) overlaps.push(found[i].text + ' / ' + found[j].text);
  }
  return { texts: found.length, minFontPx: found.length === 0 ? null : Math.round(Math.min(...found.map((entry) => entry.size)) * 10) / 10, overlaps: overlaps.slice(0, 8), overlapCount: overlaps.length };
})()`;

/** Walks every views block of a page: each view tab under each renderer tab, a picture and its measures. */
async function walkViews(page: Page, entry: { name: string }, tag: string): Promise<void> {
  const blocks = await page.$$('[data-diagram=views]');
  for (let blockAt = 0; blockAt < blocks.length; blockAt += 1) {
    const views = await blocks[blockAt]!.$$('[data-testid=view-tab]');
    const viewCount = Math.max(1, views.length);
    for (let viewAt = 0; viewAt < viewCount; viewAt += 1) {
      const block = (await page.$$('[data-diagram=views]'))[blockAt]!;
      if (views.length > 0) { await (await block.$$('[data-testid=view-tab]'))[viewAt]!.click(); await new Promise((rest) => setTimeout(rest, 400)); }
      const type = await block.$eval('[data-testid=view]', (node) => node.getAttribute('data-view'));
      const renderers = await block.$$eval('[data-testid^=renderer-]', (nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('renderer-'.length)));
      for (const renderer of renderers) {
        await block.$eval(`[data-testid=renderer-${renderer}]`, (node) => (node as HTMLElement).click());
        let drawn = true;
        try {
          // The Mermaid tab draws in the page itself, the LikeC4 tab draws its laid-out model in the page, and the
          // archify tab is the server's page in a frame: each one is waited for where it really appears.
          if (renderer === 'mermaid') await block.waitForSelector('[data-testid=view-picture] svg', { timeout: 60_000 });
          else if (renderer === 'likec4') await block.waitForSelector('[data-testid=view-frame-likec4] .react-flow__node, [data-testid=view-frame-likec4] .likec4-element-node, [data-testid=view-frame-likec4] [data-node-id]', { timeout: 60_000 });
          else await block.waitForSelector(`iframe[data-renderer=${renderer}]`, { timeout: 30_000 });
        } catch { drawn = false; }
        await new Promise((rest) => setTimeout(rest, renderer === 'mermaid' ? 600 : 9000));
        const label = `${entry.name}-${type}-${renderer}-${tag}`;
        await block.screenshot({ path: join(out, `${label}.png`) });
        const measures: Record<string, unknown>[] = [];
        if (renderer === 'mermaid') measures.push((await page.evaluate(`(() => { const root = document.querySelectorAll('[data-diagram=views]')[${blockAt}].querySelector('[data-testid=view-picture]'); const texts = [...root.querySelectorAll('svg text, svg foreignObject *')].filter((n) => (n.textContent||'').trim() !== '' && n.children.length === 0); const boxes = texts.map((n) => ({ t: n.textContent.trim(), r: n.getBoundingClientRect(), s: parseFloat(getComputedStyle(n).fontSize) * (n.getScreenCTM() ? n.getScreenCTM().a : 1) })).filter((b) => b.r.width > 0); const over = []; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i].r, b = boxes[j].r; const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (w > 1.5 && h > 1.5) over.push(boxes[i].t + ' / ' + boxes[j].t); } return { texts: boxes.length, minFontPx: boxes.length ? Math.round(Math.min(...boxes.map((b) => b.s)) * 10) / 10 : null, overlaps: over.slice(0, 8), overlapCount: over.length }; })()`)) as Record<string, unknown>);
        else if (renderer === 'likec4') {
          // LikeC4 draws into the page's own tree, so its labels are read inside the block that holds it.
          const inBlock = MEASURE_LABELS.replace('walk(document);', `walk(document.querySelectorAll('[data-diagram=views]')[${blockAt}]);`);
          measures.push((await page.evaluate(inBlock)) as Record<string, unknown>);
        } else {
          const handle = await block.$(`iframe[data-renderer=${renderer}]`);
          const frame = await handle?.contentFrame();
          if (frame !== null && frame !== undefined) measures.push((await frame.evaluate(MEASURE_LABELS)) as Record<string, unknown>);
        }
        report[label] = { drawn, ...(measures[0] ?? {}) };
      }
    }
  }
}

for (const view of views) {
  for (const entry of pages) {
    const page = await browser.newPage();
    await page.setViewport({ width: view.width, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: view.scheme }]);
    page.on('pageerror', (error) => console.error(`page error at ${entry.url}: ${error.message}`));
    await page.goto(`${base}${entry.url}`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(entry.wait, { timeout: 90_000 });
    } catch (error) {
      console.error(`${entry.name} ${view.tag}: ${entry.wait} never appeared: ${(error as Error).message}`);
    }
    await new Promise((rest) => setTimeout(rest, 800));
    // The viewport takes the page's whole height, so the pictures hold what a reader scrolls through and no diagram is
    // measured again while the capture resizes the window.
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('main, [data-testid=entity-page]')].map((element) => element.scrollHeight)));
    await page.setViewport({ width: view.width, height: Math.min(9000, Math.max(900, height)) });
    await new Promise((rest) => setTimeout(rest, 800));
    await page.screenshot({ path: join(out, `${entry.name}-${view.tag}.png`) });
    report[`${entry.name}-${view.tag}`] = await measure(page);
    await walkViews(page, entry, view.tag);
    await page.close();
  }
}
writeFileSync(join(out, 'measures.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
await browser.close();
await stop();
