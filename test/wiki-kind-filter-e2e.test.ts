/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer, { type Browser } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { fillStatePaths, type FillRun } from '../src/product/fill-runtime.js';

const APP = new URL('../wiki/app/dist', import.meta.url).pathname;
const runDescribe = process.env.MADARCH_WIKI_E2E === '1' ? describe.serial : describe.skip;
/** A served shell; scripted requests supply records without a fill or an agent. */
function buildProduct(): { root: string; product: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-kind-filter-e2e-'));
  const product = join(root, 'Longpage');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5c2f0f4e-6f0b-4a9e-9d3a-2f1f3c4b5a60',
    'name: Longpage',
    'repos:',
    '  - name: sample',
    '    url: https://example.invalid/sample.git',
    '',
  ].join('\n'));
  writeFileSync(join(product, 'README.md'), '# Longpage\n\nA kind filter fixture.\n');
  const repo = join(product, 'repos', 'sample');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Sample repository\n\nRepository content.\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '-A'], ['commit', '--quiet', '-m', 'Fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) throw new Error(`${repo}:1: git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return { root, product, path: '/kind/doc.term' };
}


runDescribe('kind filter stays in place (built app and Chromium)', () => {
  let fixture: ReturnType<typeof buildProduct> | undefined;
  let previousHome: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`${APP}/index.html:1: built wiki app is missing`);
    fixture = buildProduct();
    // The reader's role lives in madarch's own settings, not in the product: the walk answers it in a home of its
    // own, so the first-run role card does not stand over the page.
    const madarchHome = join(fixture.root, 'madarch-home');
    mkdirSync(madarchHome, { recursive: true });
    writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    previousHome = process.env.MADARCH_HOME;
    process.env.MADARCH_HOME = madarchHome;
    // A product no run has touched opens on the first-fill wizard instead of the shell; a stopped run is
    // what a reader who has been here before has, and the shell then stands.
    const fillPaths = fillStatePaths(fixture.product);
    mkdirSync(join(fillPaths.root, 'units'), { recursive: true });
    writeFileSync(fillPaths.run, JSON.stringify({ schemaVersion: 1, id: 'e2e-menu-height', productSnapshot: { repository: 'Longpage', defaultBranch: 'main', commit: 'fixture', registryHash: 'fixture' }, agentBranch: 'main', status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies FillRun));
    server = await startPreparedServer({
      productFolder: fixture.product,
      appFolder: APP,
      port: 0,
      host: '127.0.0.1',
      log: () => {},
      errorLog: (line) => console.error(line),
    });
    browser = await puppeteer.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }, 120000);


  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (previousHome === undefined) delete process.env.MADARCH_HOME; else process.env.MADARCH_HOME = previousHome;
    if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
  }, 60000);
  for (const width of [1150, 390]) for (const term of ['Term', 'missing']) test(`typing ${term} and erasing at ${width}px keeps records and the filter steady`, async () => {
    const page = await browser!.newPage();
    try {
      page.on('pageerror', (error) => console.error('browser:', error));
      page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
      await page.setViewport({ width, height: 900 });
      await page.evaluateOnNewDocument(() => localStorage.setItem('madarch-wiki-language', 'en'));
      const requests: string[] = [];
      let release: (() => void) | undefined;
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = new URL(request.url());
        const kind = { kind: 'doc.term', subgroup: '', count: 80, page: true, filled: true, state: 'filled', origins: ['plugin'], descriptions: { en: 'A fixture term.' }, fields: Array.from({ length: 35 }, (_, i) => ({ name: `field${i}`, type: 'text' })) };
        const json = (body: unknown) => { void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); };
        if (url.pathname.endsWith('/api/status')) { json({ product: { name: 'Longpage', id: 'fixture' }, manifest: 'ok', language: 'en', findingCount: 0, kinds: [kind], groups: [], repositories: [], filled: true, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, chosenAgent: null, home: null }); return; }
        if (url.pathname.endsWith('/api/catalog')) { json(url.searchParams.has('kind') ? kind : { product: { name: 'Longpage', id: 'fixture' }, language: 'en', kinds: [kind], groups: [], findings: [] }); return; }
        if (url.pathname.endsWith('/api/views')) { json({ renderer: 'mermaid', views: [] }); return; }
        if (!url.pathname.endsWith('/api/entities')) { void request.continue(); return; }
        const query = url.searchParams.get('q') ?? '';
        if (url.searchParams.has('after')) { json({ kind: 'doc.term', rows: [{ id: 'doc.term:appended', kind: 'doc.term', label: 'Appended term', href: '/e/doc.term%3Aappended' }], total: 81, next: 'page-3' }); return; }
        requests.push(query);
        const rows = Array.from({ length: query === '' ? 80 : query === 'missing' ? 0 : 1 }, (_, i) => ({ id: `doc.term:${i}`, kind: 'doc.term', label: `Term ${i}`, href: `/e/doc.term%3A${i}` }));
        const answer = () => { void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'doc.term', rows, total: rows.length, next: query === '' ? 'page-2' : null }) }); };
        if (requests.length > 1) release = answer; else answer();
      });
      await page.goto(`${server!.url}/kind/doc.term`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-entity="doc.term:79"]', { timeout: 15000 }).catch(async (error) => { console.error(await page.evaluate(() => document.body.innerText), requests); throw error; });
      await page.click('[data-testid=kind-more]');
      await page.waitForSelector('[data-entity="doc.term:appended"]');
      await page.evaluate(() => {
        const input = document.querySelector('[data-testid=kind-filter]')!;
        input.scrollIntoView({ block: 'start' });
        // Keep the filter below the shell's standing header, in the actual scroll owner.
        let owner = input.parentElement;
        while (owner && !/(auto|scroll)/.test(getComputedStyle(owner).overflowY)) owner = owner.parentElement;
        if (owner) owner.scrollTop -= 160; else window.scrollBy(0, -160);
      });
      const position = () => page.$eval('[data-testid=kind-filter]', (node) => node.getBoundingClientRect().top);
      const before = await position();
      expect(before, 'filter is visible after scrolling past its declaration').toBeGreaterThan(0);
      expect(before).toBeLessThan(400);
      const baseline = requests.length;
      await page.type('[data-testid=kind-filter]', term, { delay: 40 });
      await new Promise((done) => setTimeout(done, 80));
      expect(requests.length, 'no read while typing or before the pause').toBe(baseline);
      await new Promise((done) => setTimeout(done, 250));
      expect(requests.slice(baseline)).toEqual([term]);
      expect(await page.$('[data-entity="doc.term:79"]'), 'old rows remain pending').not.toBeNull();
      expect(await page.$('[data-testid=kind-loading]'), 'no loading flash').toBeNull();
      expect(await page.$('[data-entity="doc.term:appended"]'), 'appended rows remain pending').not.toBeNull();
      expect(await page.$eval('[data-testid=kind-more]', (node) => (node as HTMLButtonElement).disabled), 'cannot page with the new query before it resolves').toBe(true);
      await page.evaluate(() => {
        const observations: { total: string; appended: boolean }[] = [];
        (window as unknown as { filterObservations: typeof observations }).filterObservations = observations;
        new MutationObserver(() => observations.push({ total: document.querySelector('[data-testid=kind-total]')?.textContent ?? '', appended: document.querySelector('[data-entity="doc.term:appended"]') !== null })).observe(document.querySelector('[data-testid=kind-page]')!, { subtree: true, childList: true, characterData: true });
      });
      release!();
      await page.waitForFunction((total) => (document.querySelector('[data-testid=kind-total]')?.textContent ?? '').includes(total), { timeout: 10000 }, term === 'missing' ? '0' : '1');
      expect(await page.$$('[data-entity]')).toHaveLength(term === 'missing' ? 0 : 1);
      expect(await page.$('[data-entity="doc.term:appended"]')).toBeNull();
      const mixed = await page.evaluate(() => (window as unknown as { filterObservations: { total: string; appended: boolean }[] }).filterObservations.filter((held) => !held.total.includes('80') && held.appended));
      expect(mixed, 'no render combines the new total with old appended rows').toEqual([]);
      const afterShrink = await position();
      expect(Math.abs(afterShrink - before), 'shrinking results keeps filter viewport position').toBeLessThanOrEqual(1);
      await page.click('[data-testid=kind-filter]', { clickCount: 3 });
      const beforeErase = requests.length;
      await page.keyboard.press('Backspace');
      await new Promise((done) => setTimeout(done, 80));
      expect(requests.length, 'erasing also waits for the pause').toBe(beforeErase);
      expect(await page.$(term === 'missing' ? '[data-testid=kind-empty]' : '[data-entity="doc.term:0"]'), 'filtered result remains while erase reads').not.toBeNull();
      expect(await page.$('[data-testid=kind-loading]')).toBeNull();
      await new Promise((done) => setTimeout(done, 250));
      expect(requests.at(-1)).toBe('');
      release!();
      await page.waitForSelector('[data-entity="doc.term:79"]');
      expect(Math.abs(await position() - before), 'erasing keeps filter viewport position').toBeLessThanOrEqual(1);
      console.info(JSON.stringify({ width, term, before, afterShrink, afterErase: await position(), requests }));
    } finally { await page.close(); }
  }, 60000);
});
