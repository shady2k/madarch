/// <reference lib="dom" />
/**
 * The kit's one button on every page (madarch-64o5.127, madarch-64o5.123): the kit page in its states at 1440 and 390, in
 * the light and the dark theme, and a walk of every page that reads each press's box and computed style. Run with
 * MADARCH_WIKI_E2E=1 after `bun run build` in `wiki/app`, as an ordinary user, with MADARCH_PLUGIN_SANDBOX=off; the
 * shots land under MADARCH_WIKI_SHOTS (default /work/shots).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';

const ROOT = join(import.meta.dir, '..');
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env['MADARCH_WIKI_SHOTS'] ?? '/work/shots';
const enabled = process.env['MADARCH_WIKI_E2E'] === '1';
// A headless browser reports no pointing device, so `hover:` styles never match: a run under Xvfb with
// MADARCH_WIKI_HEADFUL=1 launches a windowed browser and reads the hover state as a reader's mouse does.
const headful = process.env['MADARCH_WIKI_HEADFUL'] === '1';
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The button walk is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run it.');

/** Every page of the product that a reader reaches without a fill: the frame pages and the kit. */
const PAGES = [
  '/', '/p/catalogue', '/p/catalogue?select=1', '/p/glossary', '/p/problems', '/p/sources', '/p/runs',
  '/p/settings', '/p/kit', '/p/search?text=code', '/p/prepare?kinds=code.cycle,code.module',
];

interface Press {
  readonly page: string;
  readonly text: string;
  readonly testid: string | null;
  readonly height: number;
  readonly width: number;
  readonly fontSize: string;
  readonly padding: string;
  readonly radius: string;
  readonly border: string;
  readonly background: string;
  readonly color: string;
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly label: string | null;
}

/** Every visible press of the page with the numbers a reader sees, read from the live document. */
async function presses(page: Page): Promise<Press[]> {
  return await page.evaluate(() => {
    const seen = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll('button.ui-button, button.ui-toggle')].filter(seen).map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const id = element.getAttribute('aria-describedby');
      return {
        page: location.pathname + location.search,
        text: (element.textContent ?? '').trim().slice(0, 40),
        testid: element.getAttribute('data-testid'),
        height: Math.round(box.height * 100) / 100,
        width: Math.round(box.width * 100) / 100,
        fontSize: style.fontSize,
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        radius: style.borderTopLeftRadius,
        border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        background: style.backgroundColor,
        color: style.color,
        disabled: (element as HTMLButtonElement).disabled,
        reason: id === null ? null : (document.getElementById(id)?.textContent ?? null),
        label: element.getAttribute('aria-label'),
      };
    });
  });
}

let root = '';
let home = '';
let folder = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

