/// <reference lib="dom" />
/**
 * The first-visit role card over a diagram (madarch-11am): its last choice, «Everything», is the topmost thing at its
 * own centre. The training product's home page draws LikeC4's navigation panel at the diagram's top-left; that panel
 * must stand under the card, not over it, at 1150 and 390 px. Run with MADARCH_WIKI_E2E=1 after building wiki/app.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = join(ROOT, 'out', 'shots-11am');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki dialog-stacking E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run them.');

type Rect = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/** Builds the filled product in a child process; the graph fill needs more memory than the test runner should carry. */
function prepareFixture(work: string): { home: string; user: string; store: string } {
  const child = spawnSync(process.execPath, [join(ROOT, 'test', 'fixtures', 'dialog-stacking-fixture.ts'), work], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 180_000,
  });
  if (child.status !== 0) throw new Error(`the fixture was not prepared: ${child.stderr.trim() || child.stdout.trim() || `exit ${child.status ?? 'none'}`}`);
  return JSON.parse(readFileSync(join(work, 'fixture.json'), 'utf8')) as { home: string; user: string; store: string };
}

runDescribe('a first-visit dialog over a diagram (built app and Chromium)', () => {
  let work: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    work = mkdtempSync(join(tmpdir(), 'madarch-dialog-stacking-'));
    const fixture = prepareFixture(work);
    server = await startServer({
      productHome: fixture.home,
      appFolder: APP,
      port: 0,
      knowledgeRoot: fixture.store,
      log: () => undefined,
      errorLog: (line) => console.error(line),
      env: { ...process.env, HOME: fixture.user, MADARCH_HOME: join(fixture.user, 'madarch') },
    });
    browser = await puppeteer.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }, 180_000);

  afterAll(async () => {
    try { if (page !== undefined) await page.close(); } catch { /* the run is over */ }
    try { if (browser !== undefined) await browser.close(); } finally {
      try { await server?.stop(); } finally { if (work !== undefined) rmSync(work, { recursive: true, force: true }); }
    }
  }, 120_000);

  for (const viewport of [{ width: 1150, height: 900 }, { width: 390, height: 844 }] as const) {
    test(`the last role choice is the topmost thing under the LikeC4 panel at ${viewport.width} px`, async () => {
      page = await browser!.newPage();
      await page.setViewport(viewport);
      await page.goto(`${server!.url}/products/training/k`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=role-card]', { timeout: 20_000 });
      // The diagram is drawn by a web component: wait for the panel inside its shadow root, not just the page shell.
      await page.waitForFunction(() => {
        const host = document.querySelector('.likec4-view');
        const shadow = host?.shadowRoot;
        if (shadow === null || shadow === undefined) return false;
        return [...shadow.querySelectorAll('*')].some((element) => {
          const box = element.getBoundingClientRect();
          return Number(getComputedStyle(element).zIndex) >= 100 && box.width > 100 && box.height > 0;
        });
      }, { timeout: 30_000 });
      // A narrow window scrolls the card's choices inside the card; every choice is still reachable.
      await page.$eval('[data-testid=role-option][data-role=everything]', (element) => element.scrollIntoView({ block: 'center' }));
      const before = await page.evaluate(() => {
        const options = [...document.querySelectorAll<HTMLElement>('[data-testid=role-option]')];
        const option = options.at(-1);
        if (option === undefined) return null;
        const optionBox = option.getBoundingClientRect();
        const textBox = option.querySelector('span')!.getBoundingClientRect();
        const panels = [...document.querySelectorAll<HTMLElement>('.likec4-view')].flatMap((host) => {
          const shadow = host.shadowRoot;
          if (shadow === null) return [];
          return [...shadow.querySelectorAll<HTMLElement>('*')]
            .filter((element) => Number(getComputedStyle(element).zIndex) >= 100)
            .map((element) => element.getBoundingClientRect())
            .filter((box) => box.width > 100 && box.height > 0);
        }).sort((a, b) => b.width * b.height - a.width * a.height);
        return {
          role: option.getAttribute('data-role'),
          option: { left: optionBox.left, top: optionBox.top, right: optionBox.right, bottom: optionBox.bottom } satisfies Rect,
          centre: { x: optionBox.left + optionBox.width / 2, y: optionBox.top + optionBox.height / 2 },
          description: { x: textBox.left + Math.min(20, textBox.width / 4), y: textBox.top + textBox.height / 2 },
          panels: panels.map((box) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom } satisfies Rect)),
        };
      });
      expect(before, 'the role card and a LikeC4 panel are both on the page').not.toBeNull();
      expect(before!.role, 'the last choice is «Everything»').toBe('everything');
      expect(before!.panels.length, `the LikeC4 panel is drawn: ${JSON.stringify(before!.panels)}`).toBeGreaterThan(0);
      const panel = before!.panels[0]!;
      // Scroll the page until that panel lies across the choice. The card itself does not move, because it is fixed to
      // the window.
      const delta = panel.top - (before!.centre.y - (panel.bottom - panel.top) / 2);
      await page.evaluate((amount) => window.scrollBy(0, amount), delta);
      await new Promise((rest) => setTimeout(rest, 250));
      const measured = await page.evaluate(() => {
        const options = [...document.querySelectorAll<HTMLElement>('[data-testid=role-option]')];
        const option = options.at(-1)!;
        const card = document.querySelector<HTMLElement>('[data-testid=role-card]')!;
        const optionBox = option.getBoundingClientRect();
        const textBox = option.querySelector('span')!.getBoundingClientRect();
        const points = [
          { name: 'centre', x: optionBox.left + optionBox.width / 2, y: optionBox.top + optionBox.height / 2 },
          { name: 'description', x: textBox.left + Math.min(20, textBox.width / 4), y: textBox.top + textBox.height / 2 },
        ];
        const panels = [...document.querySelectorAll<HTMLElement>('.likec4-view')].flatMap((host) => {
          const shadow = host.shadowRoot;
          if (shadow === null) return [];
          return [...shadow.querySelectorAll<HTMLElement>('*')]
            .filter((element) => Number(getComputedStyle(element).zIndex) >= 100)
            .map((element) => element.getBoundingClientRect())
            .filter((box) => box.width > 100 && box.height > 0);
        }).sort((a, b) => b.width * b.height - a.width * a.height);
        const panelBox = panels[0]!;
        const hits = points.map((point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            ...point,
            covered: panelBox.left <= point.x && point.x <= panelBox.right && panelBox.top <= point.y && point.y <= panelBox.bottom,
            hit: hit === null ? null : { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', inOption: option === hit || option.contains(hit), inCard: card === hit || card.contains(hit) },
          };
        });
        return {
          option: { left: optionBox.left, top: optionBox.top, right: optionBox.right, bottom: optionBox.bottom } satisfies Rect,
          panel: { left: panelBox.left, top: panelBox.top, right: panelBox.right, bottom: panelBox.bottom } satisfies Rect,
          hits,
        };
      });
      // The panel really lies over part of the choice — at least its description, and at 390 px its centre too: the hit
      // test is about the two layers, not a miss.
      const covered = measured.hits.filter((hit) => hit.covered);
      expect(covered.length, `the LikeC4 panel lies over the choice: ${JSON.stringify(measured.hits)}`).toBeGreaterThan(0);
      expect(covered.some((hit) => hit.name === 'description'), 'the panel covers the description').toBe(true);
      for (const hit of measured.hits) {
        expect(hit.hit?.inOption, `the last choice receives the ${hit.name} point, not ${hit.hit?.tag ?? 'nothing'}.${hit.hit?.className ?? ''}`).toBe(true);
      }
      await page.screenshot({ path: join(SHOTS, `role-dialog-${viewport.width}.png`) });
      await page.close();
      page = undefined;
    }, 60_000);
  }
});
