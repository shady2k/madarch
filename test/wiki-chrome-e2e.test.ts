/// <reference lib="dom" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/index.js';
import { fillStatePaths, type FillRun } from '../src/product/fill-runtime.js';

/**
 * Reader acceptance for dead wiki chrome against the built app and real server.
 * Run with MADARCH_WIKI_E2E=1 after building wiki/app. The screenshot destination
 * is outside the checkout so it cannot enter the change commit.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SCREENSHOT = process.env.MADARCH_WIKI_SCREENSHOT ?? join(tmpdir(), 'madarch-wiki-reader.png');
const PAGE_PATH = '/p/docs/vision.md';
const PAGE_TITLE = 'Reader vision';
const LANGUAGE = process.env.MADARCH_WIKI_LANGUAGE === 'ru' ? 'ru' : 'en';
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki Chromium E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run them.');

function buildFieldnote(): { root: string; product: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reader-e2e-'));
  const product = join(root, 'Fieldnote');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 1e5c4d90-9f3a-4c7e-b2d1-0a4f6e2b1d33',
    'name: Fieldnote',
    'repos:',
    '  - name: sample',
    '    url: https://example.invalid/sample.git',
    '',
  ].join('\n'));
  writeFileSync(join(product, 'README.md'), '# Fieldnote\n\nA reader fixture.\n');
  const repo = join(product, 'repos', 'sample'); mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Sample repository\n\nRepository content.\n');
  writeFileSync(join(repo, 'main.ts'), 'export const sample = true;\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '-A'], ['commit', '--quiet', '-m', 'Fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${result.stderr}`);
  }
  writeFileSync(join(product, 'docs', 'vision.md'), `# ${PAGE_TITLE}\n\nA page with one clear heading.\n`);
  return { root, product };
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
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }, 30000);

  beforeEach(async () => {
    page = await browser!.newPage();
    await page.setViewport({ width: Number(process.env.MADARCH_WIKI_WIDTH ?? 1150), height: Number(process.env.MADARCH_WIKI_HEIGHT ?? 900) });
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

  test('first-fill wizard renders initial and inventory steps', async () => {
    await page.goto(`${server!.url}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="fill-wizard"]');
    await page.screenshot({ path: process.env.MADARCH_WIKI_SCREENSHOT ?? join(tmpdir(), `madarch-fill-wizard-${LANGUAGE}-${process.env.MADARCH_WIKI_WIDTH ?? 1150}.png`), fullPage: true });
    const heading = (): string => document.querySelector('.wizard-step h2')?.textContent ?? '';
    const advance = async (): Promise<void> => { const before=await page.evaluate(heading); await page.evaluate(() => { const next=[...document.querySelectorAll('.wizard-actions button')].find(item => /continue|продолжить/i.test(item.textContent ?? '')); if (!next) throw new Error('Continue button is missing'); (next as HTMLButtonElement).click(); }); await page.waitForFunction((previous:string)=>(document.querySelector('.wizard-step h2')?.textContent??'')!==previous,{timeout:5000},before); };
    const screenshot = async (key: string): Promise<void> => { const envKey=key==='what'?'MADARCH_WIKI_SCREENSHOT':`MADARCH_WIZARD_${key.toUpperCase()}_SCREENSHOT`; await page.screenshot({path:process.env[envKey] ?? join(tmpdir(),`madarch-fill-wizard-${key}-${LANGUAGE}-${process.env.MADARCH_WIKI_WIDTH ?? 1150}.png`),fullPage:true}); };
    await screenshot('what');
    await advance();
    await screenshot('agent');
    await page.waitForFunction(() => document.querySelectorAll('input[name="fill-agent"]').length > 0, { timeout: 15000 });
    const preselected = await page.evaluate(() => document.querySelector('input[name="fill-agent"]:checked'));
    if (preselected) throw new Error('an agent is preselected on first open');
    await page.evaluate(() => { const radio=document.querySelector('input[name="fill-agent"]:not(:disabled)') as HTMLInputElement|null; radio?.click(); });
    await advance();
    await page.evaluate(() => { const run=[...document.querySelectorAll('.wizard-step button')].find(item => /run inventory|инвентаризац/i.test(item.textContent ?? '')); if (!run) throw new Error('Run inventory button is missing'); (run as HTMLButtonElement).click(); });
    await page.waitForFunction(() => document.querySelector('.wizard-estimates') !== null, { timeout: 15000 });
    await screenshot('inventory');
    await advance();
    await screenshot('start');
  }, 30000);

  test('first-run overview cards render at the expected top padding and repository names stay intact', async () => {
    await page.goto(`${server!.url}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="fill-wizard"]');
    // The wizard is the full-width first-run view: the product overview stays
    // out of the way until the fill starts, and returns once a run exists.
    const overviewHidden = await page.evaluate(() => getComputedStyle(document.querySelector('main#home') as HTMLElement).display === 'none');
    expect(overviewHidden).toBe(true);
    const fillPaths = fillStatePaths(fixture!.product);
    mkdirSync(join(fillPaths.root, 'units'), { recursive: true });
    const stoppedRun = { schemaVersion: 1, id: 'e2e-overview', productSnapshot: { repository: 'Fieldnote', defaultBranch: 'main', commit: 'fixture', registryHash: 'fixture' }, agentBranch: 'main', status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies FillRun;
    writeFileSync(fillPaths.run, JSON.stringify(stoppedRun));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('main#home') !== null && getComputedStyle(document.querySelector('main#home') as HTMLElement).display !== 'none', { timeout: 15000 });
    await page.waitForSelector('[data-testid="home-repositories"]');
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('[data-kind="architecture"]') as HTMLElement;
      const heading = card.querySelector('h2') as HTMLElement;
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const before = (() => { heading.style.marginBlockStart = '2em'; return heading.getBoundingClientRect().top - rect.top; })();
      heading.style.marginBlockStart = '';
      const after = heading.getBoundingClientRect().top - rect.top;
      const name = document.querySelector('.home-repository-name') as HTMLElement;
      const row = name.closest('li') as HTMLElement;
      const normal = { nameHeight: name.getBoundingClientRect().height, parts: [...row.querySelectorAll('.home-repository-part')].map((part) => ({ text: part.textContent?.trim(), top: part.getBoundingClientRect().top, left: part.getBoundingClientRect().left })) };
      name.textContent = 'a-very-long-repository-name-that-must-not-overflow-the-row';
      const longName = { nameWidth: name.getBoundingClientRect().width, nameHeight: name.getBoundingClientRect().height, rowScroll: row.scrollWidth, rowClient: row.clientWidth };
      return { before, after, paddingTop: parseFloat(style.paddingTop), headingText: heading.textContent?.trim(), repoName: 'sample', normal, longName, viewportWidth: window.innerWidth };
    });
    console.log(`overview metrics ${JSON.stringify({ width: Number(process.env.MADARCH_WIKI_WIDTH ?? 1150), ...metrics })}`);
    expect(metrics.before).toBeGreaterThan(40);
    expect(metrics.after).toBeCloseTo(metrics.paddingTop + 3, 1);
    expect(metrics.repoName).toBe('sample');
    expect(metrics.normal.nameHeight).toBeLessThanOrEqual(22);
    expect(new Set(metrics.normal.parts.map((part) => part.top)).size).toBe(metrics.viewportWidth <= 500 ? 2 : 1);
    expect(metrics.longName.nameHeight).toBeLessThanOrEqual(metrics.viewportWidth <= 500 ? 60 : 22);
    expect(metrics.longName.nameWidth).toBeLessThan(metrics.longName.rowClient);
    expect(metrics.longName.rowScroll).toBeLessThanOrEqual(metrics.longName.rowClient);
    expect(metrics.headingText).toBe(LANGUAGE === 'ru' ? 'Архитектура' : 'Architecture');
    const overviewScreenshot = `${SCREENSHOT}.overview.png`;
    await mkdirSync(join(overviewScreenshot, '..'), { recursive: true });
    await page.screenshot({ path: overviewScreenshot, fullPage: true });
    console.log(`Overview screenshot: ${overviewScreenshot}`);
  }, 30000);

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
  test('a reader sees the code repository in overview and its README and file tree page', async () => {
    await page.goto(`${server!.url}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="home-repositories"]');
    expect(await page.$eval('[data-testid="home-repositories"]', (el) => el.textContent)).toContain('sample');
    await page.goto(`${server!.url}/r`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-repo="sample"]');
    expect(await page.$eval('[data-repo="sample"]', (el) => el.textContent)).toContain('Sample repository');
    expect(await page.$eval('[data-repo="sample"]', (el) => el.textContent)).toContain('main.ts');
  });
});
