/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { makeProduct } from './knowledge-fixture.js';

/**
 * Reader acceptance for the entity catalogue's current row (madarch-u3vw.10): the active row of the sidebar draws its
 * outline whole inside the column at 1150 and 390 px in both themes. Run with MADARCH_WIKI_E2E=1 after building wiki/app.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki catalogue E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run them.');

/** A product with one commit, so the server seeds the starter set and its catalogue declares every kind. */
function buildProduct(root: string): string {
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'README.md'), '# Shop\n\nA catalogue fixture.\n');
  writeFileSync(join(repository, 'src', 'pay.ts'), 'export function pay(): number { return 1; }\n');
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '-A'], ['commit', '--quiet', '-m', 'Fixture']]) {
    const result = execFileSync('git', args, { cwd: repository, env, encoding: 'utf8' });
    if (result === undefined) throw new Error(`git ${args.join(' ')} failed in ${repository}`);
  }
  return makeProduct(root, 'shop', repository, 'shop');
}

interface Outline {
  state: 'visible' | 'none';
  width: number;
  offset: number;
  item: { left: number; right: number; top: number; bottom: number };
  nav: { left: number; right: number; top: number; bottom: number };
}

runDescribe('the catalogue in the built app (real server and Chromium)', () => {
  let root: string | undefined;
  let previousHome: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-catalogue-e2e-'));
    const product = buildProduct(root);
    // The reader's role lives in madarch's own settings: the first-run card would otherwise stand over the page.
    const madarchHome = join(root, 'madarch-home');
    mkdirSync(madarchHome, { recursive: true });
    writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    previousHome = process.env.MADARCH_HOME;
    process.env.MADARCH_HOME = madarchHome;
    server = await startServer({
      productFolder: product,
      appFolder: APP,
      port: 0,
      host: '127.0.0.1',
      knowledgeRoot: join(root, 'store'),
      log: () => undefined,
      errorLog: (line) => console.error(line),
    });
    // The first answer seeds the starter set the catalogue lists.
    const seeded = await fetch(`${server.url}/api/status`);
    if (seeded.status !== 200) throw new Error(`the status answer was ${seeded.status}`);
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  }, 120_000);

  afterAll(async () => {
    if (process.env.MADARCH_HOME === root) delete process.env.MADARCH_HOME;
    if (previousHome !== undefined) process.env.MADARCH_HOME = previousHome;
    await browser?.close();
    await server?.stop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  /** The catalogue at one window and theme, in Russian, with the waiting for the page settled. */
  async function open(width: number, height: number, scheme: 'light' | 'dark'): Promise<Page> {
    const page = await browser!.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.evaluateOnNewDocument(() => localStorage.setItem('madarch-wiki-language', 'ru'));
    await page.goto(`${server!.url}/catalogue`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=catalogue-page]', { timeout: 30_000 });
    return page;
  }

  /** The active row's outline and the visible box of the list that clips it, read in the drawer at a phone's width. */
  async function outlineOf(page: Page, phone: boolean): Promise<Outline> {
    if (phone) {
      await page.click('.shell-menu');
      await page.waitForSelector('[data-testid=phone-nav] [data-testid=nav-catalogue]', { timeout: 10_000 });
    }
    return await page.evaluate((narrow: boolean) => {
      const scope: ParentNode = narrow ? document.querySelector('[data-testid=phone-nav]')! : document;
      const active = scope.querySelector('a[aria-current="page"]')!;
      const nav = scope.querySelector('[data-testid=nav-scroll]')!;
      const style = getComputedStyle(active);
      const width = Number.parseFloat(style.outlineWidth);
      const offset = Number.parseFloat(style.outlineOffset);
      const rect = active.getBoundingClientRect();
      const box = nav.getBoundingClientRect();
      const round = (value: { left: number; right: number; top: number; bottom: number }) => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom });
      return { state: (style.outlineStyle === 'none' || width === 0 ? 'none' : 'visible') as 'none' | 'visible', width, offset, item: round(rect), nav: round(box) };
    }, phone);
  }

  for (const [width, height, phone] of [[1150, 900, false], [390, 844, true]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`the active sidebar row draws its outline whole inside the visible column at ${width} px, ${scheme}`, async () => {
        const page = await open(width, height, scheme);
        try {
          const outline = await outlineOf(page, phone);
          expect(outline.state).toBe('visible');
          expect(outline.width).toBeGreaterThan(0);
          // The outline is drawn inside the row, and the row's box, with that line, stands inside the list's clip.
          const left = outline.item.left - outline.offset - outline.width;
          const right = outline.item.right + outline.offset + outline.width;
          const top = outline.item.top - outline.offset - outline.width;
          const bottom = outline.item.bottom + outline.offset + outline.width;
          expect(left).toBeGreaterThanOrEqual(outline.nav.left);
          expect(right).toBeLessThanOrEqual(outline.nav.right);
          expect(top).toBeGreaterThanOrEqual(outline.nav.top);
          expect(bottom).toBeLessThanOrEqual(outline.nav.bottom);
          // An inactive row carries no line at all.
          const inactive = await page.evaluate((narrow: boolean) => {
            const scope: ParentNode = narrow ? document.querySelector('[data-testid=phone-nav]')! : document;
            const row = scope.querySelector('[data-testid=nav-home]')!;
            const style = getComputedStyle(row);
            return { current: row.classList.contains('nav-current'), width: style.outlineWidth, style: style.outlineStyle };
          }, phone);
          expect(inactive.current).toBe(false);
          expect(inactive.style === 'none' || inactive.width === '0px').toBe(true);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

});
