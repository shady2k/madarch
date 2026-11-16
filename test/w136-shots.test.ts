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

async function fill(kind: string): Promise<{ state: string; message?: string }> {
  const pressed = await fetch(`${base}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: [kind], pluginsOnly: true }) });
  if (pressed.status !== 202) throw new Error(`fill refused: ${await pressed.text()}`);
  for (let at = 0; at < 120; at += 1) {
    const status = (await (await fetch(`${base}api/status`)).json()) as { fill: { state: string; message?: string } };
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
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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
    const failed = await fill('code.file').catch((error: unknown) => ({ state: 'refused', message: String(error) }));
    // alpha's fill succeeds, and a new commit to its repository leaves the graph holding part of it.
    const done = await fill('code.file');
    if (done.state !== 'done') throw new Error(`alpha fill ${done.state}: ${done.message ?? ''}`);
    writeFileSync(join(alpha, 'src', 'later.ts'), 'export const later = 1;\n');
    commitProduct(alpha, 'One more file after the fill');

    const page: Page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const settle = async (ms = 1200): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)); };
    const shot = async (name: string): Promise<void> => {
      for (const dark of [false, true]) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
        for (const width of [1440, 390]) {
          await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
          await settle(400);
          await page.screenshot({ path: join(OUT, `${name}-${String(width)}-${dark ? 'dark' : 'light'}.png`), fullPage: false });
        }
      }
    };
    const open = async (path: string): Promise<void> => {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle0' });
      await settle();
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
      await fetch(`${base}api/fill-selected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['code.file'], pluginsOnly: true }) }).catch(() => undefined);
      await open('products/alpha/');
      await settle(300);
      await shot('home-live');
      for (let at = 0; at < 120; at += 1) {
        const status = (await (await fetch(`${base}api/status`)).json()) as { fill: { state: string } };
        if (['done', 'failed', 'stopped'].includes(status.fill.state)) break;
        await Bun.sleep(500);
      }
      const after = (await (await fetch(`${base}api/status`)).json()) as { incomplete?: boolean };
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
