/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer, { type Browser } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { parseCatalogYaml } from '../src/product/manifest/kinds.js';
import { RELATION_LABELS } from '../src/knowledge/relation-labels.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { fillStatePaths, type FillRun } from '../src/product/fill-runtime.js';

const CATALOG_RELATIONS = (parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as { catalog: { relations: Record<string, string | null> } }).catalog.relations;

const APP = new URL('../wiki/app/dist', import.meta.url).pathname;
const runDescribe = process.env.MADARCH_WIKI_E2E === '1' ? describe.serial : describe.skip;
/** A served shell; scripted requests supply records without a fill or an agent. */
function buildProduct(): { root: string; product: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-relation-labels-e2e-'));
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
  writeFileSync(join(product, 'README.md'), '# Longpage\n\nA relation label fixture.\n');
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


runDescribe('relation labels (built app and Chromium)', () => {
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
  for (const width of [1400, 390]) for (const language of ['en', 'ru'] as const) test(`${language} ${width}px: every catalogue relation is readable in declarations, related rows, backlinks and neighborhood controls`, async () => {
    const relations = Object.keys(CATALOG_RELATIONS).sort();
    const words = RELATION_LABELS[language];
    const page = await browser!.newPage();
    const errors: string[] = [];
    try {
      await page.setViewport({ width, height: 900 });
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.evaluateOnNewDocument((lang) => localStorage.setItem('madarch-wiki-language', lang), language);
      const entity = { id: 'doc.term:neighbor', kind: 'doc.term', label: 'Neighbor', href: '/e/doc.term%3Aneighbor' };
      const directions = ['in', 'out'] as const;
      const groups = relations.flatMap((relation) => directions.map((direction) => ({ relation, direction, total: 1, rows: [{ entity, count: 1 }] })));
      const kind = { kind: 'doc.term', subgroup: '', count: 1, page: true, filled: true, state: 'filled', origins: ['plugin'], fields: [], relations: groups.map(({ relation, direction }) => ({ name: relation, direction, kind: 'doc.term' })) };
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = new URL(request.url());
        const json = (body: unknown) => { void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); };
        if (url.pathname.endsWith('/api/status')) { json({ product: { name: 'Longpage', id: 'fixture' }, manifest: 'ok', language, findingCount: 0, kinds: [kind], groups: [], repositories: [], filled: true, incomplete: false, fill: { state: 'idle' }, writer: { state: 'idle', agent: null, units: [] }, chosenAgent: null, home: null }); return; }
        if (url.pathname.endsWith('/api/catalog')) { json(url.searchParams.has('kind') ? kind : { product: { name: 'Longpage', id: 'fixture' }, language, kinds: [kind], groups: [], findings: [] }); return; }
        if (url.pathname.endsWith('/api/views')) { json({ renderer: 'mermaid', views: [] }); return; }
        if (url.pathname.endsWith('/api/entities')) { json({ kind: 'doc.term', rows: [entity], total: 1, next: null }); return; }
        if (url.pathname.endsWith('/api/page')) {
          json({ id: 'doc.term:center', kind: 'doc.term', title: 'Relation labels', trail: [], notes: [], findings: [], resolutions: {}, blocks: [
            { type: 'related', title: 'Related', groups },
            { type: 'relations', title: 'Relations', renderer: 'mermaid', groups, more: [], linksHere: relations.map((relation, index) => ({ entity: { ...entity, id: `doc.term:backlink-${index}` }, relations: [relation] })), views: [{ spec: { type: 'relations', subject: 'doc.term:center' }, title: 'Relations', label: 'Relations', elements: [], edges: [], notes: [], empty: 'A label fixture; the neighborhood is drawn below.', marker: null, renderers: ['mermaid'], mermaidSource: '', query: '' }] },
            { type: 'graph', title: 'Neighborhood', depth: 1, shown: relations.length + 1, total: relations.length + 1, neighborhood: { center: 'doc.term:center', nodes: [{ id: 'doc.term:center', kind: 'doc.term', label: 'Center', href: null, hops: 0 }, ...relations.map((_, index) => ({ ...entity, id: `doc.term:neighbor-${index}`, label: `Neighbor ${index}`, hops: 1 }))], edges: relations.map((relation, index) => ({ from: 'doc.term:center', to: `doc.term:neighbor-${index}`, relation, count: 1 })), more: [], relations: groups.map(({ relation, direction }) => ({ relation, direction, count: 1 })) } },
          ] }); return;
        }
        void request.continue();
      });
      await page.goto(`${server!.url}/kind/doc.term`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=kind-relations] li', { timeout: 15000 });
      const declarations = await page.$$eval('[data-testid=kind-relations] li', (nodes) => nodes.map((node) => node.textContent));
      for (const relation of relations) {
        expect(words?.[relation], `${language} locale declares ${relation}`).toBeString();
        for (const direction of directions) {
          const label = direction === 'in' ? `← ${words[relation]}` : `${words[relation]} →`;
          expect(declarations.some((text) => text?.includes(label)), `kind declaration: ${language} ${relation} ${direction}`).toBe(true);
        }
      }
      const artifacts = process.env.MADARCH_WIKI_E2E_ARTIFACTS;
      if (artifacts) {
        mkdirSync(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `kind-${language}-${width}.png`), fullPage: true });
        writeFileSync(join(artifacts, `kind-${language}-${width}.html`), await page.content());
      }
      await page.goto(`${server!.url}/e/doc.term%3Acenter`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=links-here]', { timeout: 15000 });
      for (const relation of relations) {
        for (const direction of directions) {
          const label = direction === 'in' ? `← ${words[relation]}` : `${words[relation]} →`;
          for (const surface of ['[data-block=related]', '[data-testid=relations-lists]']) {
            const selector = `${surface} [data-relation="${relation}"][data-direction="${direction}"]`;
            expect(await page.$eval(selector, (node) => (node as HTMLElement).innerText), `${language} ${selector}`).toContain(label);
          }
          const toggle = `[data-testid="relation-${relation}|${direction}"]`;
          expect(await page.$eval(toggle, (node) => (node as HTMLElement).innerText), `${language} neighborhood ${relation}`).toContain(label);
          expect(await page.$eval(toggle, (node) => node.getAttribute('title'))).toContain(words[relation]!);
        }
      }
      const backlinks = await page.$$eval('[data-testid=links-here] li', (nodes) => nodes.map((node) => (node as HTMLElement).innerText));
      for (const [index, relation] of relations.entries()) expect(backlinks[index], `${language} backlink ${relation}`).toContain(words[relation]!);
      // A translated control still filters by its original graph identifier.
      const toggle = '[data-testid="relation-hasRequirement|out"]';
      await page.click(toggle);
      expect(await page.$eval(toggle, (node) => node.getAttribute('data-state'))).toBe('off');
      expect(await page.$('[data-diagram=neighborhood] .dg-edge[data-relation="hasRequirement"]')).toBeNull();
      await page.click(toggle);
      expect(await page.$eval(toggle, (node) => node.getAttribute('data-state'))).toBe('on');
      expect(await page.$('[data-diagram=neighborhood] .dg-edge[data-relation="hasRequirement"]')).not.toBeNull();
      expect(errors).toEqual([]);
      const proof = { language, width, relations: relations.length, declarations, related: groups.length, relationLists: groups.length, backlinks, neighborhoodControls: groups.length, errors };
      if (artifacts) {
        await page.screenshot({ path: join(artifacts, `entity-${language}-${width}.png`), fullPage: true });
        writeFileSync(join(artifacts, `entity-${language}-${width}.html`), await page.content());
        writeFileSync(join(artifacts, `proof-${language}-${width}.json`), JSON.stringify(proof, null, 2));
      }
      console.info(JSON.stringify(proof));
    } finally { await page.close(); }
  }, 60000);
});
