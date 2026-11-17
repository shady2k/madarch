/**
 * The items the integration restored (madarch-64o5.136, the owner's «Я не просил выбрасывать»): the served-product
 * switcher and the «?» in the top bar, the catalogue's failed-kind badge, and the home's live fill line and incomplete
 * card, photographed at 1440 and 390 in light and dark from a served products home.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const enabled = process.env['MADARCH_W136_SHOTS'] === '1';
const run = enabled ? describe.serial : describe.skip;
const APP = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
const OUT = process.env['MADARCH_W136_SHOTS_DIR'] ?? '/tmp/screens-136';

let root = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;
let alpha = '';
let beta = '';
let own = '';
let base = '';

async function fill(folder: string, kind: string): Promise<{ state: string; message?: string }> {
  // A products home serves each product below its folder: its commands answer there.
  const productBase = `${base}products/${folder}/`;
  const pressed = await fetch(`${productBase}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: [kind], pluginsOnly: true }) });
  if (pressed.status !== 202) throw new Error(`fill refused: ${await pressed.text()}`);
  for (let at = 0; at < 240; at += 1) {
    const status = (await (await fetch(`${productBase}api/status`)).json()) as { fill: { state: string; message?: string } };
    if (['done', 'failed', 'stopped'].includes(status.fill.state)) return status.fill;
    await Bun.sleep(500);
  }
  throw new Error('the fill did not finish');
}

run('the restored items', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-w136-'));
    const home = join(root, 'products');
    const make = (name: string): string => {
      const draft = createDraft({ home, name, gitEnv: gitEnv(SAMPLE_IDENTITY) });
      if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
      return draft.folder;
    };
    alpha = make('alpha');
    beta = make('beta');
    own = make('madarch-wiki');
    for (const folder of [alpha, beta]) {
      useFixturePlugins(folder, ['disk', 'git']);
      mkdirSync(join(folder, 'src'), { recursive: true });
      for (let at = 0; at < 24; at += 1) writeFileSync(join(folder, 'src', `file-${String(at).padStart(2, '0')}.ts`), `export const value${String(at)} = ${String(at)};\n`);
      writeFileSync(join(folder, 'docs', 'notes.md'), '# Notes\n\nA document.\n');
      commitProduct(folder, 'A product with twenty-four files');
    }
    commitProduct(own, 'madarch own wiki fixture');
    server = await startPreparedServer({ productHome: home, ownWiki: { folder: own }, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    base = server.url.endsWith('/') ? server.url : `${server.url}/`;
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-zygote'] });
    mkdirSync(OUT, { recursive: true });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test("the switcher, the «?», the failed badge and the home's fill states are on the pages", async () => {
    // beta's fill fails: its disk plugin is edited after the closure was hashed, so the plugin refuses every unit.
    const plugin = join(beta, 'plugins', 'disk', 'main.ts');
    writeFileSync(plugin, `${readFileSync(plugin, 'utf8')}\nthrow new Error('the shot plugin refuses to run');\n`);
    const failed = await fill('beta', 'code.file').catch((error: unknown) => ({ state: 'refused', message: String(error) }));
    // alpha's fill succeeds, and a new commit to its repository leaves the graph holding part of it.
    const done = await fill('alpha', 'code.file');
    if (done.state !== 'done') throw new Error(`alpha fill ${done.state}: ${done.message ?? ''}`);
    writeFileSync(join(alpha, 'src', 'later.ts'), 'export const later = 1;\n');
    commitProduct(alpha, 'One more file after the fill');

    const page: Page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const settle = async (ms = 1200): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)); };
    // Every screen is read as its DOM measures it: the body's words, one fill control, no failure and no publication
    // note — the numbers stand in the test's output beside the picture (madarch-64o5.136, round 4).
    const shot = async (name: string): Promise<void> => {
      for (const dark of [false, true]) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
        for (const width of [1440, 390]) {
          await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
          await settle(400);
          const measured = await page.evaluate(() => {
            const main = document.querySelector('main');
            const text = (main?.textContent ?? '').replace(/\s+/gu, ' ').trim();
            return {
              main: text.length,
              head: text.slice(0, 90),
              fillEntry: document.querySelectorAll('[data-testid="fill-entry"]').length,
              indicator: document.querySelectorAll('[data-testid="run-indicator"]').length,
              loading: document.querySelectorAll('[data-testid="page-loading"]').length,
              error: document.querySelectorAll('[data-testid="wiki-error"]').length,
              publication: document.querySelectorAll('[data-publication]').length,
              live: /Filling|Заполняется|Filled:|Заполнено:/.test(text),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          console.log(`MEASURE ${name} ${String(width)} ${dark ? 'dark' : 'light'} ${JSON.stringify(measured)}`);
          await page.screenshot({ path: join(OUT, `${name}-${String(width)}-${dark ? 'dark' : 'light'}.png`), fullPage: false });
        }
      }
    };
    const open = async (path: string): Promise<void> => {
      // The app keeps a change stream open, so `networkidle0` never comes: the page's own frame is the readiness, and
      // then the page's sections — a slow read shows its shapes until the answer stands (madarch-64o5.136).
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="wiki-app"], [data-testid="wiki-error"], [data-publication]', { timeout: 60_000 }).catch(() => null);
      for (let at = 0; at < 30; at += 1) {
        const ready = await page.evaluate(() => {
          const main = document.querySelector('main');
          return document.querySelector('[data-testid="page-loading"]') === null && ((main?.textContent ?? '').trim().length > 0 || document.querySelector('[data-testid="frame-rebuilding"]') !== null);
        });
        if (ready) break;
        await settle(1000);
      }
      await settle(800);
      const role = await page.$('[data-testid="role-first"]');
      if (role !== null) { await page.click('[data-testid="role-first-continue"]'); await settle(800); }
    };
    try {
      // The switcher and the «?»: a products home serves alpha and beta and madarch's own wiki beside them.
      await open('products/alpha/');
      const trigger = await page.$('[data-testid="product-menu"]');
      if (trigger === null) throw new Error('the product menu is not on the top bar');
      await trigger.click();
      await settle(500);
      await shot('frame-switcher');
      await page.keyboard.press('Escape');

      // The home: the live fill line while a fill runs, then the incomplete card after a later commit.
      await fetch(`${base}products/alpha/api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.file'], pluginsOnly: true }) }).catch(() => undefined);
      await open('products/alpha/');
      // The home's sections stand as soon as their answer comes; a slow read under a running fill shows its shapes, and
      // the picture waits for the sections themselves (madarch-64o5.136).
      for (let at = 0; at < 30; at += 1) {
        const ready = await page.evaluate(() => {
          const text = document.querySelector('main')?.textContent ?? '';
          return text.includes('Where this product stands') && /Filling|Заполняется|Filled:|Заполнено:/.test(text);
        });
        if (ready) break;
        await settle(1000);
      }
      await shot('home-live');
      for (let at = 0; at < 120; at += 1) {
        const status = (await (await fetch(`${base}products/alpha/api/status`)).json()) as { fill: { state: string } };
        if (['done', 'failed', 'stopped'].includes(status.fill.state)) break;
        await Bun.sleep(500);
      }
      const after = (await (await fetch(`${base}products/alpha/api/status`)).json()) as { incomplete?: boolean };
      if (after.incomplete === true) { await open('products/alpha/'); await shot('home-incomplete'); }

      // The catalogue's failed-kind badge on beta, whose fill failed.
      await open('products/beta/p/catalogue');
      await shot('catalogue-failed');
      if (failures.length > 0) throw new Error(`the pages failed: ${failures.slice(0, 3).join(' | ')}`);
      if (failed.state !== 'failed') throw new Error(`the shot expected a failed fill, got ${failed.state}: ${failed.message ?? ''}`);
    } finally {
      await page.close();
    }
  }, 600_000);
});
