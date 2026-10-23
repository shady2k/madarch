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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
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
mkdirSync(home, { recursive: true });
const shop = makeProduct(home, 'shop', repository);
writeSamplePages(shop);

const binary = argument('binary', '');
const command = binary === '' ? ['bun', resolve(import.meta.dir, 'madarch.ts')] : [resolve(binary)];
const child = Bun.spawn([...command, 'daemon-serve', '--home', home, '--port', String(port)], {
  env: binary === '' ? { ...process.env, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') } : { ...process.env },
  stdout: 'ignore',
  stderr: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
for (let tries = 0; ; tries += 1) {
  try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not listening yet */ }
  if (tries > 120) throw new Error(`the server did not answer on port ${port}`);
  await new Promise((rest) => setTimeout(rest, 500));
}
const stop = async (): Promise<void> => { child.kill('SIGTERM'); await child.exited; };

const started = await fetch(`${base}/products/shop/api/k/fill`, { method: 'POST' });
if (!started.ok) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
for (const until = Date.now() + 900_000; ; ) {
  const status = (await (await fetch(`${base}/products/shop/api/k/status`)).json()) as { fill: { state: string; message?: string } };
  if (status.fill.state === 'done') break;
  if (status.fill.state === 'failed') throw new Error(`the fill failed: ${status.fill.message}`);
  if (Date.now() > until) throw new Error('the fill did not finish in 15 minutes');
  await new Promise((rest) => setTimeout(rest, 3000));
}

const encode = encodeURIComponent;
const at = (id: string): string => `/products/shop/k/e/${encode(id)}`;
const key = (kind: string, rest: string): string => `${kind}:${rest}`;
const pages: { name: string; url: string; wait: string }[] = [
  { name: 'home', url: '/products/shop/k', wait: '[data-diagram=system] [data-testid=system-node]' },
  { name: 'domain-payment', url: at('domain:payment'), wait: '[data-diagram=sequence] [data-testid=chain-step]' },
  { name: 'route-post-orders', url: at(key('code.route', 'services/orders/internal/api/router.go#POST:/orders')), wait: '[data-diagram=sequence] [data-testid=chain-step]' },
  { name: 'route-post-checkout', url: at(key('code.route', 'services/checkout/src/api/routes.ts#POST:/checkout')), wait: '[data-diagram=sequence] [data-testid=chain-step]' },
  { name: 'service-payments', url: at('code.service:payments'), wait: '[data-diagram=modules] [data-testid=module-node]' },
  { name: 'service-orders', url: at('code.service:orders'), wait: '[data-diagram=treemap] [data-testid=treemap-file]' },
  { name: 'function-pay', url: at(key('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'table-orders', url: at(key('code.table', 'orders/public.orders')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'database-orders', url: at(key('code.database', 'orders')), wait: '[data-testid=diagram-links]' },
];
const views = [{ tag: '1150-light', width: 1150, scheme: 'light' as const }, { tag: '1150-dark', width: 1150, scheme: 'dark' as const }, { tag: '390-light', width: 390, scheme: 'light' as const }, { tag: '390-dark', width: 390, scheme: 'dark' as const }];

const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
const report: Record<string, unknown> = {};

/** Rendered label sizes and overlaps of the SVG texts of each diagram on the page. */
async function measure(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const result: Record<string, { texts: number; minFontPx: number; overlaps: string[]; clipped: string[] }> = {};
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
    await page.screenshot({ path: join(out, `${entry.name}-${view.tag}.png`), fullPage: true });
    report[`${entry.name}-${view.tag}`] = await measure(page);
    await page.close();
  }
}
writeFileSync(join(out, 'measures.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
await browser.close();
await stop();