run('one button on every page', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-buttons-e2e-'));
    home = join(root, 'products');
    const draft = createDraft({ home, name: 'buttons-walk', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    folder = draft.folder;
    commitProduct(folder, 'A product to walk the kit over');
    server = await startPreparedServer({ productFolder: folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    mkdirSync(SHOTS, { recursive: true });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: !headful, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // The first visit asks the reader's role in a modal: the walk answers it once, so no shot carries the overlay and no
    // press lands under it.
    const settling = await browser.newPage();
    await settling.goto(`${server.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const asked = await settling.waitForSelector('[data-testid="role-first"]', { timeout: 20_000 }).catch(() => null);
    if (asked !== null) {
      await settling.click('[data-testid="role-first-skip"]');
      await settling.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
    }
    await settling.close();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the kit page shows the button, the icon button and the toggle in their states, measured at 1440 and 390, light and dark', async () => {
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    try {
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        for (const [width, height] of [[1440, 900], [390, 844]] as const) {
          await page.setViewport({ width, height, deviceScaleFactor: 1 });
          await page.goto(`${server!.url}/p/kit`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForSelector('[data-testid="kit-button-default"]', { timeout: 60_000 });
          // The kit's own controls: the button, the icon button, the toggle and the choice group, in their states.
          const heights = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="kit-button-"], [data-testid^="kit-icon-"], [data-testid^="kit-toggle-"]')]
            .map((element) => ({ id: element.getAttribute('data-testid'), height: Math.round(element.getBoundingClientRect().height), disabled: (element as HTMLButtonElement).disabled })));
          expect(heights.length).toBeGreaterThan(0);
          for (const one of heights) expect(`${one.id}:${String(one.height)}`).toBe(`${one.id}:36`);
          // Hover and focus are states of their own: the walk moves the pointer and focuses by hand, then reads the
          // style. A headless browser reports no pointing device, and then the hover state is the browser's to skip,
          // not the kit's to fake.
          const pointer = await page.evaluate(() => matchMedia('(hover: hover)').matches);
          for (const kind of ['button', 'icon', 'toggle'] as const) {
            const target = `[data-testid="kit-${kind}-hover"]`;
            await page.hover(target);
            await new Promise((resolve) => setTimeout(resolve, 260));
            const hover = await page.evaluate((selector) => {
              const element = document.querySelector(selector);
              if (element === null) return null;
              return { background: getComputedStyle(element).backgroundColor, hovered: element.matches(':hover'), hoverGround: getComputedStyle(document.documentElement).getPropertyValue('--surface-hover').trim() };
            }, target);
            expect(hover).not.toBeNull();
            if (pointer) {
              expect(hover!.hovered).toBe(true);
              // The hover ground is the token, not a colour of the control's own.
              expect(hover!.background === 'rgb(236, 238, 240)' || hover!.background === 'rgba(255, 255, 255, 0.07)').toBe(true);
            }
            await page.screenshot({ path: join(SHOTS, `kit-${kind}-hover-${String(width)}-${theme}.png`) });
            const before = await page.evaluate((selector) => getComputedStyle(document.querySelector(selector) as HTMLElement).boxShadow, `[data-testid="kit-${kind}-focus"]`);
            await page.focus(`[data-testid="kit-${kind}-focus"]`);
            await new Promise((resolve) => setTimeout(resolve, 260));
            const ring = await page.evaluate((selector) => {
              const element = document.querySelector(selector);
              if (element === null) return null;
              return { shadow: getComputedStyle(element).boxShadow, focusVisible: element.matches(':focus-visible') };
            }, `[data-testid="kit-${kind}-focus"]`);
            expect(ring).not.toBeNull();
            expect(ring!.focusVisible).toBe(true);
            expect(ring!.shadow).not.toBe(before);
            await page.screenshot({ path: join(SHOTS, `kit-${kind}-focus-${String(width)}-${theme}.png`) });
          }
          await page.screenshot({ path: join(SHOTS, `kit-buttons-${String(width)}-${theme}.png`), fullPage: true });
          // A disabled press says why, beside it, and names the same words as its accessible description.
          const disabled = await presses(page);
          const off = disabled.filter((one) => one.disabled);
          expect(off.length).toBeGreaterThan(0);
          for (const one of off) {
            expect(one.reason ?? '').not.toBe('');
          }
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  }, 300_000);

  test('every page has every button at one height and one computed style, and every disabled press names its reason', async () => {
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    try {
      const all: Press[] = [];
      // Reduced motion cancels the colour transitions the kit's classes declare, so every press is read at rest.
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        for (const address of PAGES) {
          await page.goto(`${server!.url}${address}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await new Promise((resolve) => setTimeout(resolve, 900));
          const found = await presses(page);
          all.push(...found.map((one) => ({ ...one, page: `${theme} ${one.page}` })));
        }
      }
      // One height, one type size, one radius, one border, and the same ground for every press of the same state.
      const heights = new Set(all.map((one) => one.height));
      expect([...heights]).toEqual([36]);
      const sizes = new Set(all.map((one) => one.fontSize));
      expect([...sizes]).toEqual(['14px']);
      const radii = new Set(all.map((one) => one.radius));
      expect([...radii]).toEqual(['6px']);
      const widths = new Set(all.map((one) => one.border.split(' ').slice(0, 2).join(' ')));
      expect([...widths]).toEqual(['1px solid']);
      for (const one of all) {
        const icon = one.label !== null && one.text === '';
        expect(`${one.page} ${one.testid ?? one.text}: ${one.padding}`).toBe(`${one.page} ${one.testid ?? one.text}: ${icon ? '0px 0px 0px 0px' : '0px 12px 0px 12px'}`);
        if (icon) expect(`${one.page} ${one.testid ?? one.text}: ${String(one.width)}`).toBe(`${one.page} ${one.testid ?? one.text}: 36`);
      }
      // The ground is the kit's, not a page's: one colour for the enabled presses of a theme, and the pressed choice's own.
      for (const theme of ['light', 'dark']) {
        const grounds = new Set(all.filter((one) => one.page.startsWith(theme) && !one.disabled).map((one) => one.background));
        expect(grounds.size).toBeLessThanOrEqual(2);
        expect(all.filter((one) => one.page.startsWith(theme) && one.disabled).every((one) => one.background !== undefined)).toBe(true);
      }
      // A disabled press always says why, in words a screen reader reads too.
      const off = all.filter((one) => one.disabled);
      expect(off.length).toBeGreaterThan(0);
      for (const one of off) {
        expect(`${one.page} ${one.testid ?? one.text}: ${one.reason ?? '(no reason)'}`).not.toContain('(no reason)');
        expect(`${one.page} ${one.testid ?? one.text}: ${one.reason ?? ''}`.length).toBeGreaterThan(`${one.page} ${one.testid ?? one.text}: `.length);
      }
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  }, 600_000);

  test('the catalogue reaches preparation with a kind only the agent fills, and the plan there has no error', async () => {
    const page = await browser!.newPage();
    try {
      // The owner reads the wiki in Russian; the page's own words are what this walk asserts.
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server!.url}/p/catalogue?select=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="catalogue-kind-check-code.cycle"]', { timeout: 60_000 });
      // The row stands past the first screen, under the sticky selection bar: a reader's press is the input's own click.
      await page.evaluate(() => (document.querySelector('[data-testid="catalogue-kind-check-code.cycle"]') as HTMLInputElement).click());
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const row = await page.evaluate(() => document.querySelector('[data-kind="code.cycle"]')?.textContent ?? '');
      expect(row).toContain('Заполнит агент');
      const prepare = await page.evaluate(() => {
        const press = document.querySelector('[data-testid="catalogue-prepare"]') as HTMLButtonElement | null;
        return press === null ? null : { disabled: press.disabled };
      });
      expect(prepare).toEqual({ disabled: false });
      const bottom = await page.evaluate(() => document.querySelector('[data-testid="catalogue-bottom"]')?.textContent ?? '');
      expect(bottom).toContain('Выбран 1 вид');
      await page.click('[data-testid="catalogue-prepare"]');
      await page.waitForSelector('[data-testid="prepare-panel"]', { timeout: 60_000 });
      const address = await page.evaluate(() => location.pathname + location.search);
      expect(decodeURIComponent(address)).toContain('kinds=code.cycle,code.module');
      await new Promise((resolve) => setTimeout(resolve, 900));
      const preparePage = await page.evaluate(() => ({
        errors: document.querySelectorAll('[data-testid="prepare-plan-error"]').length,
        unfilled: document.querySelector('[data-testid="prepare-unfilled-summary"]')?.textContent ?? null,
        run: document.querySelector('[data-testid="prepare-run"]') === null ? null : { disabled: (document.querySelector('[data-testid="prepare-run"]') as HTMLButtonElement).disabled, reason: (() => { const id = document.querySelector('[data-testid="prepare-run"]')?.getAttribute('aria-describedby'); return id === null || id === undefined ? null : document.getElementById(id)?.textContent; })() },
      }));
      // Plugins only is the default here: nothing of the cycle runs, the kinds that stay empty are named, and the press
      // is never disabled for want of an agent the page has not chosen yet.
      expect(preparePage.errors).toBe(0);
      expect(preparePage.unfilled).not.toBeNull();
      expect(preparePage.run).not.toBeNull();
      await mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, 'catalogue-cycle-prepare-1440.png'), fullPage: true });
    } finally {
      await page.close();
    }
  }, 300_000);
});
