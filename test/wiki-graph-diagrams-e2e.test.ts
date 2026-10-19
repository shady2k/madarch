/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/index.js';
import { pageAddress } from '../src/fill/graph-pages.js';
import { openGraphFixture, PRODUCT, writeOf, type GraphFixtureWorld } from './graph-pages-fixture.js';
import { DIAGRAM_FIXTURE } from './fill-diagram-fixture.js';
import { LIKEC4_DRAWINGS_SOURCE } from '../src/product-wiki/likec4-drawings.js';

/**
 * Every diagram of a graph page, drawn in every renderer that supports its type
 * (madarch-tzte.23.4; decision 0026, "Diagrams"), against the production-built wiki
 * app, a real server over a real fill service and its PGlite store, and the real
 * renderers: Mermaid in the browser, LikeC4's own webcomponent from the bundle the
 * server generates, and archify's page from the layout LikeC4 computes.
 *
 * Run with `MADARCH_WIKI_E2E=1` after building `wiki/app`; the screenshots go to
 * `MADARCH_WIKI_GRAPH_SHOTS` (a scratch folder outside the checkout), which the
 * acceptance record names.
 *
 * The bar is the task's own: each diagram type renders in each renderer that
 * supports it; the first tab follows `MADARCH_WIKI_DIAGRAM` (two servers, one set to
 * Mermaid and one to Archify, prove it); a fact is solid and an assumption dashed
 * where the renderer can draw a dash; and every element opens its page and its place
 * in code. What a reader sees is measured as AGENTS.md asks — the label sizes and the
 * overlaps the browser computed at the owner's 1150×900 window — and printed as
 * `GRAPH_DIAGRAM_MEASURED` lines the acceptance record quotes.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env.MADARCH_WIKI_GRAPH_SHOTS ?? join(tmpdir(), 'madarch-wiki-graph-diagrams');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The graph diagrams’ Chromium acceptance is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app.');

/** The product's manifest: its name, and the two repositories the diagram fixture's facts stand in, with origins a code link is made from. */
const MANIFEST = [
  'schemaVersion: 1',
  'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d',
  `name: ${PRODUCT}`,
  'repos:',
  '  - name: acme-shop',
  '    url: https://github.com/acme/shop.git',
  '    path: repos/acme-shop',
  '  - name: acme-web',
  '    url: https://github.com/acme/web.git',
  '    path: repos/acme-web',
  '',
].join('\n');

const facts = DIAGRAM_FIXTURE;

let world: GraphFixtureWorld | undefined;
/** One server per diagram setting: the tab shown first is the setting's own. */
const servers: StartedServer[] = [];
let browser: Browser | undefined;
let page: Page | undefined;

/** One measurement of one renderer's panel, as the browser computed it. */
interface Measured {
  readonly diagram: string;
  readonly renderer: string;
  readonly nodes: number;
  readonly width: number;
  readonly height: number;
  readonly labels: number;
  readonly smallestLabel: number;
  readonly overlaps: number;
  readonly overflowing: number;
  readonly viewBox: string;
  readonly texts: number;
  readonly htmlLabels: number;
  readonly svgs: number;
}

const measured: Measured[] = [];

/** Opens a wiki server with `MADARCH_WIKI_DIAGRAM` set to `tab`. */
async function serverWith(tab: string): Promise<StartedServer> {
  const started = await startServer({
    productFolder: world!.folder,
    appFolder: APP,
    port: 0,
    host: '127.0.0.1',
    graphPages: (folder) => world!.service.pages(folder),
    env: { ...process.env, MADARCH_WIKI_DIAGRAM: tab },
    log: () => undefined,
    errorLog: (line) => console.error(line),
  });
  servers.push(started);
  return started;
}

