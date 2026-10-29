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
 * Reader acceptance for the menu's ground on a long page (madarch-u3vw.6):
 * the grey column beside the text must reach the page's end at 1150 and 1440
 * px, in the light and the dark theme, while the list inside it still stays
 * in view as the reader scrolls. Run with MADARCH_WIKI_E2E=1 after building
 * wiki/app.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki menu-height E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run them.');

/** A product whose one document is long enough that the page runs several windows tall. */
function buildLongPage(): { root: string; product: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-menu-e2e-'));
  const product = join(root, 'Longpage');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5c2f0f4e-6f0b-4a9e-9d3a-2f1f3c4b5a60',
    'name: Longpage',
    'repos:',
    '  - name: sample',
    '    url: https://example.invalid/sample.git',
    '',
  ].join('\n'));
  writeFileSync(join(product, 'README.md'), '# Longpage\n\nA menu fixture.\n');
  const repo = join(product, 'repos', 'sample');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Sample repository\n\nRepository content.\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '-A'], ['commit', '--quiet', '-m', 'Fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${result.stderr}`);
  }
  const paragraphs = Array.from({ length: 160 }, (_unused, at) => `Paragraph ${at + 1} of the long page says enough words to take a line or two at the reading width, so the document runs well past the window.`);
  writeFileSync(join(product, 'docs', 'long.md'), `# A long page\n\n${paragraphs.join('\n\n')}\n`);
  return { root, product, path: '/k/doc?path=docs%2Flong.md' };
}

runDescribe('the menu ground on a long page (built app and Chromium)', () => {
  let fixture: { root: string; product: string; path: string } | undefined;
  let previousHome: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    fixture = buildLongPage();
    // The reader's role lives in madarch's own settings, not in the product: the walk answers it in a home of its
    // own, so the first-run role card does not stand over the page.
    const madarchHome = join(fixture.root, 'madarch-home');
    mkdirSync(madarchHome, { recursive: true });
    writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    previousHome = process.env.MADARCH_HOME;
    process.env.MADARCH_HOME = madarchHome;
    // A product no run has touched opens on the first-fill wizard instead of the shell; a stopped run is
    // what a reader who has been here before has, and the shell then stands.
    const fillPaths = fillStatePaths(fixture.product);
    mkdirSync(join(fillPaths.root, 'units'), { recursive: true });
    writeFileSync(fillPaths.run, JSON.stringify({ schemaVersion: 1, id: 'e2e-menu-height', productSnapshot: { repository: 'Longpage', defaultBranch: 'main', commit: 'fixture', registryHash: 'fixture' }, agentBranch: 'main', status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies FillRun));
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
    await page.evaluateOnNewDocument(() => { localStorage.setItem('madarch-wiki-language', 'en'); });
    // The document is answered late on purpose: the menu stands while the page is still a skeleton, so a
    // measurement that does not wait for the document reads the skeleton's height, not the long page's.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (!request.url().includes('/api/k/document?')) { void request.continue(); return; }
      setTimeout(() => { void request.continue(); }, 1200);
    });
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
        if (previousHome === undefined) delete process.env.MADARCH_HOME; else process.env.MADARCH_HOME = previousHome;
        if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1150, 1440] as const) {
      test(`the menu's ground reaches the page's end at ${width} px in the ${theme} theme`, async () => {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.setViewport({ width, height: 900 });
        await page.goto(`${server!.url}${fixture!.path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#app-nav');
        await page.waitForFunction(() => (document.querySelector('#app-nav')?.getBoundingClientRect().height ?? 0) > 0, { timeout: 15000 });
        // The menu is up before the document is: measure once the long page has drawn, not its skeleton.
        await page.waitForSelector('[data-testid="document-page"][data-path="docs/long.md"]', { timeout: 15000 });
        const measured = await page.evaluate(() => {
          const aside = document.querySelector('#app-nav') as HTMLElement;
          const box = aside.getBoundingClientRect();
          const style = getComputedStyle(aside);
          return {
            panelTop: Math.round(box.top + window.scrollY),
            panelHeight: Math.round(box.height),
            panelBackground: style.backgroundColor,
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
          };
        });
        // A page long enough for the question to be asked at all.
        expect(measured.documentHeight, `the page at ${width} px runs several windows tall`).toBeGreaterThan(measured.viewportHeight * 2);
        // The ground is the chrome colour, not the page's own paper.
        expect(measured.panelBackground, 'the menu panel paints a background').not.toBe('rgba(0, 0, 0, 0)');
        expect(measured.panelTop, 'the panel starts at the page top').toBe(0);
        expect(measured.panelHeight, `the panel's grey reaches the document's end at ${width} px`).toBeGreaterThanOrEqual(measured.documentHeight - 1);
        // The list inside stays in view: half way down, its sticky box is still at the window top and its own scroll area is one window at most.
        const scrolled = await page.evaluate(() => {
          window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
          const inner = document.querySelector('#app-nav > div') as HTMLElement;
          const list = document.querySelector('[data-testid=nav-scroll]') as HTMLElement;
          const box = inner.getBoundingClientRect();
          const area = list.getBoundingClientRect();
          return { scrollY: Math.round(window.scrollY), innerTop: Math.round(box.top), innerHeight: Math.round(box.height), areaHeight: Math.round(area.height), viewportHeight: window.innerHeight };
        });
        expect(scrolled.scrollY, 'the window scrolled').toBeGreaterThan(0);
        expect(scrolled.innerTop, 'the menu list stays at the window top while the page scrolls').toBeLessThanOrEqual(1);
        expect(scrolled.innerHeight, 'the standing menu box is one window tall').toBeLessThanOrEqual(scrolled.viewportHeight + 1);
        expect(scrolled.areaHeight, 'the menu list itself is in view').toBeGreaterThan(0);
      }, 30000);
    }
  }
});
