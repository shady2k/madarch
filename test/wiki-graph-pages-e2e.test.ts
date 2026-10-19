/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/index.js';
import { pageAddress } from '../src/fill/graph-pages.js';
import { writeOf, graphFacts, LATER_COMMIT, openGraphFixture, PRODUCT, type GraphFixtureFacts, type GraphFixtureWorld } from './graph-pages-fixture.js';

/**
 * The graph's pages as a reader sees them (madarch-tzte.23.3; decision 0026,
 * "Pages"), against the production-built wiki app and a real server over a real
 * fill service and its PGlite store. Run with `MADARCH_WIKI_E2E=1` after building
 * `wiki/app`; the screenshots go to `MADARCH_WIKI_GRAPH_SHOTS` (a scratch folder
 * outside the checkout), which the acceptance record names.
 *
 * The bar is the task's own: the navigation lists the graph's page-worthy nodes, a
 * node's page renders the server's page model the way a reader sees it (facts with
 * links into code, relations as links to other pages, coverage, questions,
 * assumptions apart, drafts marked), and a page appears in the browser as facts
 * arrive — without a reload — when a unit publishes.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env.MADARCH_WIKI_GRAPH_SHOTS ?? join(tmpdir(), 'madarch-wiki-graph-pages');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The graph pages’ Chromium acceptance is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app.');

let world: GraphFixtureWorld | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let facts: GraphFixtureFacts;
runDescribe('the graph’s pages in a browser', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    facts = graphFacts();
    // The first run publishes the two symbols and their call: no module has a page yet.
    let published = [facts.placed, facts.total, facts.calls];
    world = await openGraphFixture({ drafts: () => published.map((fact) => writeOf(fact)) });
    const first = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-graph-pages-e2e-1' });
    if (first.ok === false) throw new Error(`the fixture's first run was refused: ${first.code}: ${first.reason}`);
    server = await startServer({
      productFolder: world.folder,
      appFolder: APP,
      port: 0,
      host: '127.0.0.1',
      graphPages: (folder) => world!.service.pages(folder),
      log: () => undefined,
      errorLog: (line) => console.error(line),
    });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // The product keeps one document beside the graph: the document pages must work
    // beside the graph pages (the task's own bar), so the reader opens one too.
    mkdirSync(join(world.folder, 'docs'), { recursive: true });
    writeFileSync(join(world.folder, 'docs', 'vision.md'), '# Vision\n\nThe product in its own words.\n');
    // The next run adds the module and everything a page shows about it: what the
    // reader's browser must show without a reload.
    published = [facts.module, facts.placed, facts.total, facts.holds, facts.calls, facts.claim, facts.rule, facts.coverage, facts.question, facts.endpoint, facts.variable, facts.provides, facts.consumes, facts.binds];
  }, 180_000);

  afterAll(async () => {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      try {
        await server?.stop();
      } finally {
        await world?.close();
      }
    }
  });

  test('the navigation lists the graph’s nodes and one node’s page reads as a page', async () => {
    page = await browser!.newPage();
    await page.setViewport({ width: 1150, height: 900 });
    const url = server!.url;
    // Every answer the page gets that is not a success is named: a 404 in the browser's
    // own log would otherwise be a mystery nobody reads.
    page.on('response', (response) => {
      if (response.status() >= 400) console.error(`browser: ${response.status()} ${response.url()}`);
    });
    page.on('pageerror', (error: unknown) => console.error('browser error:', error));
    await page.goto(`${url}/p/graph`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('[data-testid="graph-index"]', { timeout: 15_000 });
    } catch (error: unknown) {
      console.error('BODY', (await page.evaluate(() => document.body.innerHTML)).slice(0, 3000));
      console.error('URL', page.url());
      throw error;
    }
    // The navigation lists the page-worthy nodes the server answered, by kind.
    const navNodes = await page.$$eval('[data-testid="graph-nav"] a[data-graph-node]', (links) => links.map((link) => link.getAttribute('data-graph-node')));
    expect(navNodes.length).toBe(2);
    expect(navNodes).toContain(facts.placed.id);
    expect(navNodes).toContain(facts.total.id);
    await page.screenshot({ path: join(SHOTS, 'graph-index.png'), fullPage: true });

    // One node's page, opened from the navigation: the browser's own click, no reload.
    await page.click(`[data-testid="graph-nav"] a[data-graph-node="${facts.placed.id}"]`);
    await page.waitForSelector('[data-testid="graph-node"]', { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe(pageAddress(facts.placed.id));
    const title = await page.$eval('main#graph-node h1', (heading) => heading.textContent);
    expect(title).toBe('acme-shop:src/checkout.ts#checkout.place');
    // The relations section names the edge the graph holds, and links the node at its other end.
    const relations = await page.$$eval('[data-testid="graph-relations"] [data-edge]', (rows) => rows.length);
    expect(relations).toBeGreaterThan(0);
    // What the reader really sees: the sizes the browser computed and the boxes the
    // elements took, so a page that renders as a wall of unreadable text or with
    // overlapping rows is caught here and not by the eye alone (AGENTS.md, "Views are
    // accepted by rendering every page the way a reader sees it").
    const measured = await page.evaluate(() => {
      const box = (selector: string): { width: number; height: number } | null => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const fontSize = (selector: string): number => {
        const element = document.querySelector(selector);
        return element === null ? 0 : Number.parseFloat(getComputedStyle(element).fontSize);
      };
      const rows = [...document.querySelectorAll('main#graph-node .graph-fact, main#graph-node .graph-relation, main#graph-node .graph-question, main#graph-node .graph-draft')];
      let overlaps = 0;
      const boxes = rows.map((row) => row.getBoundingClientRect());
      for (let at = 1; at < boxes.length; at++) {
        const previous = boxes[at - 1]!;
        const held = boxes[at]!;
        // Two rows of one list overlapping would be text on text.
        if (held.top < previous.bottom - 0.5 && held.left === previous.left) overlaps += 1;
      }
      const overflow = [...document.querySelectorAll('main#graph-node *')].filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible').length;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nav: box('#app-nav'),
        content: box('main#graph-node'),
        titleFont: fontSize('main#graph-node h1'),
        bodyFont: fontSize('main#graph-node .graph-fact-label'),
        chipFont: fontSize('main#graph-node .graph-chip'),
        rows: rows.length,
        overlaps,
        overflowing: overflow,
        pageHeight: Math.round(document.querySelector('main#graph-node')?.getBoundingClientRect().height ?? 0),
      };
    });
    // The measurements the reader's page must hold, as the acceptance record states them:
    // the page's own figures at the owner's 1150×900 window.
    expect(measured.titleFont).toBe(36);
    expect(measured.bodyFont).toBe(18);
    expect(measured.chipFont).toBe(14);
    expect(measured.overlaps).toBe(0);
    expect(measured.overflowing).toBe(0);
    expect(measured.content?.width).toBe(794);
    expect(measured.nav?.width).toBe(260);
    expect(measured.content?.width ?? 0).toBeLessThanOrEqual(measured.viewport.width);
    console.log(`GRAPH_PAGE_MEASURED ${JSON.stringify(measured)}`);
    await page.screenshot({ path: join(SHOTS, 'graph-node.png'), fullPage: true });
    await page.close();
    page = undefined;
  }, 120_000);

  test('a unit that publishes adds its node’s page to the browser without a reload', async () => {
    page = await browser!.newPage();
    await page.setViewport({ width: 1150, height: 900 });
    const url = server!.url;
    await page.goto(`${url}/p/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="graph-index"]', { timeout: 15_000 });
    const before = await page.$$eval('[data-testid="graph-nav"] a[data-graph-node]', (links) => links.map((link) => link.getAttribute('data-graph-node')));
    expect(before).not.toContain(facts.module.id);
    // The page the reader holds is marked, so a reload would be visible.
    await page.evaluate(() => { (window as unknown as { __noReload?: boolean }).__noReload = true; });

    // The publication: the stage's input moves, so its unit runs again and this time holds the module.
    world!.repin(LATER_COMMIT);
    const started = Date.now();
    const run = await world!.service.run({ product: { name: PRODUCT, folder: world!.folder }, runId: 'run-graph-pages-e2e-2' });
    if (run.ok === false) throw new Error(`the fixture's second run was refused: ${run.code}: ${run.reason}`);

    // The node joins the navigation and the index with no reload: the live channel woke the app.
    await page.waitForFunction(
      (id: string) => document.querySelector(`[data-testid="graph-nav"] a[data-graph-node="${id}"]`) !== null,
      { timeout: 10_000, polling: 100 },
      facts.module.id,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(10_000);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true)).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'graph-index-after-publish.png'), fullPage: true });

    // Its page opens, and it holds everything the publication wrote: the module's own
    // fact, the claim and the rule about it, the edges that name it, the coverage of its
    // scope, the open question and the assumption kept apart from the facts.
    await page.click(`[data-testid="graph-nav"] a[data-graph-node="${facts.module.id}"]`);
    await page.waitForSelector('[data-testid="graph-node"]', { timeout: 15_000 });
    const moduleTitle = await page.$eval('main#graph-node h1', (heading) => heading.textContent);
    expect(moduleTitle).toBe('checkout');
    const shown = await page.evaluate(() => ({
      facts: document.querySelectorAll('[data-testid="graph-facts"] [data-fact]').length,
      assumptions: document.querySelectorAll('[data-testid="graph-assumptions"] [data-fact]').length,
      relations: document.querySelectorAll('[data-testid="graph-relations"] [data-edge]').length,
      coverage: document.querySelectorAll('[data-testid="graph-coverage"] [data-scope]').length,
      questions: document.querySelectorAll('[data-testid="graph-questions"] [data-question]').length,
      places: document.querySelectorAll('[data-testid="graph-place"]').length,
      linkedPages: document.querySelectorAll('[data-testid="graph-relations"] a[href^="/p/graph/"]').length,
      relationKinds: [...document.querySelectorAll('[data-testid="graph-relations"] [data-edge-kind]')].map((row) => row.getAttribute('data-edge-kind') ?? ''),
      diagramsSlot: document.querySelector('[data-testid="graph-diagrams"]') !== null,
      inferredInFacts: document.querySelectorAll('[data-testid="graph-facts"] [data-layer="inferred"]').length,
      assertedInAssumptions: [...document.querySelectorAll('[data-testid="graph-assumptions"] [data-fact]')].filter((row) => row.getAttribute('data-layer') !== 'inferred').length,
    }));
    // The fixture's claim and rule are an agent's reading (`layer: inferred`), so they are
    // assumptions; the module's own fact is the one the graph asserts. A fact never stands
    // in both lists: that is what "assumptions shown apart from facts" means.
    expect(shown.facts).toBe(1);
    expect(shown.assumptions).toBe(2);
    expect(shown.inferredInFacts).toBe(0);
    expect(shown.assertedInAssumptions).toBe(0);
    // The module's own edges: a `provides` to the endpoint's node (the contract resolved to
    // it), a `contains` to the symbol it holds, and the symbol's `call` and `consumes`.
    expect(shown.relations).toBe(2);
    expect(shown.relationKinds).toEqual(['contains', 'provides']);
    expect(shown.coverage).toBe(1);
    expect(shown.questions).toBe(1);
    expect(shown.places).toBe(6);
    expect(shown.linkedPages).toBe(2);
    expect(shown.diagramsSlot).toBe(true);
    console.log(`GRAPH_MODULE_PAGE ${JSON.stringify(shown)}`);
    await page.screenshot({ path: join(SHOTS, 'graph-module-page.png'), fullPage: true });

    // The document pages keep working beside the graph pages: the product's own
    // Markdown opens and reads, with the graph's section still in the navigation.
    await page.goto(`${url}/p/docs/vision.md`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main#page .reading > h1', { timeout: 15_000 });
    expect(await page.$eval('main#page .reading > h1', (heading) => heading.textContent)).toBe('Vision');
    expect(await page.$('[data-testid="graph-nav"]')).not.toBeNull();
    await page.screenshot({ path: join(SHOTS, 'document-beside-graph.png'), fullPage: true });
    await page.close();
    page = undefined;
  }, 180_000);
});