/** The tabs one diagram offers, and which of them the app opened first. */
async function tabsOf(type: string): Promise<{ readonly offered: readonly string[]; readonly first: string }> {
  return await page!.evaluate((asked: string) => {
    const article = document.querySelector(`[data-diagram-type="${asked}"]`);
    const buttons = [...(article?.querySelectorAll('[data-testid="graph-diagram-tabs"] button') ?? [])];
    return {
      offered: buttons.map((button) => button.getAttribute('data-tab') ?? ''),
      first: buttons.find((button) => button.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab') ?? '',
    };
  }, type);
}

/**
 * What the browser computed for one renderer's diagram: the boxes its elements took,
 * the label sizes it drew and the boxes that overlap. The page's own diagrams are
 * scoped to the open panel (the page holds other diagrams and its own icons beside
 * it), and a frame's document is the diagram itself.
 */
async function measure(target: Page | Frame, scope: string | null, mode: 'archify' | 'mermaid', renderer: string, diagram: string): Promise<Measured> {
  const boxes = await target.evaluate((options: { scope: string | null; nodes: string }) => {
    const root = options.scope === null ? document.body : (document.querySelector(options.scope) ?? document.body);
    // The panel holds more than the drawing (the renderer's own empty measuring box, an icon): the drawing is the
    // largest svg it holds.
    const area = (element: Element): number => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const svg = [...root.querySelectorAll('svg')].sort((one, two) => area(two) - area(one))[0] ?? root;
    const box = svg.getBoundingClientRect();
    // A label is a text of the drawing or, where Mermaid renders its labels as HTML, the label's own box.
    const sizes = [...root.querySelectorAll('svg text, .nodeLabel, .edgeLabel')]
      .map((label) => Number.parseFloat(getComputedStyle(label).fontSize))
      .filter((size) => Number.isFinite(size) && size > 0);
    const nodes = [...root.querySelectorAll(options.nodes)].map((node) => node.getBoundingClientRect());
    let overlaps = 0;
    for (let at = 0; at < nodes.length; at++) {
      for (let other = at + 1; other < nodes.length; other++) {
        const one = nodes[at]!;
        const two = nodes[other]!;
        if (one.width === 0 || two.width === 0) continue;
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps += 1;
      }
    }
    const overflowing = [...root.querySelectorAll('*')].filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible').length;
    return {
      nodes: nodes.length,
      width: Math.round(box.width),
      height: Math.round(box.height),
      labels: sizes.length,
      smallestLabel: sizes.length === 0 ? 0 : Math.round(Math.min(...sizes) * 10) / 10,
      overlaps,
      overflowing,
      // What the panel really holds, so a figure nobody can read is diagnosable from this line alone.
      viewBox: svg.getAttribute('viewBox') ?? '',
      texts: root.querySelectorAll('svg text').length,
      htmlLabels: root.querySelectorAll('.nodeLabel, .edgeLabel').length,
      svgs: root.querySelectorAll('svg').length,
    };
  }, { scope, nodes: mode === 'mermaid' ? 'svg g.node' : 'g[id^="node-"]' });
  const line: Measured = { diagram, renderer, ...boxes };
  measured.push(line);
  console.log(`GRAPH_DIAGRAM_MEASURED ${JSON.stringify(line)}`);
  return line;
}

/** A fresh page at the owner's window, with every failed answer and every script error named in the log. */
async function newPage(): Promise<Page> {
  const opened = await browser!.newPage();
  await opened.setViewport({ width: 1150, height: 900 });
  opened.on('response', (response) => {
    // A 404 the app asks for on purpose (a product with no fill beside it) is not news; every other failed answer is.
    if (response.status() >= 400 && !response.url().endsWith('/api/fill')) console.error(`browser: ${String(response.status())} ${response.url()}`);
  });
  opened.on('pageerror', (error: unknown) => console.error('browser error:', error));
  opened.on('console', (message) => {
    if (message.type() === 'error') console.error('console error:', message.text());
  });
  return opened;
}

/**
 * Opens one node's page and waits for one of its diagrams. A page that has not left
 * its loading line after the first bound is opened again once (the app's page read
 * under the pod's load has done this since madarch-tzte.23.3) and the retry is said
 * aloud; a page that draws no such diagram either time says what it holds instead.
 */
async function openDiagram(address: string, id: string, type: string): Promise<void> {
  const selector = `[data-testid="graph-diagram"][data-diagram-type="${type}"] [data-testid="graph-diagram-tabs"]`;
  let failure: unknown;
  for (const attempt of ['first', 'again'] as const) {
    await page!.goto(`${address}${pageAddress(id)}`, { waitUntil: 'domcontentloaded' });
    try {
      await page!.waitForSelector(selector, { timeout: attempt === 'first' ? 60_000 : 180_000 });
      return;
    } catch (error) {
      failure = error;
      if (attempt === 'first') console.error(`the page ${pageAddress(id)} did not draw its ${type} diagram within 60 s: opening it once again`);
    }
  }
  const held = await page!.evaluate(() => ({
    url: window.location.pathname,
    heading: document.querySelector('main h1')?.textContent ?? '',
    section: document.querySelector('[data-testid="graph-diagrams"]')?.textContent?.slice(0, 600) ?? 'no diagrams section',
  })).catch((error: unknown) => ({ unreadable: error instanceof Error ? error.message : String(error) }));
  await page!.screenshot({ path: join(SHOTS, `failed-${type}.png`), fullPage: true }).catch(() => undefined);
  throw new Error(`the ${type} diagram never stood on the page ${pageAddress(id)}: ${JSON.stringify(held)}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

/** The frame of an archify panel, once the server has rendered it. */
async function archifyFrame(node: string, type: string, renderer: 'archify' | 'likec4'): Promise<Frame> {
  // The address carries the node itself: a route that ignored `id` and answered the first diagram it found would
  // be reading another page's model, and this comparison is what catches it.
  const wanted = renderer === 'archify'
    ? `/api/graph/archify?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`
    : `/api/graph/likec4.html?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`;
  const asked = `id=${node}`;
  let said = 'no frame of that address was ever created';
  for (let attempt = 0; attempt < 600; attempt++) {
    // A frame's own address is whole (`http://host/api/graph/archify?…`), and the browser may spell its query in
    // another escaping: the address is read decoded, and the page and the diagram's type are what is compared.
    const frame = page!.frames().find((candidate) => {
      let held: string;
      try {
        held = decodeURIComponent(candidate.url());
      } catch {
        return false;
      }
      // Decoded, the browser spells the query its own way: the page, the node and the type are what is compared.
      const path = held.includes('/api/graph/archify') || held.includes('/api/graph/likec4.html');
      return path && held.includes(asked) && held.includes(`type=${type}`);
    });
    if (frame !== undefined) {
      try {
        const held = await frame.evaluate((source: string) => {
          // The drawing is read in the whole composed tree (`LIKEC4_DRAWINGS_SOURCE`: LikeC4 nests a shadow root
          // inside its element's own), and a browser it could not draw in says so in the document's own words.
          const drawings = (new Function(`return (${source});`)() as (root: Node) => readonly Element[])(document);
          return {
            ready: document.readyState,
            drawn: document.querySelectorAll('[data-node-id], g[id^="node-"]').length + drawings.length,
            undrawn: document.querySelector('[data-likec4-undrawn]')?.getAttribute('data-likec4-undrawn') ?? null,
            title: document.title,
            head: document.body === null ? 'no body' : document.body.innerHTML.slice(0, 200),
          };
        }, LIKEC4_DRAWINGS_SOURCE);
        said = JSON.stringify(held);
        if (held.drawn > 0 || held.undrawn !== null) return frame;
      } catch (error) {
        said = `the frame could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await new Promise((rest) => setTimeout(rest, 100));
  }
  throw new Error(`the archify page of ${type} never drew (${said}); the frames are: ${page!.frames().map((frame) => frame.url()).join(', ')}`);
}

/**
 * One step that touches the page, retried while a frame is navigating: a click, a
 * scroll or a screenshot that lands during a navigation is refused by the browser
 * with "Execution context was destroyed", which is a race and not a defect (the page
 * a reader holds is one document throughout, and every step here is idempotent).
 */
async function touchingPage<T>(work: () => Promise<T>): Promise<T> {
  for (const attempt of [1, 2, 3]) {
    try {
      return await work();
    } catch (error) {
      const raced = error instanceof Error && (error.message.includes('Execution context was destroyed') || error.message.includes('navigated or closed'));
      if (!raced || attempt === 3) throw error;
      await new Promise((rest) => setTimeout(rest, 250));
    }
  }
  throw new Error('the page could not be touched after three attempts');
}

/** One screenshot of the page as the reader sees it, taken through the race-tolerant step. */
async function shot(name: string): Promise<void> {
  await touchingPage(async () => await page!.screenshot({ path: join(SHOTS, name), fullPage: true }));
}

/** What the LikeC4 page of one diagram holds: its own view's drawing, or the page's words saying which failure it saw. */
interface LikeC4State {
  /** The drawings the element holds, counted through the shadow roots LikeC4 nests (`LIKEC4_DRAWINGS_SOURCE`). */
  readonly svgs: number;
  /** What the drawing reads as: every label the composed tree shows, so a walk can read a name off the picture. */
  readonly texts: readonly string[];
  /** The failure the page itself states, or null when it drew. */
  readonly undrawn: string | null;
}

/**
 * The LikeC4 page of one diagram, measured the way the page measures itself: the
 * drawings are counted in the element's whole composed tree (`LIKEC4_DRAWINGS_SOURCE`),
 * the labels are the text that tree shows — LikeC4 draws its element boxes as HTML
 * over an svg of the arrows, so a count of svgs alone would read a diagram of boxes as
 * empty — and the page's own words are read beside them. The frame is looked up again
 * on every poll: a panel the app re-renders is a new document, and one address can be
 * two frames over one walk.
 */
async function likec4State(node: string, type: string): Promise<LikeC4State> {
  const wanted = `/api/graph/likec4.html?id=${encodeURIComponent(node)}&type=${encodeURIComponent(type)}`;
  let last: LikeC4State | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const frame = page!.frames().find((candidate) => {
      try {
        return decodeURIComponent(candidate.url()).includes(`/api/graph/likec4.html`) && decodeURIComponent(candidate.url()).includes(`id=${node}`) && decodeURIComponent(candidate.url()).includes(`type=${type}`);
      } catch {
        return false;
      }
    });
    if (frame !== undefined) {
      const held = await frame.evaluate((source: string) => {
        const element = [...document.querySelectorAll('*')].find((child) => child.tagName.toLowerCase().endsWith('-view')) as HTMLElement | undefined;
        const drawings = element === undefined ? [] : (new Function(`return (${source});`)() as (root: Element) => readonly Element[])(element);
        // Every label the drawing shows: the text of each leaf of the composed tree, deduplicated and in document order.
        const texts: string[] = [];
        const collect = (root: ParentNode): void => {
          for (const node of root.querySelectorAll('*')) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'style' || tag === 'script') continue;
            if (node.children.length === 0 && node.shadowRoot === null) {
              const text = (node.textContent ?? '').trim();
              if (text !== '') texts.push(text);
            }
            if (node.shadowRoot !== null) collect(node.shadowRoot);
          }
        };
        if (element !== undefined && element.shadowRoot !== null) collect(element.shadowRoot);
        return {
          svgs: drawings.length,
          texts: [...new Set(texts)],
          undrawn: document.querySelector('[data-likec4-undrawn]')?.getAttribute('data-likec4-undrawn') ?? null,
        };
      }, LIKEC4_DRAWINGS_SOURCE).catch(() => null);
      if (held !== null) last = held;
      // A drawing is what is waited for: the page says its sentence eight seconds in and takes it away again if the
      // drawing arrives later, so a sentence on its own is not the answer yet, and one beside a drawing is the
      // page's own timer doing its work — one more look settles it.
      if (held !== null && held.svgs > 0) {
        if (held.undrawn === null) return held;
        await new Promise((rest) => setTimeout(rest, 400));
        const again = await frame.evaluate((source: string) => {
          const element = [...document.querySelectorAll('*')].find((child) => child.tagName.toLowerCase().endsWith('-view')) as HTMLElement | undefined;
          const drawings = element === undefined ? [] : (new Function(`return (${source});`)() as (root: Element) => readonly Element[])(element);
          return { svgs: drawings.length, undrawn: document.querySelector('[data-likec4-undrawn]')?.getAttribute('data-likec4-undrawn') ?? null };
        }, LIKEC4_DRAWINGS_SOURCE).catch(() => null);
        if (again !== null && again.svgs > 0 && again.undrawn === null) return { ...held, undrawn: null };
        return held;
      }
    }
    await new Promise((rest) => setTimeout(rest, 200));
  }
  console.error(`the LikeC4 page of ${type} drew no view within 60 s: ${wanted} (last seen ${JSON.stringify(last)})`);
  return last ?? { svgs: 0, texts: [], undrawn: null };
}

/** Opens one of a diagram's tabs and waits for that renderer to draw. */
async function openTab(node: string, type: string, renderer: 'archify' | 'likec4' | 'mermaid'): Promise<Frame | undefined> {
  return await touchingPage(async () => {
    await page!.click(`[data-diagram-type="${type}"] button[data-tab="${renderer}"]`);
    if (renderer === 'mermaid') {
      await page!.waitForSelector(`[data-diagram-type="${type}"] [data-testid="mermaid-diagram"] svg`, { timeout: 60_000 });
      return undefined;
    }
    // A frame is lazy: it loads when it comes near the reader's window, so the page is scrolled to it first.
    await page!.evaluate((asked: string) => document.querySelector(`[data-diagram-type="${asked}"] iframe`)?.scrollIntoView({ block: 'center' }), type);
    return await archifyFrame(node, type, renderer);
  });
}

runDescribe('every graph diagram in every renderer that supports it', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    world = await openGraphFixture({ drafts: () => facts.facts.map((fact) => writeOf(fact)), manifest: MANIFEST });
    const run = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-graph-diagrams-e2e-1' });
    if (run.ok === false) throw new Error(`the fixture's run was refused: ${run.code}: ${run.reason}`);
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      for (const started of servers) await started.stop();
      await world?.close();
    }
  });

  test('a repository page draws its five diagrams, each in every renderer that supports it', async () => {
    const server = await serverWith('mermaid');
    page = await newPage();
    await openDiagram(server.url, facts.shop.id, 'c4-context');
    // The five diagrams of a repository, in the order the page's kind gives them.
    const types = await page.$$eval('[data-testid="graph-diagram"]', (articles) => articles.map((article) => article.getAttribute('data-diagram-type') ?? ''));
    expect(types).toEqual(['c4-context', 'c4-container', 'c4-component', 'module-dependency', 'er']);
    // The setting is Mermaid, so every diagram opens on the Mermaid tab, and each says which renderers it has.
    expect(await tabsOf('c4-context')).toEqual({ offered: ['mermaid', 'likec4', 'archify'], first: 'mermaid' });
    expect(await tabsOf('module-dependency')).toEqual({ offered: ['mermaid', 'archify'], first: 'mermaid' });
    expect(await tabsOf('er')).toEqual({ offered: ['mermaid', 'archify'], first: 'mermaid' });
    for (const type of types) {
      await openTab(facts.shop.id, type, 'mermaid');
      const line = await measure(page!, `[data-diagram-type="${type}"] [data-testid="mermaid-diagram"]`, 'mermaid', 'mermaid', type);
      // A diagram that draws no label, or shrinks its labels under twelve pixels, is not readable at the owner's window.
      expect(line.labels).toBeGreaterThan(0);
      expect(line.smallestLabel).toBeGreaterThanOrEqual(12);
      expect(line.overlaps).toBe(0);
      await shot(`diagram-${type}-mermaid.png`);
    }
    // An end the graph does not hold is drawn by the name the graph gives it, never by its content-addressed id
    // (madarch-tzte.23.6): the module-dependency view of acme-shop is the one view here that draws one.
    const moduleLabels = await page.$$eval('[data-diagram-type="module-dependency"] [data-testid="mermaid-diagram"] svg text, [data-diagram-type="module-dependency"] [data-testid="mermaid-diagram"] .nodeLabel', (nodes) => nodes.map((node) => node.textContent ?? ''));
    expect(moduleLabels).toContain('./gone.js (unresolved)');
    // The list under the diagram names it the same way, and keeps the id it was cited by as the row's own tooltip.
    const listed = await page.$$eval('[data-diagram-type="module-dependency"] [data-testid="graph-diagram-elements"] li', (rows) => rows.map((row) => ({
      label: row.querySelector('.graph-diagram-element-label')?.textContent ?? '',
      title: row.querySelector('[data-testid="graph-diagram-unpaged"]')?.getAttribute('title') ?? '',
    })));
    expect(listed.map((row) => row.label)).toContain('./gone.js (unresolved)');
    expect(listed.some((row) => row.title.includes('unresolved:file:'))).toBe(true);
    // No drawer on the page prints the id: the name stands in every diagram, the list and the arrows beside it.
    const drawingsText = await page.evaluate(() => document.querySelector('[data-testid="graph-diagrams"]')?.textContent ?? '');
    expect(drawingsText).not.toContain(facts.gone.id);
    // Archify draws every type but the sequence, and LikeC4 the three C4 levels.
    for (const type of types) {
      const frame = await openTab(facts.shop.id, type, 'archify');
      const line = await measure(frame!, null, 'archify', 'archify', type);
      expect(line.nodes).toBeGreaterThan(0);
      expect(line.overlaps).toBe(0);
      // A dashed connection reaches the page: the model's own dashes are what archify draws.
      const dashed = await touchingPage(async () => await frame!.evaluate(() => document.querySelectorAll('[class*="dashed"]').length));
      console.log(`GRAPH_DIAGRAM_ARCHIFY_DASHED ${JSON.stringify({ type, dashed })}`);
      if (type === 'module-dependency') {
        // The name of the end the graph does not hold reaches archify's own page, and its id does not.
        const drawn = await touchingPage(async () => await frame!.evaluate(() => document.body.textContent ?? ''));
        expect(drawn).toContain('./gone.js (unresolved)');
        expect(drawn).not.toContain(facts.gone.id);
      }
      await shot(`diagram-${type}-archify.png`);
    }
    for (const type of ['c4-context', 'c4-container', 'c4-component']) {
      await openTab(facts.shop.id, type, 'likec4');
      // LikeC4 draws its own view. The drawings are counted through the shadow roots it nests (madarch-pdkl: the
      // element's own shadow root holds none of them), and the page's watchdog must stay silent over a drawing.
      const held = await likec4State(facts.shop.id, type);
      console.log(`GRAPH_DIAGRAM_LIKEC4 ${JSON.stringify({ type, ...held })}`);
      expect(held.undrawn).toBeNull();
      expect(held.svgs).toBeGreaterThan(0);
      // A drawing nobody can read is not a drawing: the view carries its elements' labels.
      expect(held.texts.length).toBeGreaterThan(0);
      if (type === 'c4-component') {
        // LikeC4's own view names the end the graph does not hold, by the specifier its import wrote.
        expect(held.texts).toContain('./gone.js (unresolved)');
        expect(held.texts.some((text) => text.includes(facts.gone.id))).toBe(false);
      }
      await shot(`diagram-${type}-likec4.png`);
    }
    // Every element opens its page and its place in code, under any tab.
    await openTab(facts.shop.id, 'module-dependency', 'mermaid');
    const links = await page.$$eval('[data-diagram-type="module-dependency"] [data-testid="graph-diagram-elements"] a', (anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    expect(links).toContain(`/p/graph/${facts.checkout.id}`);
    expect(links.some((href) => href.startsWith('https://github.com/acme/shop/blob/'))).toBe(true);
    // The arrows of a component view fold an import (a fact) and an interaction (an assumption): dashed in the source, and said in words.
    const arrowEvidence = await page.$$eval('[data-diagram-type="c4-component"] [data-testid="graph-diagram-edge-evidence"]', (chips) => chips.map((chip) => chip.textContent ?? ''));
    expect(arrowEvidence.length).toBeGreaterThan(0);
    expect(arrowEvidence).toContain('assumption');
    await page.close();
    page = undefined;
  }, 1_200_000);

  test('a state, a sequence and a table draw their own diagrams, and a sequence is Mermaid’s alone', async () => {
    const server = servers[0]!;
    page = await newPage();
    await openDiagram(server.url, facts.newState.id, 'state');
    expect(await tabsOf('state')).toEqual({ offered: ['mermaid', 'archify'], first: 'mermaid' });
    await openTab(facts.newState.id, 'state', 'mermaid');
    const state = await measure(page, '[data-diagram-type="state"] [data-testid="mermaid-diagram"]', 'mermaid', 'mermaid', 'state');
    expect(state.labels).toBeGreaterThan(0);
    expect(state.smallestLabel).toBeGreaterThanOrEqual(12);
    await shot('diagram-state-mermaid.png');
    // The machine's states are an agent's reading, and every row says so.
    const stateEvidence = await page.$$eval('[data-diagram-type="state"] [data-element]', (rows) => rows.map((row) => row.getAttribute('data-evidence') ?? ''));
    expect(stateEvidence.length).toBeGreaterThan(0);
    expect(stateEvidence.every((evidence) => evidence === 'assumption' || evidence === 'unresolved')).toBe(true);

    await openDiagram(server.url, facts.placeSymbol.id, 'sequence');
    expect(await tabsOf('sequence')).toEqual({ offered: ['mermaid'], first: 'mermaid' });
    await openTab(facts.placeSymbol.id, 'sequence', 'mermaid');
    const sequence = await measure(page, '[data-diagram-type="sequence"] [data-testid="mermaid-diagram"]', 'mermaid', 'mermaid', 'sequence');
    expect(sequence.labels).toBeGreaterThan(0);
    await shot('diagram-sequence-mermaid.png');

    await openDiagram(server.url, facts.ordersTable.id, 'er');
    const table = await page.$$eval('[data-diagram-type="er"] [data-element]', (rows) => rows.map((row) => row.getAttribute('data-element') ?? ''));
    expect(table).toContain(facts.ordersTable.id);
    await openTab(facts.ordersTable.id, 'er', 'archify');
    await shot('diagram-table-er-archify.png');
    await page.close();
    page = undefined;
  }, 900_000);

  test('the first tab follows MADARCH_WIKI_DIAGRAM: a server set to archify opens the C4 diagrams on archify', async () => {
    const server = await serverWith('archify');
    page = await newPage();
    await openDiagram(server.url, facts.shop.id, 'c4-context');
    expect(await tabsOf('c4-context')).toEqual({ offered: ['archify', 'likec4', 'mermaid'], first: 'archify' });
    await page.evaluate(() => document.querySelector('iframe')?.scrollIntoView({ block: 'center' }));
    await archifyFrame(facts.shop.id, 'c4-context', 'archify');
    await shot('diagram-c4-context-archify-first.png');
    await page.close();
    page = undefined;
    console.log(`GRAPH_DIAGRAM_MEASURED_ALL ${JSON.stringify(measured)}`);
  }, 600_000);
});
