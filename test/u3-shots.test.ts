/**
 * A file's text on its page, end to end (madarch-u3vw.16): a throwaway product whose own checkout holds a YAML, a .ts, a
 * long .md and a binary is filled with disk and git, and the file pages are photographed at 1150, 1920 and 390 in light
 * and dark. Run: MADARCH_U3_SHOTS=1 CHROME=... bun test test/u3-shots.test.ts
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

const enabled = process.env['MADARCH_U3_SHOTS'] === '1';
const run = enabled ? describe.serial : describe.skip;
const OUT = process.env['MADARCH_U3_SHOTS_DIR'] ?? '/tmp/ui-shots/madarch-u3vw.16';
const APP = join(import.meta.dir, '..', 'wiki', 'app', 'dist');

let root = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

run('a file page shows its text', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-u3-shots-'));
    const home = join(root, 'products');
    const draft = createDraft({ home, name: 'text-sample', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    useFixturePlugins(draft.folder, ['disk', 'git']);
    mkdirSync(join(draft.folder, 'src'), { recursive: true });
    mkdirSync(join(draft.folder, 'config'), { recursive: true });
    mkdirSync(join(draft.folder, 'docs'), { recursive: true });
    mkdirSync(join(draft.folder, 'public'), { recursive: true });
    writeFileSync(join(draft.folder, 'config', 'cloud-resource.yaml'), 'apiVersion: example.cloud/v1\nkind: CloudResource\nmetadata:\n  name: sample-bucket\nspec:\n  region: europe-west-1\n  tier: standard\n');
    writeFileSync(join(draft.folder, 'src', 'index.ts'), 'export const answer = 42;\n\nexport function double(value: number): number {\n  return value * 2;\n}\n');
    writeFileSync(join(draft.folder, 'docs', 'long.md'), `${Array.from({ length: 120 }, (_, at) => `## Section ${String(at + 1)}\n\nThe product's document number ${String(at + 1)} explains how the wiki keeps one page for every reader.\n`).join('\n')}`);
    writeFileSync(join(draft.folder, 'public', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    commitProduct(draft.folder, 'A product with a YAML, a source file, a document and an image');
    server = await startPreparedServer({ productFolder: draft.folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the fill reads the product tree and each file page shows its text', async () => {
    const base = server!.url.endsWith('/') ? server!.url : `${server!.url}/`;
    const answer = await fetch(`${base}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.file'], pluginsOnly: true }) });
    expect(answer.status).toBe(202);
    void ((await answer.json()) as { runId: string }).runId;
    let state = 'running';
    let last: unknown = null;
    for (let at = 0; at < 120; at += 1) {
      const status = (await (await fetch(`${base}api/status`)).json()) as { fill: { state: string; message?: string } };
      state = status.fill.state;
      last = status.fill;
      if (['done', 'failed', 'stopped'].includes(state)) break;
      await Bun.sleep(1000);
    }
    if (state !== 'done') console.info('FILL', JSON.stringify(last).slice(0, 700));
    expect(state).toBe('done');
    const file = async (path: string): Promise<string> => {
      const found = (await (await fetch(`${base}graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ allCodeFile(where: { path: { _eq: ${JSON.stringify(path)} } }, first: 1) { edges { node { id } } } }` }) })).json()) as { data?: { allCodeFile?: { edges: { node: { id: string } }[] } } };
      const id = found.data?.allCodeFile?.edges[0]?.node.id;
      if (id === undefined) throw new Error(`no code.file for ${path}`);
      return id;
    };
    const yaml = await file('config/cloud-resource.yaml');
    const ts = await file('src/index.ts');
    const md = await file('docs/long.md');
    const png = await file('public/logo.png');
    mkdirSync(OUT, { recursive: true });
    const shot = async (page: Page, name: string, dark: boolean, widths = [1150, 1920, 390]): Promise<void> => {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await page.evaluate(() => { document.querySelector('[data-testid="file-text"]')?.scrollIntoView({ block: 'start' }); });
      for (const width of widths) {
        await page.setViewport({ width, height: width === 390 ? 844 : 1080, deviceScaleFactor: 1 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await page.screenshot({ path: join(OUT, `${name}-${String(width)}-${dark ? 'dark' : 'light'}.png`) });
      }
    };
    const page = await browser!.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 500) void response.text().then((body) => console.info('HTTP 500', response.url().slice(-80), body.slice(0, 700))); });
    /** What one file page draws, read from the live page: the numbers the walk asserts, not only photographs. */
    interface Measured {
      readonly title: string;
      readonly rows: number;
      readonly scroll: { readonly width: number; readonly content: number; readonly wrapped: boolean } | null;
      readonly headings: number;
      readonly binary: string | null;
      readonly sectionWidth: number | null;
      readonly tokenColours: readonly string[];
      readonly failure: string | null;
    }
    try {
      const open = async (id: string): Promise<Measured> => {
        await page.setViewport({ width: 1150, height: 1080 });
        await page.goto(`${base}e/code.file/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const role = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
        if (role !== null) { await page.click('[data-testid="role-first-continue"]'); }
        const shown = await page.waitForSelector('[data-testid="file-text-source"], [data-testid="file-text-rendered"], [data-testid="file-text-binary"], [data-testid="file-text-error"]', { timeout: 30_000 }).catch(async () => { console.info('PAGE TEXT', (await page.evaluate(() => document.body.textContent ?? '')).slice(-400)); console.info('PAGE ERRORS', errors.join(' | ').slice(0, 400)); return null; });
        if (shown === null) throw new Error('the file text section did not render');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const measured = await page.evaluate(() => {
          const box = document.querySelector('[data-testid="file-text-source"]') as HTMLElement | null;
          const rendered = document.querySelector('[data-testid="file-text-rendered"]') as HTMLElement | null;
          return {
            title: (document.querySelector('h1')?.textContent ?? '').trim(),
            rows: document.querySelectorAll('.file-source-line').length,
            scroll: box === null ? null : { width: box.clientWidth, content: box.scrollWidth, wrapped: box.classList.contains('file-source-wrap') },
            headings: rendered === null ? 0 : rendered.querySelectorAll('h1, h2, h3').length,
            binary: document.querySelector('[data-testid="file-text-binary"]')?.textContent ?? null,
            sectionWidth: (document.querySelector('[data-testid="file-text"]') as HTMLElement | null)?.getBoundingClientRect().width ?? null,
            tokenColours: [...new Set([...document.querySelectorAll('.file-source-code .shiki-token')].map((el) => (el as HTMLElement).style.color))].slice(0, 8),
            failure: document.querySelector('[data-testid="file-text-error"]')?.textContent ?? null,
          };
        });
        console.info('measured', JSON.stringify(measured));
        // A file read that failed is a failed walk, never a page to photograph (the owner's review of madarch-u3vw.16).
        expect(measured.failure, `the file page ${id} shows a read error`).toBeNull();
        expect(errors, `the page ${id} logged errors`).toEqual([]);
        return measured;
      };
      const yamlPage = await open(yaml);
      expect(yamlPage.title).toBe('cloud-resource.yaml');
      expect(yamlPage.rows).toBeGreaterThan(5);
      expect(yamlPage.tokenColours.length).toBeGreaterThan(0);
      expect(yamlPage.sectionWidth ?? 0).toBeGreaterThan(600);
      await shot(page, 'yaml-source', false); await shot(page, 'yaml-source', true);
      const tsPage = await open(ts);
      expect(tsPage.title).toBe('index.ts');
      expect(tsPage.rows).toBeGreaterThan(3);
      // The source is highlighted by the kit's own tokens: at least one line carries a syntax colour of the theme.
      expect(tsPage.tokenColours.some((colour) => colour.startsWith('var(--syntax-'))).toBe(true);
      await shot(page, 'ts-source', false); await shot(page, 'ts-source', true);
      const mdPage = await open(md);
      expect(mdPage.title).toBe('long.md');
      expect(mdPage.headings).toBeGreaterThan(100);
      expect(mdPage.scroll).toBeNull();
      await shot(page, 'md-rendered', false); await shot(page, 'md-rendered', true);
      await page.click('[data-testid="file-text-view-source"]');
      await new Promise((resolve) => setTimeout(resolve, 800));
      const mdSource = await page.evaluate(() => document.querySelectorAll('.file-source-line').length);
      expect(mdSource).toBeGreaterThan(0);
      await shot(page, 'md-source', false); await shot(page, 'md-source', true);
      const pngPage = await open(png);
      expect(pngPage.title).toBe('logo.png');
      expect(pngPage.binary ?? '').toContain('logo.png');
      expect(pngPage.rows).toBe(0);
      await shot(page, 'binary', false, [1150, 390]); await shot(page, 'binary', true, [1150, 390]);
      console.info('shots at', OUT);
    } finally { await page.close(); }
  }, 600_000);
});
