
/**
 * The fill flow on the portal's kit, in a real browser (decision 0036, sections 7 and 8): a product is filled with the
 * disk and git plugins only, no agent and no model, the fill page is opened in Russian, a kind is checked and the run is
 * pressed, and the run page is read once the run ends. The screenshots — 1440 px wide, the reference's width — are
 * written under MADARCH_WIKI_SHOTS (default /work/shots). Run with MADARCH_WIKI_E2E=1 after `bun run build` in
 * `wiki/app`, as an ordinary user, with MADARCH_PLUGIN_SANDBOX=off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const ROOT = join(import.meta.dir, '..');
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env['MADARCH_WIKI_SHOTS'] ?? '/work/shots';
const enabled = process.env['MADARCH_WIKI_E2E'] === '1';
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The fill flow walk is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run it.');

let root = '';
let home = '';
let folder = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

/** The page's text, as a person reads it. */
async function textOf(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.textContent ?? '');
}

run('the fill flow on a product filled with disk and git', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-fill-e2e-'));
    home = join(root, 'products');
    const draft = createDraft({ home, name: 'portal-fill', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    folder = draft.folder;
    // The owner's shape: the disk and git plugins only, no agent and no model.
    useFixturePlugins(folder, ['disk', 'git']);
    // A little code and a note for the fill to read.
    mkdirSync(join(folder, 'src'), { recursive: true });
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    writeFileSync(join(folder, 'README.md'), '# Portal fill\n\nA product to fill with disk and git.\n');
    commitProduct(folder, 'A product to fill');
    server = await startPreparedServer({ productFolder: folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the fill page chooses a kind, runs it, and the run page states the result', async () => {
    mkdirSync(SHOTS, { recursive: true });
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      const response = await page.goto(`${server!.url}/p/fill`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      try {
        await page.waitForSelector('[data-testid="fill-setup"]', { timeout: 60_000 });
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const html = await page.content();
        const state = await page.evaluate(() => ({ ready: document.readyState, root: document.getElementById('root')?.innerHTML.slice(0, 300) ?? 'no root', where: location.href }));
        process.stdout.write(`PAGE ${String(response?.status())} text=${await textOf(page)}\nERRORS ${failures.join(' | ')}\nSTATE ${JSON.stringify(state)}\nHTML ${html.slice(0, 700)}\n`);
        throw error;
      }
      await page.waitForFunction(() => (document.body.textContent ?? '').includes('Выберите, что заполнить'), { timeout: 60_000 });
      const opened = await textOf(page);
      expect(opened).toContain('Найти вид');
      expect(opened).not.toContain('code.file');

      // A kind the disk plugin fills pulls the repository it derives from; the server states both.
      const box = await page.$('[data-testid="fill-setup-check-code.file"]');
      expect(box).not.toBeNull();
      await box!.click();
      await page.waitForSelector('[data-testid="fill-setup-run"]');
      for (let at = 0; at < 120; at += 1) {
        const disabled = await page.$eval('[data-testid="fill-setup-run"]', (element) => (element as HTMLButtonElement).disabled);
        if (!disabled) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const plan = await textOf(page);
      expect(plan).toContain('Порядок заполнения');
      await page.click('[data-testid="fill-setup-run"]');
      await page.waitForFunction(() => window.location.pathname === '/p/run', { timeout: 60_000 });
      const runId = new URL(page.url()).searchParams.get('run');
      expect(runId).not.toBeNull();

      // The run page states the run once it is no longer live.
      await page.waitForSelector('[data-testid="fill-run-page"]', { timeout: 120_000 });
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="fill-run-page"]');
        const state = element?.getAttribute('data-state') ?? '';
        return state !== '' && !['created', 'planning', 'running', 'pausing', 'cancelling'].includes(state);
      }, { timeout: 300_000 });
      const state = await page.$eval('[data-testid="fill-run-page"]', (element) => element.getAttribute('data-state'));
      const result = await textOf(page);
      expect(result).not.toContain('/work/');
      expect(result).not.toMatch(/\b[0-9a-f]{40}\b/u);
      expect(result).not.toContain('the run started');
      // The log is the person's wording, and the result names the kind by the catalogue's word.
      expect(result).toContain('Журнал запуска');
      await page.evaluate(() => { document.querySelector('[data-testid="fill-run-log"]')?.setAttribute('open', ''); });
      await page.waitForFunction(() => (document.querySelector('[data-testid="fill-run-log"]')?.textContent ?? '').length > 40, { timeout: 10_000 });
      await page.waitForFunction(() => (document.querySelector('[data-testid="fill-button"]')?.textContent ?? '').includes('Заполнить'), { timeout: 20_000 });
      await page.screenshot({ path: join(SHOTS, 'run-ru.png') });
      // The log lies below the first screen: the page's own column scrolls, and this view shows it as a person reads it.
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = column.scrollHeight; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, 'run-ru-log.png') });
      expect(state, `${SHOTS}/run-ru.png: ${result.slice(0, 1200)}`).toBe('succeeded');

      // The fill page after the run: a filled product, its history, and the press ready again.
      await page.goto(`${server!.url}/p/fill`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="fill-setup"]', { timeout: 60_000 });
      await page.waitForFunction(() => (document.querySelector('[data-testid="fill-button"]')?.textContent ?? '').includes('Заполнить'), { timeout: 30_000 });
      await page.waitForSelector('[data-testid="fill-history-run"]', { timeout: 30_000 });
      const after = await textOf(page);
      expect(after).toContain('История заполнений');
      await page.screenshot({ path: join(SHOTS, 'fill-ru.png') });
      expect(failures.filter((one) => !one.includes('favicon')).join('\n')).toBe('');
    } finally {
      await page.close();
    }
  }, 600_000);
});
