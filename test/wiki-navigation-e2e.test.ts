/// <reference lib="dom" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { startServer, type StartedServer } from '../src/index.js';

/**
 * Reader navigation against the production-built wiki app and its real server.
 * Run with MADARCH_WIKI_E2E=1; the product is a small factory fixture, not
 * wiki/demo, which later work removes. The fixture gives each link one known
 * route and heading so the browser check verifies both after every click.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = '/tmp/madarch-0n3p-luna/screens';
const VISION = '/p/docs/vision/vision.md';
const NOTE = '/p/docs/notes/N-001-target.md';
const USE_CASE = '/p/docs/use-cases/UC-001-follow-the-reference.md';
const SECOND_NOTE = '/p/docs/notes/N-002-same-group.md';
const NOTE_GROUP_NAME = 'Note group';
const NOTE_GROUP = '/g/' + encodeURIComponent(NOTE_GROUP_NAME);
const VISION_TITLE = 'V-001 — Reader vision';
const NOTE_TITLE = 'N-001 — Linked note';
const USE_CASE_TITLE = 'UC-001 — Follow the reference';
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;

const REGISTRY = [
  'contract: 1',
  'stages:',
  '  - id: idea',
  '    name: Idea',
  '  - id: requirements',
  '    name: Requirements',
  'kinds:',
  '  - name: Product vision',
  '    prefix: V',
  '    folder: docs/vision',
  '    stage: idea',
  '    hint: the purpose a reader starts from',
  '    links:',
  '      - field: References',
  '        targets:',
  '          - Note group',
  '        backlink: Referenced by',
  '  - name: Note group',
  '    prefix: N',
  '    folder: docs/notes',
  '    stage: idea',
  '    hint: a note a reader follows',
  '    links:',
  '      - field: Grew from',
  '        targets:',
  '          - Product vision',
  '          - Use case',
  '        backlink: Grew into',
  '  - name: Use case',
  '    prefix: UC',
  '    folder: docs/use-cases',
  '    stage: requirements',
  '    hint: a route through the reading journey',
  '',
].join('\n');

/** Build the product's manifest, kind declarations and linked pages. */
function buildNavigationProduct(): string {
  const product = mkdtempSync(join(tmpdir(), 'madarch-navigation-e2e-'));
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: 1e5c4d90-9f3a-4c7e-b2d1-0a4f6e2b1d33\nname: Link Map\n');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'docs', 'kinds.yaml'), REGISTRY);
  const documents = [
    {
      path: 'docs/vision/vision.md',
      body: [
        `# ${VISION_TITLE}`,
        '',
        'References: N-001',
        '',
        'Open the [linked note](../notes/N-001-target.md) from this vision.',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/notes/N-001-target.md',
      body: [
        `# ${NOTE_TITLE}`,
        '',
        'Grew from: V-001, UC-001',
        '',
        'A target with outgoing references and an incoming backlink.',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/use-cases/UC-001-follow-the-reference.md',
      body: [`# ${USE_CASE_TITLE}`, '', 'A fixture destination for one footer entry.', ''].join('\n'),
    },
    {
      path: 'docs/notes/N-002-same-group.md',
      body: ['# N-002 — Another note', '', 'A second page in the Note group.', ''].join('\n'),
    },
  ];
  for (const document of documents) {
    const path = join(product, document.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, document.body);
  }
  return product;
}

/** Use the configured Chromium, or a known system/Nix Chromium installation. */
function chromiumExecutable(): string {
  const configured = process.env.CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`CHROME does not name an existing browser: ${configured}`);
    return configured;
  }
  const common = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = common.find(existsSync);
  if (found !== undefined) return found;
  const store = '/nix/store';
  if (existsSync(store)) {
    const candidates = readdirSync(store).filter((name) => name.includes('chromium')).sort();
    const executable = candidates.map((name) => join(store, name, 'chrome-linux64', 'chrome')).find(existsSync);
    if (executable !== undefined) return executable;
  }
  throw new Error('No Chromium executable found; set CHROME to a headless Chromium path.');
}

