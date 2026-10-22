/**
 * knowledge:shots — the acceptance walk of the knowledge wiki (decision 0029),
 * rendered the way a reader sees it: the built app in wiki/app served by the
 * engine's own server over a products home holding the generated training
 * repository, driven by headless Chromium.
 *
 * Two products are walked. `fresh` is empty: the walk shows what the first page
 * says, presses "Start the fill" and shows the wiki filling while commits land.
 * `shop` is filled once (its store is kept in the work folder, so the walk is
 * quick the second time) and gets the pages an agent would write; the walk then
 * reads from the home page to the payment domain, the payments service, a file
 * and a function with its callers, the source at a line, the product selector,
 * the dark scheme and a phone width.
 *
 * Usage: bun scripts/knowledge-shots.ts [--out <folder>] [--work <folder>]
 * The pictures are written to --out (shots/ by default) and listed on standard output.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { FACTORY, PAY, PAYMENTS_SERVICE, generateTrainingRepository, makeProduct, recordKey, writeSamplePages } from '../test/knowledge-fixture.js';
import { existsSync } from 'node:fs';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const out = resolve(argument('out', 'shots'));
const work = resolve(argument('work', '/tmp/madarch-knowledge-shots'));
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];

const repository = generateTrainingRepository(join(work, 'repo'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
rmSync(join(home, 'fresh'), { recursive: true, force: true });
makeProduct(home, 'fresh', repository);
const shop = existsSync(join(home, 'shop')) ? join(home, 'shop') : makeProduct(home, 'shop', repository);
writeSamplePages(shop);

// The server is a process of its own, the products home's background server (`madarch daemon-serve`): a fill keeps its
// process busy between commits, and a walk that served in its own process would stop answering the browser with it.
const port = Number(argument('port', '4291'));
const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
  env: { ...process.env, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') },
  stdout: 'ignore',
  stderr: 'inherit',
});
const server = {
  url: `http://127.0.0.1:${port}`,
  async stop(): Promise<void> {
    child.kill('SIGTERM');
    await child.exited;
  },
};
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`${server.url}/`)).ok) break;
  } catch {
    // not listening yet
  }
  if (tries > 120) throw new Error(`the background server did not answer on port ${port}`);
  await new Promise((rest) => setTimeout(rest, 500));
}
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });

async function shoot(page: Page, name: string, settle?: () => Promise<unknown>): Promise<void> {
  if (settle !== undefined) await settle();
  await new Promise((rest) => setTimeout(rest, 400));
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  written.push(file);
}

async function open(url: string, width: number, height: number, scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  if (process.argv.includes('--trace')) {
    const started = Date.now();
    const at = (): string => `${Math.round((Date.now() - started) / 100) / 10}s`;
    page.on('request', (request) => { if (request.url().includes('/api/')) console.error(`${at()} -> ${request.method()} ${request.url().replace(server.url, '')}`); });
    page.on('requestfinished', (request) => { if (request.url().includes('/api/')) console.error(`${at()} <- ${request.url().replace(server.url, '')}`); });
    page.on('requestfailed', (request) => console.error(`${at()} xx ${request.url().replace(server.url, '')} ${request.failure()?.errorText}`));
    await page.evaluateOnNewDocument(() => {
      const Original = window.EventSource;
      window.EventSource = class extends Original {
        constructor(address: string | URL, init?: EventSourceInit) {
          super(address, init);
          console.log(`SSE open ${String(address)}`);
          this.addEventListener('change', (event) => console.log(`SSE change ${(event as MessageEvent<string>).data}`));
          this.addEventListener('error', () => console.log('SSE error'));
        }
      } as typeof EventSource;
    });
    page.on('console', (message) => console.error(`${at()} console ${message.type()}: ${message.text().slice(0, 200)}`));
  }
  await page.goto(`${server.url}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const diagrams = (count: number) => async (page: Page): Promise<void> => {
  await page.waitForFunction((wanted) => document.querySelectorAll('[data-testid=mermaid-diagram] svg').length >= wanted, { timeout: 60_000, polling: 500 }, count);
};

const only = argument('only', '');

/** Waits for a state of a page; a wait that fails says what the page and the server said, and keeps a picture. */
async function waited(page: Page, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
    const status = await fetch(`${server.url}${new URL(page.url()).pathname.replace(/\/k.*$/, '')}/api/k/status`).then((response) => response.text()).catch((failure) => String(failure));
    await page.screenshot({ path: join(out, `failed-${what}.png`) }).catch(() => undefined);
    console.error(`${what} did not happen: ${(error as Error).message}\npage: ${body}\nstatus: ${status.slice(0, 1500)}`);
    await browser.close();
    await server.stop();
    process.exit(1);
  }
}

