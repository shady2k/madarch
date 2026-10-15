/// <reference lib="dom" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { startServer, type StartedServer } from '../src/index.js';

/**
 * Reader acceptance for dead wiki chrome against the built app and real server.
 * Run with MADARCH_WIKI_E2E=1 after building wiki/app. The screenshot destination
 * is outside the checkout so it cannot enter the change commit.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SCREENSHOT = process.env.MADARCH_WIKI_SCREENSHOT ?? '/tmp/madarch-gj94-reader.png';
const PAGE_PATH = '/p/docs/vision.md';
const PAGE_TITLE = 'Reader vision';
const LANGUAGE = process.env.MADARCH_WIKI_LANGUAGE === 'ru' ? 'ru' : 'en';
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;

function buildFieldnote(): { root: string; product: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-gj94-e2e-'));
  const product = join(root, 'Fieldnote');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 1e5c4d90-9f3a-4c7e-b2d1-0a4f6e2b1d33',
    'name: Fieldnote',
    '',
  ].join('\n'));
  writeFileSync(join(product, 'README.md'), '# Fieldnote\n\nA reader fixture.\n');
  writeFileSync(join(product, 'docs', 'vision.md'), `# ${PAGE_TITLE}\n\nA page with one clear heading.\n`);
  return { root, product };
}

function chromiumExecutable(): string {
  const configured = process.env.CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`CHROME does not name an existing browser: ${configured}`);
    return configured;
  }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  const store = '/nix/store';
  if (existsSync(store)) {
    const candidates = readdirSync(store).filter((name) => name.includes('chromium')).sort();
    const executable = candidates.map((name) => join(store, name, 'chrome-linux64', 'chrome')).find(existsSync);
    if (executable !== undefined) return executable;
  }
  throw new Error('No Chromium executable found; set CHROME to a headless Chromium path.');
}

runDescribe('wiki reader chrome (built app and Chromium)', () => {
  let fixture: { root: string; product: string } | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    fixture = buildFieldnote();
    server = await startServer({
      productFolder: fixture.product,
      appFolder: APP,
      port: 0,
      host: '127.0.0.1',
      log: () => {},
      errorLog: (line) => console.error(line),
    });
    browser = await puppeteer.launch({
      executablePath: chromiumExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }, 30000);

  beforeEach(async () => {
    page = await browser!.newPage();
    await page.setViewport({ width: 1150, height: 900 });
    await page.evaluateOnNewDocument((language) => {
      localStorage.setItem('madarch-wiki-language', language);
    }, LANGUAGE);
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      try {
        await server?.stop();
      } finally {
        if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test('a reader sees one document title and no dead tab, card disclosure, or status strip', async () => {
    await page.goto(`${server!.url}${PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      ({ expectedPath, expectedTitle }) => location.pathname === expectedPath
        && document.querySelector('main h1')?.textContent?.trim() === expectedTitle,
      { timeout: 15000 },
      { expectedPath: PAGE_PATH, expectedTitle: PAGE_TITLE },
    );

    expect(await page.$eval('main h1', (heading) => heading.textContent?.trim())).toBe(PAGE_TITLE);
    expect(await page.$('.document-bar, [data-testid="document-tab"]')).toBeNull();
    expect(await page.$('footer.statusbar, [data-testid="connection-status"]')).toBeNull();
    const toolbarText = await page.$eval('.shell-toolbar', (toolbar) => toolbar.textContent ?? '');
    expect(toolbarText).not.toContain(PAGE_TITLE);
    expect(await page.$eval('.shell-breadcrumb', (breadcrumb) => breadcrumb.textContent?.trim())).toBe(LANGUAGE === 'ru' ? 'Продукт / Продукт' : 'Product / Product');

    const productBlock = await page.$('[data-testid="product-block"]');
    expect(productBlock).not.toBeNull();
    expect(await productBlock!.$eval('b', (name) => name.textContent?.trim())).toBe('Fieldnote');
    expect(await productBlock!.$('button, a, [aria-haspopup], [aria-expanded], svg')).toBeNull();
    expect(await productBlock!.evaluate((block) => block.textContent ?? '')).not.toMatch(/[▼▽∨]/u);

    await mkdirSync(join(SCREENSHOT, '..'), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    console.log(`Reader screenshot: ${SCREENSHOT}`);
  }, 30000);
});
