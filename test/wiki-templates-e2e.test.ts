/**
 * The template frontend on a filled product (decision 0036, sections 6 and 7): madarch's own repository is filled with
 * the disk and git plugins only (no agent, no model), and the built app is loaded in happy-dom against the real server.
 * Each page is one `/graphql` operation after the bootstrap; the page's title, facts, backlinks, its table's paging and
 * its diagram are read off the rendered page.
 *
 * Run with `MADARCH_WIKI_E2E=1` after `bun run build` in `wiki/app`: filling the checkout and reading its history takes
 * minutes, which is the acceptance walk's cost, not the suite's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { runFill } from '../src/fill/run.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { restrictRepositoryDeclarations } from './repository-contract-fixture.js';

const ROOT = join(import.meta.dir, '..');
/** The process's own fetch and Response, before happy-dom takes the names over: the server answers with them. */
const nativeFetch = globalThis.fetch;
const nativeResponse = globalThis.Response;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env.MADARCH_WIKI_E2E === '1' || (typeof process.env.MADARCH_FILL_MADARCH === 'string' && process.env.MADARCH_FILL_MADARCH !== '');
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The template frontend walk is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run it.');

let root = '';
let home = '';
let folder = '';
let server: StartedServer | undefined;
let bundle = '';
let reloads = 0;
let posts: { query: string }[] = [];

/** The built app's entry script: Vite names it with a content hash, and the renderers it loads are chunks beside it. */
function builtBundle(): string {
  const assets = join(APP, 'assets');
  const held = readdirSync(assets).filter((name) => /^index-.*\.js$/u.test(name));
  if (held.length !== 1) throw new Error(`${assets}: expected one entry script, found ${held.join(', ') || 'none'}`);
  return join(assets, held[0]!);
}

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${server!.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(variables === undefined ? {} : { variables }) }) });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors !== undefined) throw new Error(body.errors.map((one) => one.message).join('; '));
  return body.data as T;
}

/** The page as it was drawn, written as a standalone mockup beside the change record: the app's own CSS and its DOM. */
function snapshot(name: string, element: HTMLElement): void {
  const css = readdirSync(join(APP, 'assets')).filter((file) => file.endsWith('.css'));
  const styles = css.map((file) => readFileSync(join(APP, 'assets', file), 'utf8')).join('\n');
  const file = join(ROOT, 'docs', 'prototypes', `templates-${name}.html`);
  mkdirSync(join(ROOT, 'docs', 'prototypes'), { recursive: true });
  writeFileSync(file, `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<title>templates: ${name}</title>\n<style>\n${styles}\n</style>\n</head>\n<body>\n${element.innerHTML}\n</body>\n</html>\n`);
}

/** One app load at one address: the built script imported afresh, its requests answered by the real server. */
async function openPage(path: string, mockup?: string): Promise<{ text: string; nodes: number; links: string[]; buttons: string[]; tabs: string[] }> {
  // The walk mounts no picture: LikeC4's and Mermaid's runtimes and archify's page need a browser's layout engine, and this
  // run checks the page's three tabs and the server's three answers; the panes are checked by the component's own tests.
  try { window.localStorage.removeItem('madarch-wiki-diagram'); } catch { /* no storage in this run */ }
  window.history.pushState({}, '', path);
  document.getElementById('root')?.remove();
  const element = document.createElement('div');
  element.id = 'root';
  document.body.append(element);
  posts = [];
  await import(`${bundle}?page=${String((reloads += 1))}`);
  for (let at = 0; at < 120; at += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = element.textContent ?? '';
    if (text.length > 0 && !text.includes('Reading the product')) break;
  }
  // One settle turn for the page's own answer to be drawn after the bootstrap's.
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (mockup !== undefined) snapshot(mockup, element);
  return {
    text: element.textContent ?? '',
    tabs: [...element.querySelectorAll('[role="tab"]')].map((one) => one.textContent ?? ''),
    nodes: element.querySelectorAll('[data-node]').length,
    links: [...element.querySelectorAll('a')].map((one) => one.getAttribute('href') ?? ''),
    buttons: [...element.querySelectorAll('button')].map((one) => one.textContent ?? ''),
  };
}