// ---- the empty product, and the fill the reader watches -------------------------------------
if (only === '' || only === 'fresh') {
  const page = await open('/products/fresh/', 1440, 900);
  await waited(page, 'the empty page', () => page.waitForSelector('[data-testid=fill-start]', { timeout: 60_000 }));
  await shoot(page, '01-empty-product');
  await page.click('[data-testid=fill-start]');
  // The card is read every two seconds: a fill that starves the page of its updates shows in the log, not only as a timeout.
  const seen: string[] = [];
  await waited(page, 'the fill running', async () => {
    const until = Date.now() + (process.argv.includes('--trace') ? 40_000 : 240_000);
    for (;;) {
      const state = await page.evaluate(() => {
        const card = document.querySelector('[data-testid=fill-card]');
        const bar = card?.querySelector('[role=progressbar]');
        return { state: card?.getAttribute('data-state') ?? 'none', now: Number(bar?.getAttribute('aria-valuenow') ?? -1), text: card?.textContent?.slice(0, 80) ?? '' };
      });
      seen.push(`${Math.round((Date.now() - until + (process.argv.includes('--trace') ? 40_000 : 240_000)) / 1000)}s ${JSON.stringify(state)}`);
      if (state.state === 'running' && state.now >= 6) return;
      if (Date.now() > until) throw new Error(`the card never showed 6 commits; it showed:\n${seen.slice(-12).join('\n')}`);
      await new Promise((rest) => setTimeout(rest, 2000));
    }
  });
  console.log(`fill card: ${seen.slice(-3).join(' | ')}`);
  await shoot(page, '02-filling');
  await page.goto(`${server.url}/products/fresh/k/kind/code.file`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=kind-page]');
  await shoot(page, '03-filling-files');
  await page.close();
}

// ---- the filled product ---------------------------------------------------------------------
if (only === '' || only === 'shop') {
  const probe = await open('/products/shop/', 1440, 900);
  await probe.waitForSelector('[data-testid=fill-start], [data-testid=entity-page]', { timeout: 60_000 });
  if ((await probe.$('[data-testid=fill-start]')) !== null) {
    await probe.click('[data-testid=fill-start]');
    await probe.waitForFunction(() => document.querySelector('[data-testid=fill-card]') === null, { timeout: 1_500_000, polling: 2000 });
  }
  await probe.close();
}
const encode = encodeURIComponent;
const at = (id: string): string => `/products/shop/k/e/${encode(id)}`;
const pages: { name: string; url: string; width?: number; height?: number; scheme?: 'light' | 'dark'; wait?: (page: Page) => Promise<unknown> }[] = [
  { name: '10-home', url: '/products/shop/k', wait: (page) => page.waitForSelector('[data-testid=entity-page]') },
  { name: '11-domain-payment', url: at('domain:payment'), wait: (page) => page.waitForSelector('[data-testid=ungrounded]') },
  { name: '12-service-payments', url: at(PAYMENTS_SERVICE), width: 1440, height: 1500, wait: diagrams(1) },
  { name: '13-function-pay', url: at(PAY), width: 1440, height: 2200, wait: diagrams(1) },
  { name: '14-function-pay-dark', url: at(PAY), width: 1440, height: 2200, scheme: 'dark', wait: diagrams(1) },
  { name: '15-factory-class', url: at(FACTORY), width: 1440, height: 1500, wait: (page) => page.waitForSelector('[data-testid=entity-page] [data-block=source]') },
  { name: '16-file-factory', url: at(recordKey('code.file', 'services/payments/src/providers/factory.ts')), width: 1440, height: 1500 },
  { name: '17-kind-symbols', url: '/products/shop/k/kind/code.symbol', wait: (page) => page.waitForSelector('[data-testid=kind-total]') },
  { name: '18-source-at-line', url: '/products/shop/k/src?repo=training&path=services%2Fpayments%2Fsrc%2Fdomain%2Fpayment-service.ts&line=46', wait: (page) => page.waitForSelector('.source-line-focus') },
  { name: '19-function-pay-phone', url: at(PAY), width: 390, height: 1800, wait: diagrams(1) },
];
for (const entry of only === '' || only === 'shop' ? pages : []) {
  const page = await open(entry.url, entry.width ?? 1440, entry.height ?? 900, entry.scheme ?? 'light');
  await shoot(page, entry.name, entry.wait === undefined ? undefined : () => entry.wait!(page));
  await page.close();
}
if (only === '' || only === 'shop') {
  const page = await open('/products/shop/k', 1440, 700);
  await page.waitForSelector('[data-testid=product-selector]');
  await page.click('[data-testid=product-selector]');
  await page.waitForSelector('[data-testid=product-choice]');
  await shoot(page, '20-product-selector');
  await page.close();
}

await browser.close();
await server.stop();
console.log(written.join('\n'));
