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
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { agentScript } from '../test/knowledge-agent-script.js';
import { LOOP_QUESTIONS, firstRunScript } from '../test/loop-agent-script.js';
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
// A remote, so a code place can name its page on the host.
if (!execFileSync('git', ['remote'], { cwd: repository, encoding: 'utf8' }).includes('origin')) execFileSync('git', ['remote', 'add', 'origin', ['https://github.com', 'example', 'shop.git'].join('/')], { cwd: repository });
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
rmSync(join(home, 'fresh'), { recursive: true, force: true });
makeProduct(home, 'fresh', repository);
const shop = existsSync(join(home, 'shop')) ? join(home, 'shop') : makeProduct(home, 'shop', repository);
writeSamplePages(shop);

// Named like the pages the scripted agent writes: a page's id is its product's name.
rmSync(join(home, 'training-shop'), { recursive: true, force: true });
makeProduct(home, 'training-shop', repository);
// The agent of the agent stage is the fake ACP agent behind an adapter executable found by its name on the PATH, the way a
// real adapter is found. Its units take their time (the product page, then ordering, then payments), so a picture can
// show a unit in progress; no model runs.
const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(work, 'agent-script.json'), JSON.stringify(agentScript({ product: 6_000, ordering: 60_000, payments: 1_500 })));
writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dir, '..', 'test', 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts'))} --scenario script --script ${JSON.stringify(join(work, 'agent-script.json'))}\n`);
chmodSync(join(bin, 'claude-agent-acp'), 0o755);

// The server is a process of its own, the products home's background server (`madarch daemon-serve`): a fill keeps its
// process busy between commits, and a walk that served in its own process would stop answering the browser with it.
const port = Number(argument('port', '4291'));
const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') },
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

/**
 * What a reader sees, measured as the picture is taken: the visible text of the state, the badge or card that state is
 * about (its words and where it sits) and whether the page overflows its width. The picture is for the owner's eyes; these
 * numbers say what it holds, so a state that is empty, cut off or overflowing is told even when nobody looks.
 */
