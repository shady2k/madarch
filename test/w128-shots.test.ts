/**
 * The records table and the full-screen diagram, as the owner reads them (madarch-64o5.128, .129): a throwaway product
 * filled with disk and git, then the catalogue entry of the file kind and one file's page are photographed at 1440 and
 * 390 in light and dark, with what the page holds measured.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const enabled = process.env['MADARCH_W128_SHOTS'] === '1';
const run = enabled ? describe.serial : describe.skip;
const APP = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
const OUT = process.env['MADARCH_W128_SHOTS_DIR'] ?? '/work/wt-128/docs/prototypes/madarch-64o5.128';

let root = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

run('the records table and the full-screen diagram', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-w128-'));
    const home = join(root, 'products');
    const draft = createDraft({ home, name: 'records-sample', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    useFixturePlugins(draft.folder, ['disk', 'git']);
    mkdirSync(join(draft.folder, 'src'), { recursive: true });
    for (let at = 0; at < 30; at += 1) writeFileSync(join(draft.folder, 'src', `file-${String(at).padStart(2, '0')}.ts`), `export const value${String(at)} = ${String(at)};\n`);
    writeFileSync(join(draft.folder, 'docs', 'notes.md'), '# Notes\n\nA document.\n');
    commitProduct(draft.folder, 'A product with thirty files');
    server = await startPreparedServer({ productFolder: draft.folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the catalogue entry shows a searchable, filterable, sortable, paged table and the diagram opens full screen', async () => {
    const base = server!.url.endsWith('/') ? server!.url : `${server!.url}/`;
    const fill = await fetch(`${base}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.file'], pluginsOnly: true }) });
    if (fill.status !== 202) throw new Error(`fill refused: ${await fill.text()}`);
    for (let at = 0; at < 200; at += 1) {
      const status = (await (await fetch(`${base}api/status`)).json()) as { fill: { state: string; message?: string } };
      if (['done', 'failed', 'stopped'].includes(status.fill.state)) {
        if (status.fill.state !== 'done') throw new Error(`fill ${status.fill.state}: ${status.fill.message ?? ''}`);
        break;
      }
      await Bun.sleep(1000);
    }
    const found = (await (await fetch(`${base}graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ catalogueEntity(name: "code.file") { id } }' }) })).json()) as { data?: { catalogueEntity?: { id?: string } } };
    const catalogue = found.data?.catalogueEntity?.id;
    const file = (await (await fetch(`${base}graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ allCodeFile(first: 1) { edges { node { id } } } }' }) })).json()) as { data?: { allCodeFile?: { edges: { node: { id: string } }[] } } };
    const one = file.data?.allCodeFile?.edges[0]?.node.id;
    if (catalogue === undefined || one === undefined) throw new Error('the fill left no catalogue entry or file');
    mkdirSync(OUT, { recursive: true });
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    try {
      const settle = async (): Promise<void> => {
        const role = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
        if (role !== null) { await page.click('[data-testid="role-first-continue"]'); await new Promise((resolve) => setTimeout(resolve, 800)); }
      };
      const shot = async (name: string): Promise<void> => {
        for (const dark of [false, true]) {
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
          for (const width of [1440, 390]) {
            await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
            await new Promise((resolve) => setTimeout(resolve, 700));
            await page.screenshot({ path: join(OUT, `${name}-${String(width)}-${dark ? 'dark' : 'light'}.png`) });
          }
        }
        await page.setViewport({ width: 1440, height: 1000 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      };
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(`${base}e/catalogue/${encodeURIComponent(catalogue)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settle();
      await page.waitForSelector('[data-testid="table"]', { timeout: 60_000 });
      const table = await page.evaluate(() => ({
        search: document.querySelector('[data-testid="table-search"]') !== null,
        find: document.querySelector('[data-testid="table-find"]') !== null,
        facets: [...document.querySelectorAll('[data-testid^="table-facet-language-"]')].slice(0, 3).map((one) => one.textContent),
        sorts: [...document.querySelectorAll('[data-testid^="table-sort-"]')].map((one) => one.textContent),
        summary: [...document.querySelectorAll('nav, div')].map((one) => one.textContent ?? '').find((text) => /\/\s*\d+/u.test(text) && text.length < 40) ?? '',
        rows: document.querySelectorAll('tbody tr').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      console.info('RECORDS', JSON.stringify(table));
      await shot('records');
      await page.goto(`${base}e/catalogue/${encodeURIComponent(catalogue)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settle();
      await page.waitForSelector('[data-testid="diagram-fullscreen-open"]', { timeout: 60_000 });
      await page.evaluate(() => { document.querySelector('[data-testid="diagram-fullscreen-open"]')?.scrollIntoView({ block: 'center' }); });
      await page.click('[data-testid="diagram-fullscreen-open"]');
      await page.waitForSelector('[data-testid="diagram-fullscreen"]', { timeout: 30_000 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const full = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="diagram-fullscreen"]') as HTMLElement | null;
        return { open: dialog !== null, width: dialog?.getBoundingClientRect().width ?? 0, height: dialog?.getBoundingClientRect().height ?? 0, escape: dialog?.querySelector('button[aria-label="Close full screen"]') !== null };
      });
      console.info('FULLSCREEN', JSON.stringify(full));
      await shot('fullscreen');
      console.info('FAILURES', failures.filter((one) => !one.includes('favicon')).join(' | ').slice(0, 300));
    } finally {
      await page.close();
    }
  }, 600_000);
});
