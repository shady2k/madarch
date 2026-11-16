/**
 * The diagram at full screen (madarch-64o5.129): a throwaway product filled with disk and git, its kind's page opened
 * and the picture taken to full screen, photographed at 1440 and 390 in light and dark with the dialog measured.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const enabled = process.env['MADARCH_W129_SHOTS'] === '1';
const run = enabled ? describe.serial : describe.skip;
const APP = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
const OUT = process.env['MADARCH_W129_SHOTS_DIR'] ?? '/work/wt-129/docs/prototypes/madarch-64o5.129';

let root = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

run('the diagram at full screen', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-w129-'));
    const draft = createDraft({ home: join(root, 'products'), name: 'fullscreen-sample', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    useFixturePlugins(draft.folder, ['disk', 'git']);
    mkdirSync(join(draft.folder, 'src'), { recursive: true });
    for (let at = 0; at < 12; at += 1) writeFileSync(join(draft.folder, 'src', `file-${String(at)}.ts`), `export const value${String(at)} = ${String(at)};\n`);
    writeFileSync(join(draft.folder, 'docs', 'notes.md'), '# Notes\n\nA document.\n');
    commitProduct(draft.folder, 'A product for the full-screen walk');
    server = await startPreparedServer({ productFolder: draft.folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the picture opens in the dialog and closes again', async () => {
    const base = server!.url.endsWith('/') ? server!.url : `${server!.url}/`;
    const fill = await fetch(`${base}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.file'], pluginsOnly: true }) });
    if (fill.status !== 202) throw new Error(`fill refused: ${await fill.text()}`);
    for (let at = 0; at < 200; at += 1) {
      const status = (await (await fetch(`${base}api/status`)).json()) as { fill: { state: string } };
      if (['done', 'failed', 'stopped'].includes(status.fill.state)) { if (status.fill.state !== 'done') throw new Error(`fill ${status.fill.state}`); break; }
      await Bun.sleep(1000);
    }
    const found = (await (await fetch(`${base}graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ catalogueEntity(name: "code.file") { id } }' }) })).json()) as { data?: { catalogueEntity?: { id?: string } } };
    const catalogue = found.data?.catalogueEntity?.id;
    if (catalogue === undefined) throw new Error('no catalogue entry');
    mkdirSync(OUT, { recursive: true });
    const page: Page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(`${base}e/catalogue/${encodeURIComponent(catalogue)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const role = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
      if (role !== null) await page.click('[data-testid="role-first-continue"]');
      await page.waitForSelector('[data-testid="diagram-fullscreen-open"]', { timeout: 60_000 });
      await page.evaluate(() => { document.querySelector('[data-testid="diagram-fullscreen-open"]')?.scrollIntoView({ block: 'center' }); });
      await page.click('[data-testid="diagram-fullscreen-open"]');
      await page.waitForSelector('[data-testid="diagram-fullscreen"]', { timeout: 30_000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const measured = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="diagram-fullscreen"]') as HTMLElement | null;
        const pane = dialog?.querySelector('[data-testid="likec4-pane"], likec4-view, [data-testid="diagram-picture"]') as HTMLElement | null;
        return { width: Math.round(dialog?.getBoundingClientRect().width ?? 0), height: Math.round(dialog?.getBoundingClientRect().height ?? 0), pane: pane !== null, close: dialog?.querySelector('button[aria-label="Close full screen"]') !== null, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      console.info('FULLSCREEN', JSON.stringify(measured));
      for (const dark of [false, true]) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        for (const width of [1440, 390]) {
          await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
          await new Promise((resolve) => setTimeout(resolve, 800));
          await page.screenshot({ path: join(OUT, `fullscreen-${String(width)}-${dark ? 'dark' : 'light'}.png`) });
        }
      }
      await page.setViewport({ width: 1440, height: 1000 });
      await page.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 400));
      console.info('ESCAPED', await page.evaluate(() => document.querySelector('[data-testid="diagram-fullscreen"]') === null));
    } finally { await page.close(); }
  }, 600_000);
});