async function measured(page: Page, name: string): Promise<Record<string, unknown>> {
  return await page.evaluate((shot) => {
    const box = (element: Element | null): { words: string; top: number; left: number; width: number; height: number } | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { words: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const one = (selector: string): Element | null => document.querySelector(selector);
    const visible = (element: Element | null): boolean => {
      if (element === null) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
    };
    return {
      shot,
      text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
      title: document.title,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: { window: window.innerHeight, document: document.documentElement.scrollHeight },
      badge: box(one('[data-testid=planned-badge]')),
      badgeVisible: visible(one('[data-testid=planned-badge]')),
      card: box(one('[data-testid=task-card]')),
      proposal: box(one('[data-testid=task-proposed]')),
      rows: document.querySelectorAll('[data-testid=task-row]').length,
      impactPages: document.querySelectorAll('[data-testid=impact-page]').length,
      impactStatements: document.querySelectorAll('[data-testid=impact-statements] [data-testid=impact-statement]').length,
      scopeItems: document.querySelectorAll('[data-testid=task-scope-item]').length,
      fixtureKeys: (document.body.innerText.match(/loop\.[a-zA-Z.]+/g) ?? []).slice(0, 5),
      proposalTitle: (document.querySelector('[data-testid=task-title]') as HTMLInputElement | null)?.value ?? null,
      storedLanguage: (() => { try { return window.localStorage.getItem('madarch-wiki-language'); } catch { return 'unreadable'; } })(),
    };
  }, name);
}

async function shoot(page: Page, name: string, settle?: () => Promise<unknown>): Promise<void> {
  if (settle !== undefined) await settle();
  await new Promise((rest) => setTimeout(rest, 400));
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  written.push(file);
  console.log(`MEASURED ${JSON.stringify(await measured(page, name))}`);
}

async function open(url: string, width: number, height: number, scheme: 'light' | 'dark' = 'light', language: string = lang): Promise<Page> {
  const page = await browser.newPage();
  // The interface speaks the language of the walk (the wiki reads its choice from this storage key).
  await page.evaluateOnNewDocument((chosen) => { try { window.localStorage.setItem('madarch-wiki-language', chosen); } catch { /* the walk goes on in the browser's own language */ } }, language);
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
const lang = argument('lang', 'en');

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

// ---- the agent stage: the choice, a unit in progress, the home page after the write ----------
if (only === '' || only === 'agent') {
  const page = await open('/products/training-shop/', 1440, 1300);
  await waited(page, 'the agent choice', () => page.waitForSelector('[data-testid=agent-claude-code]', { timeout: 60_000 }));
  await page.click('[data-testid=agent-claude-code] input');
  await shoot(page, '30-agent-choice');
  await page.click('[data-testid=fill-start]');
  await waited(page, 'the domain unit writing', () => page.waitForSelector('[data-testid=writer-unit][data-unit="domain:ordering"][data-state=writing]', { timeout: 1_500_000 }));
  await page.goto(`${server.url}/products/training-shop/k`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the home page while a unit writes', () => page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 }));
  await page.waitForSelector('[data-testid=writer-unit][data-state=writing]', { timeout: 60_000 });
  await shoot(page, '31-unit-in-progress');
  await waited(page, 'the pages written', () => page.waitForSelector('[data-testid=writer-card][data-state=done]', { timeout: 300_000 }));
  await shoot(page, '32-home-after-write');
  await page.goto(`${server.url}/products/training-shop/k/e/${encodeURIComponent('domain:payments')}`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the payments domain page', () => page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 }));
  await shoot(page, '33-domain-payments');
  await page.close();
}

// ---- the filled product ---------------------------------------------------------------------
if (only === '' || only === 'shop' || only === 'remarks' || only === 'entities') {
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

// ---- the owner's remarks of the walk on 0.2.0 (madarch-m38l.4): one walk in the language of --lang -------------------
if (only === 'remarks') {
  const product = '/products/training-shop';
  const api = (path: string): string => `${server.url}${product}${path}`;
  const timed = async (path: string): Promise<number> => {
    const started = performance.now();
    const response = await fetch(api(path));
    await response.text();
    return Math.round(performance.now() - started);
  };
  // Start from an empty product: the same "start over" the wiki offers.
  await fetch(api('/api/k/reset'), { method: 'POST' });
  // Remark 1: the root opens a product's wiki; no list of products stands in front of it.
  {
    const page = await open('/', 1440, 900);
    await waited(page, 'the root opening a product', () => page.waitForSelector('[data-testid=knowledge-app]', { timeout: 60_000 }));
    console.log(`the root opened ${new URL(page.url()).pathname}`);
    await shoot(page, `${lang}-r1-root-opens-a-product`);
    await page.close();
  }
  // Remarks 2 and 5: the agents offered (five with "no agent", OpenCode, omp), and the language of the pages on the card.
  const page = await open(`${product}/`, 1440, 1500);
  await waited(page, 'the agent choice', () => page.waitForSelector('[data-testid=agent-claude-code]', { timeout: 60_000 }));
  await page.click('[data-testid=agent-claude-code] input');
  await page.waitForSelector('[data-testid=content-language]');
  await shoot(page, `${lang}-r2-r5-agent-choice-and-language`);
  await page.click('[data-testid=fill-start]');
  // Remark 3: pages answer while the fill runs: every page is read in the browser and by the clock.
  await waited(page, 'the fill running', () => page.waitForFunction(() => { const bar = document.querySelector('[data-testid=fill-card] [role=progressbar]'); return Number(bar?.getAttribute('aria-valuenow') ?? 0) >= 10; }, { timeout: 600_000, polling: 1000 }));
  const samples: number[] = [];
  for (let round = 0; round < 12; round += 1) {
    for (const path of ['/api/k/status', '/api/k/entities?kind=code.file&limit=100', '/api/k/entities?kind=code.symbol&limit=100', `/api/k/page?id=${encodeURIComponent(PAY)}`]) samples.push(await timed(path));
    await new Promise((rest) => setTimeout(rest, 150));
  }
  console.log(`${lang}: ${samples.length} answers during the fill, slowest ${Math.max(...samples)} ms, median ${[...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]} ms`);
  const filling = await open(`${product}/k/kind/code.file`, 1440, 900);
  const loadStarted = performance.now();
  await waited(filling, 'the Files list during the fill', () => filling.waitForSelector('[data-testid=kind-page] table tbody tr', { timeout: 30_000 }));
  console.log(`${lang}: the Files list showed rows ${Math.round(performance.now() - loadStarted)} ms after the page opened`);
  await shoot(filling, `${lang}-r3-files-during-the-fill`);
  await filling.close();
  // The agent writes the pages; the card goes when it is done, and the outcome is a quiet status in the top bar (remark 7).
  await waited(page, 'the pages written', () => page.waitForFunction(() => document.querySelector('[data-testid=fill-chip]')?.textContent?.match(/\d/) !== null && document.querySelector('[data-testid=writer-card]') === null && document.querySelector('[data-testid=fill-card]') === null, { timeout: 1_500_000, polling: 2000 }));
  await page.goto(`${server.url}${product}/`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the home page after the write', () => page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 }));
  await shoot(page, `${lang}-r7-done-no-card`);
  await page.click('[data-testid=fill-chip]');
  await page.waitForSelector('[data-testid=fill-menu]');
  await shoot(page, `${lang}-r8-refresh-menu`);
  await page.keyboard.press('Escape');
  // Remark 4: the documents are pages of the wiki, and a document ground opens its page at its section.
  await page.goto(`${server.url}${product}/k/docs`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the documents', () => page.waitForSelector('[data-testid=documents-group]', { timeout: 60_000 }));
  await shoot(page, `${lang}-r4-documents`);
  await page.goto(`${server.url}${product}/k/e/${encodeURIComponent('domain:ordering')}`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the ordering domain page', () => page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 }));
  const ground = await page.$('a[href*="/k/doc?"]');
  if (ground === null) throw new Error('the ordering page holds no ground that opens a document');
  await ground.click();
  await waited(page, 'the document at its section', () => page.waitForSelector('[data-testid=document-page] .anchor-hit', { timeout: 30_000 }));
  await shoot(page, `${lang}-r4-ground-opens-its-section`);
  // Remark 6: a tall window uses all of its height.
  await page.setViewport({ width: 1400, height: 2000 });
  await page.goto(`${server.url}${product}/k/kind/code.symbol`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the symbols', () => page.waitForSelector('[data-testid=kind-page] table tbody tr', { timeout: 60_000 }));
  await shoot(page, `${lang}-r6-tall-window`);
  await page.setViewport({ width: 1440, height: 900 });
  // Remark 9: the code is colored, light and dark.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto(`${server.url}${product}/k/src?repo=training&path=services%2Fpayments%2Fsrc%2Fdomain%2Fpayment-service.ts&line=46`, { waitUntil: 'domcontentloaded' });
    await waited(page, 'the colored source', () => page.waitForSelector('[data-testid=source-code][data-colored=true]', { timeout: 60_000 }));
    await shoot(page, `${lang}-r9-source-${scheme}`);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  // Remark 10: while a page loads, the skeleton of a page stands where it will be.
  await page.setRequestInterception(true);
  page.on('request', (request) => { if (request.url().includes('/api/k/page')) setTimeout(() => request.continue().catch(() => undefined), 4_000); else request.continue().catch(() => undefined); });
  await page.goto(`${server.url}${product}/k/e/${encodeURIComponent('domain:payments')}`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the skeleton', () => page.waitForSelector('[data-testid=page-loading]', { timeout: 30_000 }));
  await shoot(page, `${lang}-r10-skeleton`);
  await page.close();
  // Remark 11: the problems box says in plain words what it means and who puts it right.
  {
    const found = await open('/products/shop/k/e/domain%3Apayment', 1440, 1500);
    await waited(found, 'the findings box', () => found.waitForSelector('[data-testid=findings]', { timeout: 60_000 }));
    await found.evaluate(() => document.querySelector('[data-testid=findings]')?.scrollIntoView({ block: 'center' }));
    await shoot(found, `${lang}-r11-findings`);
    await found.close();
  }
  // Remark 12 (moved by madarch-m38l.11 from the product menu to the settings page): the settings say what goes and what stays before anything is removed.
  {
    const menu = await open(`${product}/k/settings`, 1440, 900);
    await waited(menu, 'the danger block', () => menu.waitForSelector('[data-testid=danger-fresh-open]', { timeout: 60_000 }));
    await menu.click('[data-testid=danger-fresh-open]');
    await waited(menu, 'the confirmation', () => menu.waitForSelector('[data-testid=danger-dialog] [data-testid=danger-pages]', { timeout: 30_000 }));
    await new Promise((rest) => setTimeout(rest, 500));
    await shoot(menu, `${lang}-r12-start-over-asks`);
    await menu.click('[data-testid=danger-confirm]');
    await waited(menu, 'the fresh fill after starting from scratch', () => menu.waitForSelector('[data-testid=fill-card]', { timeout: 60_000 }));
    await shoot(menu, `${lang}-r12-after-starting-over`);
    await menu.close();
  }
}

// ---- the entity pages (madarch-m38l.6): the catalogue, the navigation by group, a page of each family of kinds, the tabs and the statement view --
if (only === 'entities') {
  const shop = '/products/shop';
  // The index of the pages is published after the code is read: wait until the wiki counts the statements.
  let counted = { kinds: [] as { kind: string; statements?: number }[] };
  for (let tries = 0; tries < 60; tries += 1) {
    counted = (await (await fetch(`${server.url}${shop}/api/k/status`)).json()) as typeof counted;
    if (counted.kinds.some((kind) => kind.statements !== undefined)) break;
    await new Promise((rest) => setTimeout(rest, 2000));
  }
  console.log(`index statements: ${JSON.stringify(counted.kinds.filter((kind) => kind.statements !== undefined).map((kind) => [kind.kind, kind.statements]))}`);
  const firstOf = async (kind: string, match?: string): Promise<string> => {
    const response = await fetch(`${server.url}${shop}/api/k/entities?kind=${encode(kind)}&limit=100${match === undefined ? '' : `&q=${encode(match)}`}`);
    const listing = (await response.json()) as { rows?: { id: string }[]; message?: string };
    const row = listing.rows?.[0];
    if (row === undefined) throw new Error(`the product holds no entity of kind ${kind}${match === undefined ? '' : ` matching ${match}`}: ${listing.message ?? 'the list is empty'}`);
    return row.id;
  };
  const wiki = (id: string): string => `${shop}/k/e/${encode(id)}`;
  const ready = (page: Page) => page.waitForSelector('[data-testid=entity-page] h1', { timeout: 60_000 });
  const family: { name: string; id: string; height?: number }[] = [
    { name: 'uc-2', id: 'doc:@training/docs/requirements.md#uc-2' },
    { name: 'br-1', id: 'doc:@training/docs/requirements.md#br-1' },
    { name: 'adr-0002', id: 'doc:@training/docs/adr/0002-outbox.md#adr-0002' },
    { name: 'term-outbox', id: await firstOf('doc.term', 'Outbox') },
    { name: 'module', id: recordKey('code.module', 'services/payments/src/domain'), height: 1300 },
    { name: 'route', id: await firstOf('code.route', 'orders') },
    { name: 'operation', id: await firstOf('code.operation', 'export') },
    { name: 'channel', id: await firstOf('code.channel') },
    { name: 'database', id: await firstOf('code.database', 'orders'), height: 1400 },
    { name: 'table', id: recordKey('code.table', 'orders/public.orders'), height: 1500 },
    { name: 'migration', id: await firstOf('code.migration') },
    { name: 'env-var', id: await firstOf('code.env-var', 'DATABASE_URL') },
    { name: 'dependency', id: await firstOf('code.dependency', 'express') },
    { name: 'dockerfile', id: await firstOf('code.dockerfile') },
    { name: 'compose-service', id: await firstOf('code.compose-service') },
    { name: 'k8s-deployment', id: await firstOf('code.k8s-deployment') },
    { name: 'ci-job', id: await firstOf('code.ci-job') },
    { name: 'make-target', id: await firstOf('code.make-target') },
    { name: 'test-case', id: await firstOf('code.test-case') },
    { name: 'commit', id: await firstOf('code.commit') },
  ];
  {
    const page = await open(`${shop}/k/catalogue`, 1440, 1500);
    await waited(page, 'the catalogue', () => page.waitForSelector('[data-testid=catalogue-group]', { timeout: 60_000 }));
    // Every group of the navigation is opened so the shot shows each group with its count.
    for (const group of await page.$$('[data-testid=nav-group][aria-expanded=false]')) await group.click();
    await shoot(page, `${lang}-e01-catalogue`);
    await page.close();
  }
  for (const [index, entry] of family.entries()) {
    const page = await open(wiki(entry.id), 1440, entry.height ?? 1100);
    await waited(page, `the ${entry.name} page`, () => ready(page));
    await shoot(page, `${lang}-e${String(index + 2).padStart(2, '0')}-${entry.name}`);
    await page.close();
  }
  {
    const page = await open(`${shop}/k/kind/doc.use-case`, 1440, 900);
    await waited(page, 'the use cases', () => page.waitForSelector('[data-testid=kind-page] table tbody tr', { timeout: 60_000 }));
    await shoot(page, `${lang}-e30-use-cases`);
    await page.close();
  }
  // The tabs and the statement view: pages opened as tabs, a sentence opening its statement in a new tab, the grounds switch.
  {
    const page = await open(wiki('domain:payment'), 1440, 1500);
    await waited(page, 'the domain page', () => ready(page));
    await shoot(page, `${lang}-e31-agent-page-plain`);
    await page.click('[data-testid=grounds-switch] input');
    await page.waitForSelector('section[data-footnotes]', { timeout: 30_000 });
    await shoot(page, `${lang}-e32-agent-page-with-grounds`);
    await page.click('[data-testid=grounds-switch] input');
    await page.waitForFunction(() => document.querySelector('section[data-footnotes]') === null);
    // A control click opens a link in a new tab; a click on a sentence opens its statement.
    const link = await page.$('a[href*="/k/e/"]');
    if (link === null) throw new Error('the domain page holds no link to an entity');
    await page.keyboard.down('Control');
    await link.click();
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=tab]').length >= 2, { timeout: 30_000 });
    // Back to the first tab (the domain page), where the sentences are.
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid=tab] [role=tab]')!.click());
    await page.waitForSelector('[data-testid=statement][data-grounded=true]', { timeout: 30_000 });
    await page.click('[data-testid=statement][data-grounded=true]');
    await waited(page, 'the statement tab', () => page.waitForSelector('[data-testid=statement-page] [data-testid=ground]', { timeout: 60_000 }));
    await shoot(page, `${lang}-e33-statement-tab`);
    await page.evaluate(() => document.querySelector('[data-testid=statement-correction]')?.scrollIntoView({ block: 'center' }));
    await shoot(page, `${lang}-e34-statement-correction-place`);
    await page.close();
  }
  {
    const page = await open(wiki('domain:payment'), 1440, 1500);
    await waited(page, 'the domain page', () => ready(page));
    await page.click('[data-testid=statement][data-grounded=false]');
    await waited(page, 'the ungrounded statement', () => page.waitForSelector('[data-testid=statement-no-grounds]', { timeout: 60_000 }));
    await shoot(page, `${lang}-e35-statement-without-ground`);
    await page.close();
  }
  {
    const page = await open(wiki('doc:@training/docs/requirements.md#uc-2'), 390, 1900);
    await waited(page, 'the use case on a phone', () => ready(page));
    await shoot(page, `${lang}-e36-uc-2-phone`);
    await page.close();
  }
  {
    const page = await open(`${shop}/k/docs`, 1440, 900);
    await waited(page, 'the documents', () => page.waitForSelector('[data-testid=documents-group]', { timeout: 60_000 }));
    await shoot(page, `${lang}-e37-documents`);
    await page.close();
  }
}


// ---- the scoped tasks of answers (madarch-m38l.14) -------------------------------------------
// The acceptance walk of a task: an answer that says the code is right and the document is out of date proposes a task
// scoped to the two README sections the question names, with its impact computed through the graph; confirming it marks
// exactly those sections and the statements that stand on them; «Поправить страницы сейчас» lists the pages it rewrites;
// and the «Задачи» page lists the task. Every state is shot in both languages, both schemes and both widths.
if (only === '' || only === 'tasks') {
  const product = '/products/training-shop';
  const api = (path: string, body?: unknown): Promise<Response> => fetch(`${server.url}${product}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const retention = LOOP_QUESTIONS.find((question) => question.item === 'contradiction.retention')!;
  const ANSWER = 'The code is right: orders that were not shipped are removed ninety days after they were placed, and the two READMEs still say they are kept.';
  // A product of its own, filled once with the scripted agent: the run asks its questions before it writes the pages.
  const questions = join(home, 'training-shop', 'docs', 'questions');
  if (!existsSync(questions)) {
    rmSync(join(home, 'training-shop'), { recursive: true, force: true });
    makeProduct(home, 'training-shop', repository);
    writeFileSync(join(work, 'agent-script.json'), JSON.stringify(firstRunScript()));
    const status = await api('/api/k/agent', { agent: 'claude-code', install: false });
    if (!status.ok) throw new Error(`the agent could not be chosen: ${status.status} ${await status.text()}`);
    const started = await api('/api/k/fill', { agent: 'claude-code' });
    if (started.status !== 202) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
    for (let tries = 0; ; tries += 1) {
      const state = (await (await api('/api/k/status')).json()) as { fill: { state: string }; writer: { state: string } };
      if (state.fill.state !== 'running' && state.writer.state !== 'running' && state.writer.state !== 'waiting') {
        if (state.fill.state !== 'done') throw new Error(`the fill ended as ${state.fill.state}`);
        break;
      }
      if (tries > 1_800) throw new Error('the fill of the training repository never ended');
      await new Promise((rest) => setTimeout(rest, 2_000));
    }
  }
  // The question the walk answers, by the title the agent gave it: its id is the agent's own slug, not the title's.
  const listing = (await (await api('/api/k/questions')).json()) as { rows: { slug: string; title: string }[] };
  const found = listing.rows.find((row) => row.title === retention.text.en.title);
  if (found === undefined) throw new Error(`the questions of the training repository hold none titled ${JSON.stringify(retention.text.en.title)}: the fill did not ask it, so there is no answer to give`);
  const slug = found.slug;
  // The answer is committed as the person reading: the product repository's git identity is that person's.
  execFileSync('git', ['-C', join(home, 'training-shop'), 'config', 'user.name', 'Ada Reader']);
  execFileSync('git', ['-C', join(home, 'training-shop'), 'config', 'user.email', 'ada@example.test']);
  // The walk confirms a task and cannot un-confirm it: a second run against the same work folder would show no proposal.
  const tasksFolder = join(home, 'training-shop', 'docs', 'tasks');
  if (existsSync(tasksFolder) && readdirSync(tasksFolder).length > 0) throw new Error(`${tasksFolder} already holds ${readdirSync(tasksFolder).length} task file(s): the walk starts from a product with no task, so run it with a new --work folder`);
  // The answer is a file of the product, committed as the reader: written once, and read by every walk below.
  const answered = await api('/api/k/answer', { question: slug, text: ANSWER });
  if (!answered.ok) throw new Error(`the answer to ${slug} could not be saved: ${answered.status} ${await answered.text()}`);
  const saved = (await (await api(`/api/k/question?id=${encodeURIComponent(slug)}`)).json()) as { state: string };
  if (saved.state === 'open') throw new Error(`the answer to ${slug} was saved but the question still reads open`);

  // Every language, scheme and width; `--task-combos` names a few of them as `<lang>-<scheme>-<width>`, comma separated.
  const all: { lang: 'en' | 'ru'; scheme: 'light' | 'dark'; width: number }[] = [];
  for (const language of ['en', 'ru'] as const) {
    for (const scheme of ['light', 'dark'] as const) for (const width of [1150, 390]) all.push({ lang: language, scheme, width });
  }
  const onlyCombos = argument('task-combos', '').split(',').map((one) => one.trim()).filter((one) => one !== '');
  const combos = onlyCombos.length === 0 ? all : all.filter((combo) => onlyCombos.includes(`${combo.lang}-${combo.scheme}-${combo.width}`));
  const tag = (combo: { lang: string; scheme: string; width: number }): string => `${combo.lang}-${combo.scheme}-${combo.width}`;
  const question = `${product}/k/questions/${encodeURIComponent(slug)}`;

  // Before the task is confirmed, in every language, scheme and width: the saved answer, the choice «Прав код, документ
  // устарел», the filled proposal and the pages and statements it reaches.
  const propose = async (combo: { lang: string; scheme: 'light' | 'dark'; width: number }, shot: boolean): Promise<Page> => {
    const page = await open(question, combo.width, combo.width === 390 ? 1600 : 1500, combo.scheme, combo.lang);
    // A machine the walk never used asks which role it reads as: the card is answered once, and the page is read again.
    await page.waitForFunction(() => document.querySelector('[data-testid=task-choice-code]') !== null || document.querySelector('[data-testid=role-skip]') !== null, { timeout: 120_000 });
    if ((await page.$('[data-testid=role-skip]')) !== null) {
      await page.click('[data-testid=role-skip]');
      await page.waitForFunction(() => document.querySelector('[data-testid=role-card]') === null, { timeout: 30_000 });
      await page.goto(`${server.url}${question}`, { waitUntil: 'domcontentloaded' });
    }
    await waited(page, `the task choice (${tag(combo)})`, () => page.waitForSelector('[data-testid=task-choice-code]', { timeout: 120_000 }));
    await page.click('[data-testid=task-choice-code]');
    await page.click('[data-testid=task-propose]');
    await waited(page, `the proposed task (${tag(combo)})`, () => page.waitForSelector('[data-testid=task-impact-list]', { timeout: 60_000 }));
    if (shot) {
      await page.evaluate(() => document.querySelector('[data-testid=task-proposed]')?.scrollIntoView({ block: 'start' }));
      await shoot(page, `${tag(combo)}-k01-answer-proposes-a-task`);
    }
    return page;
  };
  for (const combo of combos) {
    const page = await propose(combo, true);
    await page.close();
  }
  // The one press that writes the task is the reader's, made once, as the acceptance walk makes it.
  {
    const page = await propose(combos[0]!, false);
    await page.click('[data-testid=task-confirm]');
    await waited(page, 'the confirmed task', () => page.waitForSelector('[data-testid=task-card] [data-testid=task-fix-now]', { timeout: 60_000 }));
    await page.close();
  }

  // After the confirmation: the badges on the two sections and on the statements that stand on them, and the fixes.
  for (const combo of combos) {
    const language = combo.lang;
    const at = async (path: string, what: string, ready: string, height: number): Promise<Page> => {
      const page = await open(path, combo.width, height, combo.scheme, language);
      await page.waitForFunction(() => document.querySelector('[data-testid=role-skip]') !== null || document.body.innerText.length > 0, { timeout: 60_000 });
      if ((await page.$('[data-testid=role-skip]')) !== null) {
        await page.click('[data-testid=role-skip]');
        await page.waitForFunction(() => document.querySelector('[data-testid=role-card]') === null, { timeout: 30_000 });
        await page.goto(`${server.url}${path}`, { waitUntil: 'domcontentloaded' });
      }
      await waited(page, `${what} (${tag(combo)})`, () => page.waitForSelector(ready, { timeout: 120_000 }));
      return page;
    };
    const readme = await at(`${product}/k/doc?repo=training&path=${encodeURIComponent('README.md')}#what-it-does`, 'the README section badge', '[data-testid=planned-badge]', combo.width === 390 ? 1500 : 1300);
    await readme.evaluate(() => document.querySelector('[data-testid=planned-badge]')?.scrollIntoView({ block: 'center' }));
    await shoot(readme, `${tag(combo)}-k02-badge-on-the-readme-section`);
    await readme.close();
    const ordering = await at(`${product}/k/e/${encodeURIComponent('domain:ordering')}`, 'the dependent statement badge', '[data-testid=statement][data-planned]', combo.width === 390 ? 1900 : 1600);
    await ordering.evaluate(() => document.querySelector('[data-testid=statement][data-planned]')?.scrollIntoView({ block: 'center' }));
    await shoot(ordering, `${tag(combo)}-k03-badge-on-the-dependent-statement`);
    await ordering.close();
    const fixing = await at(question, 'the task card with its pages', '[data-testid=task-card] [data-testid=task-fix-now]', combo.width === 390 ? 2000 : 1700);
    await fixing.evaluate(() => document.querySelector('[data-testid=task-card]')?.scrollIntoView({ block: 'start' }));
    await shoot(fixing, `${tag(combo)}-k04-fix-the-pages-now`);
    await fixing.close();
    const tasks = await at(`${product}/k/tasks`, 'the tasks page', '[data-testid=task-row]', combo.width === 390 ? 1400 : 1000);
    await shoot(tasks, `${tag(combo)}-k05-tasks`);
    await tasks.close();
  }
  console.log(`the scoped-task walk wrote ${written.length} pictures into ${out}`);
}

await browser.close();
await server.stop();
console.log(written.join('\n'));