runDescribe('built wiki navigation (real server and Chromium)', () => {
  let product: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let page: Page;

  function address(): string {
    return new URL(page.url()).pathname;
  }

  /** Wait until the SPA has both committed the target route and rendered its heading. */
  async function waitForPage(path: string, title: string): Promise<void> {
    await page.waitForFunction(
      ({ expectedPath, expectedTitle }) =>
        location.pathname === expectedPath && document.querySelector('main h1')?.textContent?.trim() === expectedTitle,
      { timeout: 15000 },
      { expectedPath: path, expectedTitle: title },
    );
    expect(address()).toBe(path);
    expect(await page.$eval('main h1', (heading) => heading.textContent?.trim())).toBe(title);
  }

  async function openPage(path: string, title: string): Promise<void> {
    await page.goto(`${server!.url}${path}`, { waitUntil: 'domcontentloaded' });
    await waitForPage(path, title);
  }

  /** Hit-test the visible anchor, then send an actual mouse click at its center. */
  async function clickAnchor(selector: string): Promise<void> {
    const hit = await page.$eval(selector, (element) => {
      element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        width: box.width,
        height: box.height,
        receivesClick: top === element || (top !== null && element.contains(top)),
      };
    });
    expect(hit.width).toBeGreaterThan(0);
    expect(hit.height).toBeGreaterThan(0);
    expect(hit.receivesClick).toBe(true);
    const box = await page.$eval(selector, (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  async function capture(name: string): Promise<void> {
    await page.screenshot({ path: join(SHOTS, name), fullPage: true });
  }

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    product = buildNavigationProduct();
    server = startServer({
      productFolder: product,
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
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      try {
        server?.stop();
      } finally {
        if (product !== undefined) rmSync(product, { recursive: true, force: true });
      }
    }
  });

  test('a body page link opens its target route and heading', async () => {
    await openPage(VISION, VISION_TITLE);
    await clickAnchor(`.reading a[href="${NOTE}"]`);
    await waitForPage(NOTE, NOTE_TITLE);
  }, 30000);

  test('the target page backlink opens the source route and heading', async () => {
    await openPage(NOTE, NOTE_TITLE);
    const backlink = `#page [data-testid="doc-links"] section[data-testid="linked-from"] a.doc-links-link[href="${VISION}"]`;
    expect(await page.$(backlink)).not.toBeNull();
    await clickAnchor(backlink);
    await waitForPage(VISION, VISION_TITLE);
    await capture('backlink-to-vision.png');
  }, 30000);

  test('every footer cross-reference entry opens its own expected route and heading', async () => {
    const expected = [
      { region: 'grown-from-grew-from', path: VISION, title: VISION_TITLE, shot: 'footer-01-vision.png' },
      { region: 'grown-from-grew-from', path: USE_CASE, title: USE_CASE_TITLE, shot: 'footer-02-use-case.png' },
      { region: 'linked-from', path: VISION, title: VISION_TITLE, shot: 'footer-03-backlink-vision.png' },
    ];
    await openPage(NOTE, NOTE_TITLE);
    const actual = await page.$$eval(
      '#page [data-testid="doc-links"] section a.doc-links-link[href^="/p/"]',
      (anchors) => anchors.map((anchor) => ({
        region: anchor.closest('section')?.getAttribute('data-testid') ?? '',
        path: anchor.getAttribute('href') ?? '',
      })),
    );
    expect(actual).toEqual(expected.map(({ region, path }) => ({ region, path })));
    for (const entry of expected) {
      await openPage(NOTE, NOTE_TITLE);
      const selector = `#page [data-testid="doc-links"] section[data-testid="${entry.region}"] a.doc-links-link[href="${entry.path}"]`;
      await clickAnchor(selector);
      await waitForPage(entry.path, entry.title);
      await capture(entry.shot);
    }
  }, 90000);

  test('browser Back and Forward follow the body-link history with route and heading', async () => {
    await openPage(VISION, VISION_TITLE);
    await clickAnchor(`.reading a[href="${NOTE}"]`);
    await waitForPage(NOTE, NOTE_TITLE);
    await page.goBack();
    await waitForPage(VISION, VISION_TITLE);
    await page.goForward();
    await waitForPage(NOTE, NOTE_TITLE);
  }, 30000);

  test('the one-click Product overview link opens the home route and heading', async () => {
    await openPage(NOTE, NOTE_TITLE);
    await clickAnchor('[data-testid="nav-overview"]');
    await waitForPage('/', 'Link Map');
  }, 30000);

  test('the logo and breadcrumbs return through Product overview and the group page', async () => {
    await openPage(NOTE, NOTE_TITLE);
    await clickAnchor('[data-testid="nav-brand"]');
    await waitForPage('/', 'Link Map');
    await capture('sidebar-logo-overview.png');

    await clickAnchor(`a[href="${NOTE}"]`);
    await waitForPage(NOTE, NOTE_TITLE);
    await clickAnchor('[data-testid="breadcrumb-product"]');
    await waitForPage('/', 'Link Map');
    await capture('product-breadcrumb-overview.png');

    await clickAnchor(`a[href="${NOTE}"]`);
    await waitForPage(NOTE, NOTE_TITLE);
    await clickAnchor('[data-testid="breadcrumb-group"]');
    await waitForPage(NOTE_GROUP, NOTE_GROUP_NAME);
    const links = await page.$$eval('main a[href^="/p/"]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
    expect(links).toEqual([NOTE, SECOND_NOTE]);
    expect(links).not.toContain(VISION);
    await capture('group-breadcrumb-page.png');

    await clickAnchor(`main a[href="${NOTE}"]`);
    await waitForPage(NOTE, NOTE_TITLE);
    await clickAnchor(`[data-testid="nav-group-${NOTE_GROUP_NAME}"]`);
    await waitForPage(NOTE_GROUP, NOTE_GROUP_NAME);
    await capture('sidebar-group-page.png');
  }, 90000);
});