run('the template frontend on madarch\'s own filled product', () => {
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    bundle = builtBundle();
    root = mkdtempSync(join(tmpdir(), 'madarch-templates-e2e-'));
    home = join(root, 'products');
    const draft = createDraft({ home, name: 'madarch-wiki', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    folder = draft.folder;
    // Madarch's own checkout is the repository: the walk reads the files and the history a fill reads, with no agent.
    symlinkSync(ROOT, join(folder, 'repos', 'madarch'));
    writeFileSync(join(folder, 'workspace.yaml'), manifestWithRepo(readFileSync(join(folder, 'workspace.yaml'), 'utf8'), { name: 'madarch', linked: true }));
    useFixturePlugins(folder, ['disk', 'git']);
    restrictRepositoryDeclarations(folder);
    commitProduct(folder, 'Fill madarch\'s own repository');
    const store = productStoreFolder(folder, knowledgeRootOf(home));
    mkdirSync(join(store, 'graph'), { recursive: true });
    const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
    try {
      await prepareStore(owner, { contract: await readPinnedGraphContract(folder) });
      const filled = await runFill({ product: folder, database: owner, store, home: store, runId: 'madarch-walk', prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
      if (!filled.ok) throw new Error(`the fill did not succeed: ${JSON.stringify(filled).slice(0, 2000)}`);
      const validation = validateProductManifests(folder);
      if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
      if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
    } finally {
      await owner.close();
    }
    server = await startPreparedServer({ productFolder: folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    // The app is drawn in happy-dom, registered once the server and the store owner are up: their own Response class is
    // the process's, and only the page's rendering needs a DOM.
    // The page's own origin is the served product, so an address the app names (a frame's `src` included) reaches the
    // server in this walk.
    GlobalRegistrator.register({ url: `${server!.url}/` });
    // The server's handler and the page's client both answer with the process's Response: only the drawing needs a DOM.
    globalThis.Response = nativeResponse;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/graphql') && init?.method === 'POST') posts.push({ query: String((JSON.parse(String(init.body)) as { query: string }).query) });
      // A page asks its own origin's paths; the process's fetch reaches the server.
      return await nativeFetch(/^https?:/u.test(url) ? url : `${server!.url}${url.startsWith('/') ? url : `/${url}`}`, init);
    }) as typeof fetch;
  }, 1_800_000);

  afterAll(async () => {
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
    GlobalRegistrator.unregister();
  });

  test('the home page lists the product\'s kinds, one request for its data', async () => {
    const page = await openPage('/', 'home');
    expect(page.text).toContain('Madarch wiki');
    expect(page.text).toContain('Kind');
    expect(posts.filter((one) => one.query.includes('bootstrap'))).toHaveLength(1);
    expect(posts.filter((one) => !one.query.includes('bootstrap'))).toHaveLength(1);
    // The catalogue table is the page's content, and its rows are kinds the filled graph holds.
    expect(page.links.some((href) => href.startsWith('/e/catalogue/'))).toBe(true);
  }, 120_000);

  test('a catalogue entity\'s page shows its declaration and its records, a page at a time', async () => {
    const found = await graphql<{ catalogueEntity: { id: string } }>('{ catalogueEntity(name: "code.file") { id } }');
    const page = await openPage(`/e/catalogue/${found.catalogueEntity.id}`, 'catalogue');
    expect(page.text).toContain('A file of a code repository.');
    expect(page.text).toContain('Records');
    // The records table counts every file of the checkout, and offers the next page.
    const total = /\/ ([\d,]+)/u.exec(page.text);
    expect(Number((total?.[1] ?? '0').replaceAll(',', ''))).toBeGreaterThan(1000);
    expect(page.buttons).toContain('→');
    expect(posts.filter((one) => !one.query.includes('bootstrap'))).toHaveLength(1);
    const first = page.text;
    const next = [...document.querySelectorAll('button')].find((one) => one.textContent === '→');
    next?.click();
    for (let at = 0; at < 40; at += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((document.body.textContent ?? '') !== first) break;
    }
    expect(posts.filter((one) => !one.query.includes('bootstrap')).length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent ?? '').not.toBe(first);
  }, 120_000);

  test('a file page shows its title, its facts, its backlinks and its diagram', async () => {
    const found = await graphql<{ allCodeFile: { edges: { node: { id: string } }[] } }>('{ allCodeFile(where: { path: { _eq: "src/graph/write.ts" } }, first: 1) { edges { node { id } } } }');
    const id = found.allCodeFile.edges[0]!.node.id;
    const page = await openPage(`/e/code.file/${id}`, 'file');
    expect(page.text).toContain('write.ts');
    expect(page.text).toContain('code.file');
    expect(page.text).toContain('Linked from');
    expect(page.text).toContain('codeContainsOf');
    // The diagram is the server's picture, in three tabs (decision 0036, sections 7 and 8).
    expect(page.tabs).toEqual(['LikeC4', 'Mermaid', 'archify']);
    // Nothing is drawn until the reader picks a picture; the server's three answers are read below.
    // The server's own answers carry each node's page: the archify page and the Mermaid source alike.
    const mermaidAnswer = await (await fetch(`${server!.url}/render/diagram?entity=${id}&format=mermaid`)).json() as { source: string };
    expect(mermaidAnswer.source).toContain('click ');
    expect(mermaidAnswer.source).toContain('/e/code.');
    const archifyAnswer = await (await fetch(`${server!.url}/render/diagram?entity=${id}&format=archify`)).text();
    expect(archifyAnswer).toContain('data-node-id');
    expect(archifyAnswer).toContain('/e/code.');
    expect(posts.filter((one) => one.query.includes('bootstrap'))).toHaveLength(1);
  }, 120_000);

  test('a repository page shows its commits as a table and its files in the diagram', async () => {
    const found = await graphql<{ allCodeRepository: { edges: { node: { id: string; label: string } }[] } }>('{ allCodeRepository(first: 1) { edges { node { id label } } } }');
    const one = found.allCodeRepository.edges[0]!.node;
    const page = await openPage(`/e/code.repository/${one.id}`, 'repository');
    expect(page.text).toContain(one.label);
    expect(page.text).toContain('codeContains');
    expect(page.tabs).toEqual(['LikeC4', 'Mermaid', 'archify']);
    // The page is one operation: bootstrap once, page once.
    expect(posts.filter((one) => !one.query.includes('bootstrap'))).toHaveLength(1);
  }, 120_000);
});
