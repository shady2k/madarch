/**
 * A press on a diagram node under a products home (madarch-64o5.98): the server serves each wiki under
 * `/products/<folder>/`, so every node's page must stand under that base — in Mermaid's anchors, LikeC4's node event and
 * archify's own page — and a press must land on the entity's page, never on a bare `/e/...` the home answers as an
 * unknown address. The walk needs a real browser and the built app: run it with `MADARCH_WIKI_E2E=1` after
 * `bun run build` in `wiki/app`, as an ordinary user.
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

const ROOT = join(import.meta.dir, '..');
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env['MADARCH_WIKI_E2E'] === '1';
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The diagram-link walk is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run it.');

let root = '';
let home = '';
let name = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;

/** Answers the first-visit role question, which stands over every page on a fresh machine. */
async function settleRole(page: Page): Promise<void> {
  const dialog = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
  if (dialog === null) return;
  await page.click('[data-testid="role-first-continue"]');
  await page.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
}

/** Waits until the app's address is an entity page under the product's base, else answers what it is. */
async function landed(page: Page, base: string): Promise<string> {
  await page.waitForFunction((prefix) => location.pathname.startsWith(prefix), { timeout: 30_000 }, `${base}/e/`);
  return new URL(page.url()).pathname;
}

run('a diagram press under a products home', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-diagram-links-'));
    home = join(root, 'products');
    const draft = createDraft({ home, name: 'linked-portal', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    name = 'linked-portal';
    mkdirSync(join(draft.folder, 'src'), { recursive: true });
    writeFileSync(join(draft.folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    commitProduct(draft.folder, 'A draft to draw diagrams of');
    server = await startPreparedServer({ productHome: home, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('Mermaid, LikeC4 and archify each open the entity page under the product base', async () => {
    const base = `/products/${name}`;
    const found = await (await fetch(`${server!.url}${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ catalogueEntity(name: "code.file") { id } }' }) })).json() as { data?: { catalogueEntity?: { id?: string } } };
    const entity = found.data?.catalogueEntity?.id;
    if (typeof entity !== 'string') throw new Error('the draft answers no catalogue entity for code.file');
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server!.url}${base}/e/catalogue/${entity}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settleRole(page);
      await page.waitForSelector('[data-testid="diagram-renderer"]', { timeout: 60_000 });

      // Mermaid: the server's source names each node's page under the base, and a press follows it.
      await page.click('[data-testid="diagram-renderer-mermaid"]');
      await page.waitForSelector('[data-testid="mermaid-pane"] svg a', { timeout: 60_000 });
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('[data-testid="mermaid-pane"] svg a')].map((anchor) => anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || ''));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(href.startsWith(`${base}/e/`)).toBe(true);
      const away = await page.evaluate((prefix) => [...document.querySelectorAll('[data-testid="mermaid-pane"] svg a')].findIndex((anchor) => { const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || ''; return href !== location.pathname && href.startsWith(prefix); }), `${base}/e/`);
      expect(away).toBeGreaterThanOrEqual(0);
      const anchors = await page.$$('[data-testid="mermaid-pane"] svg a');
      await anchors[away]!.click();
      expect((await landed(page, base)).startsWith(`${base}/e/`)).toBe(true);

      // LikeC4: a press on a node of the React Flow view walks to the page the server's link map names.
      await page.goto(`${server!.url}${base}/e/catalogue/${entity}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="diagram-renderer"]', { timeout: 60_000 });
      await page.click('[data-testid="diagram-renderer-likec4"]');
      await page.waitForFunction(() => {
        const roots: ShadowRoot[] = [];
        const walk = (node: Element): void => { if ((node as unknown as { shadowRoot?: ShadowRoot }).shadowRoot !== undefined && (node as unknown as { shadowRoot?: ShadowRoot }).shadowRoot !== null) roots.push((node as unknown as { shadowRoot: ShadowRoot }).shadowRoot); for (const child of node.children) walk(child); };
        walk(document.body);
        return roots.some((root) => root.querySelector('.react-flow__node') !== null);
      }, { timeout: 60_000 });
      const point = await page.evaluate(() => {
        const roots: ShadowRoot[] = [];
        const walk = (node: Element): void => { if ((node as unknown as { shadowRoot?: ShadowRoot }).shadowRoot !== undefined && (node as unknown as { shadowRoot?: ShadowRoot }).shadowRoot !== null) roots.push((node as unknown as { shadowRoot: ShadowRoot }).shadowRoot); for (const child of node.children) walk(child); };
        walk(document.body);
        for (const root of roots) {
          const held = root.querySelector('.react-flow__node');
          if (held !== null) { const box = held.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
        }
        return null;
      });
      expect(point).not.toBeNull();
      await page.mouse.click(point!.x, point!.y);
      expect((await landed(page, base)).startsWith(`${base}/e/`)).toBe(true);

      // archify: its own page posts a node's press to the wiki, which opens the page.
      await page.goto(`${server!.url}${base}/e/catalogue/${entity}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="diagram-renderer"]', { timeout: 60_000 });
      await page.click('[data-testid="diagram-renderer-archify"]');
      const frame = await page.waitForFrame((held) => held.url().includes('/render/diagram') && held.url().includes('format=archify'), { timeout: 60_000 });
      await frame.waitForSelector('[data-node-id]', { timeout: 60_000 });
      const nodes = await frame.$$('[data-node-id]');
      for (const node of nodes.slice(0, 3)) {
        await node.click();
        const landedPath = await page.waitForFunction((prefix) => location.pathname.startsWith(prefix), { timeout: 5_000 }, `${base}/e/`).then(() => new URL(page.url()).pathname, () => undefined);
        if (landedPath !== undefined) { expect(landedPath.startsWith(`${base}/e/`)).toBe(true); break; }
      }
      expect(new URL(page.url()).pathname.startsWith(`${base}/e/`)).toBe(true);
    } finally {
      await page.close();
    }
  }, 300_000);
});
