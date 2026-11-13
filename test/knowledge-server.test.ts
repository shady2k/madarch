/**
 * The knowledge wiki over HTTP (decision 0029): the products home serves each
 * product's status, pages, entities and source; an empty product says what to
 * do; starting the fill runs the extract driver over the product's repository
 * into the product's own graph store and tells an open stream as each commit
 * lands; the product selector lists the home's products. The repository is a
 * two-commit fixture built here; the fill is the real driver and extractors.
 */
import { afterAll, beforeAll, describe, expect, test as bunTest } from 'bun:test';
import { skippedCaseOf } from './fill-skip-list.js';

/**
 * A case whose title names a stage this step's fill does not run is skipped with the step that brings it
 * back (test/fill-skip-list.ts); the file's other cases run against what this step's fill publishes.
 */
const test = (title: string, run: () => Promise<void>, bound?: number): void => {
  const skipped = skippedCaseOf(import.meta.path, title);
  const named = skipped === undefined ? title : `${title} (${skipped.brings})`;
  if (bound === undefined) bunTest.skipIf(skipped !== undefined)(named, run);
  else bunTest.skipIf(skipped !== undefined)(named, run, bound);
};
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { activateTestProduct, startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct, recordKey } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import type { Block } from '../src/knowledge/model.js';
import { historyFigureText, isCountedFigure } from '../src/knowledge/history-figures.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';


const sym = (rest: string): string => recordKey('code.symbol', rest);

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => {
  const date = args.indexOf('--date');
  return execFileSync('git', args, { cwd, env: date < 0 ? env : { ...env, GIT_COMMITTER_DATE: args[date + 1]! }, encoding: 'utf8' });
};

let work: string;
let home: string;
let server: StartedServer;
let repository: string;
let firstCommit: string;

const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FIRST_A_TS = A_TS.replace('return 1;', 'return 0;');
const B_TS = ['import { root } from "./a";', '', 'export function entry(): number {', '  return root();', '}', ''].join('\n');

const get = async (path: string): Promise<{ status: number; body: any; type: string | null }> => {
  const response = await fetch(`${server.url}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, type: response.headers.get('content-type') };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-server-'));
  repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'src', 'a.ts'), FIRST_A_TS);
  writeFileSync(join(repository, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
  git(repository, 'add', '.');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf and the root', '--date', '2026-03-01T10:00:00Z');
  firstCommit = git(repository, 'rev-parse', 'HEAD').trim();
  git(repository, 'tag', 'baseline-read', firstCommit);
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Record an untagged interior point', '--date', '2026-03-02T10:00:00Z');
  writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
  writeFileSync(join(repository, 'src', 'b.ts'), B_TS);
  git(repository, 'add', '.');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the entry', '--date', '2026-03-03T10:00:00Z');
  home = join(work, 'home');
  mkdirSync(home);
  const tiny = makeProduct(home, 'tiny', repository, 'tiny');
  writeFileSync(join(tiny, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [repository-tree, repository-history]\n');
  git(tiny, 'add', '-A');
  git(tiny, 'commit', '--quiet', '-m', 'Fill native inventory and history in the fixture');
  const bare = makeProduct(home, 'bare', repository, 'tiny');
  rmSync(join(bare, 'madarch'), { recursive: true });
  const empty = makeProduct(home, 'unconnected', repository, 'tiny');
  writeFileSync(join(empty, 'workspace.yaml'), 'schemaVersion: 1\nid: 2ed7a5e0-3aa5-4e9a-9d3c-76d0a0c5c001\nname: unconnected\n');
  // A product whose own folder is no Git checkout has nothing the files producer could read.
  const noGit = makeProduct(home, 'nogit', repository, 'tiny');
  writeFileSync(join(noGit, 'workspace.yaml'), 'schemaVersion: 1\nid: 2ed7a5e0-3aa5-4e9a-9d3c-76d0a0c5c002\nname: nogit\n');
  rmSync(join(noGit, '.git'), { recursive: true, force: true });
  const app = join(work, 'app');
  mkdirSync(join(app, 'fonts'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>');
  writeFileSync(join(app, 'fonts', 'Face.woff2'), 'face');
  server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  // The first page of a product waits for its reader to start (a process of its own): the suite's first test does not.
  await fetch(`${server.url}/products/tiny/api/status`);
  await fetch(`${server.url}/products/unconnected/api/status`);
}, 120_000);

afterAll(async () => {
  // Close the visited products' readers, background work and PostgreSQL stores before removing them.
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}, 60_000);

describe('an empty product', () => {
  test('a product without a manifest is given nothing, while a validated manifest publishes kinds before any fill', async () => {
    const bare = await get('/products/bare/api/status');
    // The engine knows no entities: nothing was written into the folder, so the wiki shows no kind and says
    // which file it lacks (decision 0034, item 24).
    expect(bare.body).toMatchObject({ manifest: 'no-manifest', filled: false, home: null, kinds: [] });
    // The state names the file it lacks, and the wiki's page links the guide that writes one.
    expect(String(bare.body.manifestFile)).toBe(join(home, 'bare', 'madarch', 'catalog.yaml'));
    expect(bare.body.seeded).toBeUndefined();
    expect(readKinds(join(home, 'bare')).present).toBe(false);
    const refused = await fetch(`${server.url}/products/bare/api/fill`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('madarch/catalog.yaml');
    // Validated declarations are published to the graph without filling repository content.
    const tiny = await get('/products/tiny/api/status');
    expect(tiny.body).toMatchObject({ manifest: 'not-filled', filled: false, home: null, fill: { state: 'idle' }, repositories: [{ name: 'tiny', filled: false }] });
    expect(String(tiny.body.manifestFile)).toBe(join(home, 'tiny', 'madarch', 'catalog.yaml'));
    expect(tiny.body.kinds.length).toBeGreaterThan(0);
    const catalogue = await get('/products/tiny/api/catalog');
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.kinds.length).toBeGreaterThan(0);
    expect(catalogue.body.kinds.filter((kind: { kind: string }) => kind.kind !== 'template').every((kind: { count: number; state: string }) => kind.count === 0 && kind.state === 'never')).toBe(true);
    expect(catalogue.body.kinds.find((kind: { kind: string }) => kind.kind === 'template')?.count).toBeGreaterThan(0);
    const unconnected = await get('/products/unconnected/api/status');
    expect(unconnected.body.repositories).toEqual([]);
  });

  test('after a fill the catalogue lists every kind the manifest declares, with a zero count for one nothing filled, and its own answer stays under the size bound', async () => {
    // The kinds are the manifest's as the graph holds it: a person copies the starter set into the folder here, as a
    // product repository holds its own (the engine knows no entities), and commits it for the fill to read.
    seedStarterSet(join(home, 'bare'));
    writeFileSync(join(home, 'bare', 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [repository-tree, repository-history]\n');
    git(join(home, 'bare'), 'add', '-A');
    git(join(home, 'bare'), 'commit', '--quiet', '-m', 'the product holds the starter set');
    await activateTestProduct(join(home, 'bare'), home, join(work, 'store'));
    const started = await fetch(`${server.url}/products/bare/api/fill`, { method: 'POST' });
    expect(started.status).toBe(202);
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const state = (await get('/products/bare/api/status')).body.fill.state as string;
      if (state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 250));
    }
    const status = await get('/products/bare/api/status');
    // A published catalogue or repository pin is not a finished fill.
    expect(status.body).toMatchObject({ fill: { state: 'done' }, filled: true, manifest: 'ok' });
    const published = readKinds(join(home, 'bare'));
    if (!published.present || published.manifest.catalog === undefined) throw new Error('the fixture starter catalogue is absent');
    expect(status.body.kinds.map((kind: { kind: string }) => kind.kind).sort()).toEqual([...published.manifest.catalog.kinds.keys()].sort());

    expect(status.body.catalog).toBeUndefined();
    const response = await fetch(`${server.url}/products/bare/api/catalog`);
    const text = await response.text();
    expect(response.status).toBe(200);
    const catalog = JSON.parse(text) as { kinds: any[]; groups: any[]; findings: any[] };
    // The counts are the merged starter catalog's own, read from the manifest the server seeded into this product (the
    // starter set: 28 areas and 106 subgroups, 519 kinds), as main's `test/catalog-read.test.ts` reads the same manifest.
    // A starter set that grows moves this case with it instead of leaving a number here to edit.
    const read = readKinds(join(home, 'bare'));
    if (!read.present) throw new Error('the server seeded no madarch/catalog.yaml into the bare product');

    const seeded = read.manifest;
    expect(seeded.catalog).toBeDefined();
    expect(catalog.kinds.length).toBe(seeded.catalog!.kinds.size);
    expect(catalog.groups.length).toBe(seeded.groups.size);
    expect([catalog.groups.filter((group: { parent?: string }) => group.parent === undefined).length, catalog.groups.filter((group: { parent?: string }) => group.parent !== undefined).length]).toEqual([28, 106]);
    expect(catalog.findings).toEqual([]);
    const empty = catalog.kinds.find((kind) => kind.kind === 'domain-repository');
    expect(empty).toMatchObject({ count: 0, filled: false, page: false });
    expect(empty.producer).toBeUndefined();
    expect(empty.labels).toEqual({ en: { one: 'Domain repository', many: 'Domain repositories' }, ru: { one: 'Репозиторий предметной области', many: 'Репозитории предметной области' } });
    expect(empty.descriptions.ru).toBe('Интерфейс предметной области, дающий доступ к агрегатам как к коллекции; это не репозиторий системы контроля версий.');
    const filled = catalog.kinds.find((kind) => kind.kind === 'code.service');
    expect(filled).toMatchObject({ count: 0, filled: true, page: true, producer: 'extract', subgroup: 'code.structure' });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(300_000);
  }, 90_000);

  test('a fresh starter product\'s problems page carries none of the notes about rules of another section', async () => {
    // madarch-8bdc.13: the code section ran every rule of the manifest, so each documents and wiki rule of the starter set
    // was "a predicate the engine does not implement" — ten notes on a fresh product. The code section judges the code's
    // rules, the documents and wiki sections judge theirs, and a predicate no section implements is said once.
    const listing = await get('/products/bare/api/problems');
    expect(listing.status).toBe(200);
    const notes = (listing.body as { notes?: { message: string; textKey?: string }[] }).notes ?? [];
    expect(notes.filter((note) => note.textKey === 'ruleUnimplemented')).toEqual([]);
    expect(notes.filter((note) => note.message.includes('the engine does not implement'))).toEqual([]);
  }, 30_000);

  test('the fill is refused in words where it cannot start: no repository and no checkout of its own', async () => {
    const none = await fetch(`${server.url}/products/nogit/api/fill`, { method: 'POST' });
    expect(none.status).toBe(409);
    expect((await none.json() as { message: string }).message).toBe('the product declares no code repository and its own folder is no Git checkout: connect one with "madarch repo add <name> <url>", then start the fill');
  });

  test('a page that does not exist is a 404 that names why, and an id is required', async () => {
    // Published declarations exist before a fill, but the requested content does not.
    const missing = await get(`/products/tiny/api/page?id=${encodeURIComponent('code.symbol:nothing')}`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe(`no entity "code.symbol:nothing" in the graph or among the product's Markdown pages`);
    expect((await get('/products/tiny/api/page')).status).toBe(400);
    expect((await get('/products/tiny/api/entities?kind=nothing')).status).toBe(404);
  });
});

describe('the products and the app', () => {
  test('the removed dependencies page is a 404 without a redirect', async () => {
    for (const path of ['/dependencies', '/dependencies/', '/products/tiny/dependencies', '/products/tiny/dependencies/']) {
      const answer = await fetch(`${server.url}${path}`, { redirect: 'manual' });
      expect(answer.status).toBe(404);
      expect(answer.headers.get('location')).toBeNull();
    }
  });

  test('the selector is offered the home\'s products at the root and each product alone under its prefix', async () => {
    const all = await get('/api/products');
    expect(all.body.products.map((product: { folder: string }) => product.folder)).toEqual(['bare', 'nogit', 'tiny', 'unconnected']);
    const one = await get('/products/tiny/api/products');
    expect(one.body.products.map((product: { folder: string }) => product.folder)).toEqual(['bare', 'nogit', 'tiny', 'unconnected']);
  });

  test('the app answers its home and its pages at a product\'s prefix, and the app\'s fonts are served at the home\'s root', async () => {
    for (const path of ['/products/tiny', '/products/tiny/', '/products/tiny/e/x', '/products/tiny/kind/code.symbol', '/products/tiny/src?path=a']) {
      const answer = await fetch(`${server.url}${path}`);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain('<div id="root">');
    }
    const font = await fetch(`${server.url}/fonts/Face.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await fetch(`${server.url}/fonts/none.woff2`)).status).toBe(404);
  });
});

describe('the fill the reader watches', () => {
  test('starting the fill reads the repository into the product\'s own store, and the wiki\'s existing change stream tells an open page after each commit', async () => {
    const stream = await fetch(`${server.url}/products/tiny/api/events`);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let heard = '';
    const revisions: string[] = [];
    let done = false;
    const listen = (async (): Promise<void> => {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) return;
        heard += decoder.decode(value);
        const frames = heard.split('\n\n');
        heard = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.includes('event: change')) continue;
          revisions.push((JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { revision: string }).revision);
        }
        if (done) return;
      }
    })();
    // The stream says where the wiki stands when it opens; what the fill reads after that is what it must tell.
    await new Promise((rest) => setTimeout(rest, 700));
    const opened = revisions.length;
    expect(opened).toBe(1);
    const first = await fetch(`${server.url}/products/tiny/api/fill`, { method: 'POST' });
    expect(first.status).toBe(202);
    expect((await first.json() as { fill: { state: string } }).fill.state).toBe('running');
    const second = await fetch(`${server.url}/products/tiny/api/fill`, { method: 'POST' });
    expect(second.status).toBe(409);
    expect((await second.json() as { message: string }).message).toBe('a fill of this product is already running');
    let status: { fill: { state: string; commit?: number; commits?: number } } = (await get('/products/tiny/api/status')).body;
    for (let tries = 0; tries < 1200 && status.fill.state === 'running'; tries += 1) {
      await new Promise((rest) => setTimeout(rest, 100));
      status = (await get('/products/tiny/api/status')).body;
    }
    expect(status.fill.state).toBe('done');
    await new Promise((rest) => setTimeout(rest, 700));
    done = true;
    await reader.cancel();
    await listen.catch(() => undefined);
    // The revision moved at the start (the run stands) and at the end (the snapshot the pages read),
    // and the stream told it each time: each notice a different revision. This step's fill reads a
    // repository in two passes, not a commit at a time, so its two moments are the two notices.
    expect(revisions.length - opened).toBeGreaterThanOrEqual(2);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions[revisions.length - 1]).toMatch(/^\d+$/);

    const final = await get('/products/tiny/api/status');
    expect(final.body).toMatchObject({ filled: true, fill: { state: 'done' }, repositories: [{ name: 'tiny', filled: true }] });
    expect(existsSync(join(work, 'store', final.body.product.id, 'graph'))).toBe(true);
  }, 300_000);

  test('after the fill the function page shows its callees and the exact lines of its source, and the file is read at the commit the graph holds', async () => {
    const key = sym('src/a.ts#root');
    const page = await get(`/products/tiny/api/page?id=${encodeURIComponent(key)}`);
    expect(page.status).toBe(200);
    const source = page.body.blocks.find((block: { type: string }) => block.type === 'source');
    expect(source.location).toMatchObject({ repo: 'tiny', path: 'src/a.ts', lineStart: 5, lineEnd: 7 });
    expect(source.text).toBe(A_TS.split('\n').slice(4, 7).join('\n'));
    const callees = page.body.blocks.find((block: { type: string }) => block.type === 'callees');
    expect(callees.rows.map((row: { entity: { id: string } }) => row.entity.id)).toEqual([sym('src/a.ts#leaf')]);
    expect(callees.rows[0].entity.location).toMatchObject({ path: 'src/a.ts', lineStart: 1, lineEnd: 3 });
    const callers = page.body.blocks.find((block: { type: string }) => block.type === 'callers');
    expect(callers.rows.map((row: { entity: { id: string }; site: { path: string; lineStart: number } }) => [row.entity.id, row.site.path, row.site.lineStart])).toEqual([[sym('src/b.ts#entry'), 'src/b.ts', 4]]);

    // The diagrams are left to be read on their own, each by the identity of its name and parameters; `full=1` has them in
    // the page. A block is known by that identity, never by the line of a template (decision 0032 section 8).
    const deferred = page.body.blocks.filter((block: { type: string }) => block.type === 'deferred');
    expect(deferred.map((block: { block: string }) => block.block)).toEqual(['graph', 'modules', 'sequence']);
    const drawn = await get(`/products/tiny/api/block?id=${encodeURIComponent(key)}&block=${encodeURIComponent(deferred[2].id)}`);
    expect(drawn.status).toBe(200);
    expect(drawn.body.type).toBe('diagrams');
    expect((await get(`/products/tiny/api/block?id=${encodeURIComponent(key)}`)).status).toBe(400);
    expect((await get(`/products/tiny/api/block?id=${encodeURIComponent(key)}&block=sequence-000000000000`)).status).toBe(404);
    const whole = await get(`/products/tiny/api/page?id=${encodeURIComponent(key)}&full=1`);
    expect(whole.body.blocks.map((block: { type: string }) => block.type)).toContain('graph');
    // The chain of this function has no step to draw, so the empty section is not on the page (madarch-m38l.21).
    expect(whole.body.blocks.map((block: { type: string }) => block.type)).not.toContain('diagrams');
    const neighbours = await get(`/products/tiny/api/neighborhood?id=${encodeURIComponent(key)}&limit=3`);
    expect(neighbours.status).toBe(200);
    expect(neighbours.body.center).toBe(key);
    expect((await get(`/products/tiny/api/neighborhood?id=${encodeURIComponent(key)}&direction=sideways`)).status).toBe(400);

    const file = await get(`/products/tiny/api/source?repo=tiny&path=${encodeURIComponent('src/b.ts')}`);
    expect(file.body).toMatchObject({ repo: 'tiny', path: 'src/b.ts', language: 'typescript', commit: git(repository, 'rev-parse', 'HEAD').trim(), text: B_TS });
    expect((await get('/products/tiny/api/source?repo=tiny&path=..%2Fsecret')).status).toBe(400);
    expect((await get('/products/tiny/api/source?repo=other&path=src/a.ts')).status).toBe(404);
    expect((await get('/products/tiny/api/source?repo=tiny&path=src/none.ts')).status).toBe(404);
    const historicalGap = await get('/products/tiny/api/source?repo=tiny&path=src/a.ts&at=not-a-date');
    expect(historicalGap.status).toBe(409);
    expect(historicalGap.body.error).toMatchObject({ field: 'at', message: 'historical structure is unknown for tiny at not-a-date; no current source is substituted' });
    expect(historicalGap.body.text).toBeUndefined();
    const unknownRepository = await get('/products/tiny/api/source?repo=other&path=src/a.ts&at=2026-03-02');
    expect(unknownRepository.status).toBe(409);
    expect(unknownRepository.body.error.message).toContain('unknown for other at 2026-03-02');
    expect(unknownRepository.body.text).toBeUndefined();
    // The product repository's own files open too, its git folder and dotfiles never.
    const manifest = await get('/products/tiny/api/source?path=madarch%2Fcatalog.yaml');
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({ repo: null, path: 'madarch/catalog.yaml', language: 'yaml', commit: null });
    expect((await get('/products/tiny/api/source?path=.git%2Fconfig')).status).toBe(404);
    expect((await get('/products/tiny/api/source?path=.gitignore')).status).toBe(404);
    // The gitignored checkouts are read as the repository the graph was filled from, at that commit, never as the product's own files.
    expect((await get('/products/tiny/api/source?path=repos%2Ftiny%2Fsrc%2Fa.ts')).status).toBe(404);
  });

  test('production fill publishes repository first/tag/last trees for dated pages and exact source', async () => {
    const key = sym('src/a.ts#root');
    for (const at of ['2026-03-01', 'refs/tags/baseline-read', 'first']) {
      const selected = new URLSearchParams({ id: key, repo: 'tiny', at });
      const page = await get(`/products/tiny/api/page?${selected}`);
      expect(page.status).toBe(200);
      expect(page.body.history).toMatchObject({ coverage: 'covered', commit: firstCommit });
      expect(page.body.historicalAbsent).not.toBe(true);
      const source = await get(`/products/tiny/api/source?${new URLSearchParams({ repo: 'tiny', path: 'src/a.ts', at })}`);
      expect(source.status).toBe(200);
      expect(source.body).toMatchObject({ text: FIRST_A_TS, commit: firstCommit, history: { coverage: 'covered', landmarks: { offered: 2, covered: 2, limit: 64, omitted: 0, overflow: false } } });
    }
    const absent = await get(`/products/tiny/api/page?${new URLSearchParams({ id: sym('src/b.ts#entry'), repo: 'tiny', at: '2026-03-01' })}`);
    expect(absent.body).toMatchObject({ historicalAbsent: true, history: { coverage: 'covered', commit: firstCommit } });
    const tip = await get(`/products/tiny/api/page?${new URLSearchParams({ id: sym('src/b.ts#entry'), repo: 'tiny', at: 'last' })}`);
    expect(tip.body.history).toMatchObject({ coverage: 'covered', commit: git(repository, 'rev-parse', 'HEAD').trim() });
    for (const lang of ['en', 'ru']) {
      const unfilled = await get(`/products/tiny/api/page?${new URLSearchParams({ id: key, repo: 'tiny', at: '2026-03-02', lang })}`);
      expect(unfilled.body).toMatchObject({ blocks: [], history: { coverage: 'unfilled', landmarks: { offered: 2, covered: 2 } } });
      const sourceGap = await get(`/products/tiny/api/source?${new URLSearchParams({ repo: 'tiny', path: 'src/a.ts', at: '2026-03-02' })}`);
      expect(sourceGap.status).toBe(409); expect(sourceGap.body.text).toBeUndefined();
    }
    const before = await get(`/products/tiny/api/page?${new URLSearchParams({ id: key, repo: 'tiny', at: '2026-02-28' })}`);
    expect(before.body.history.coverage).toBe('before');
  }, 20_000);

  test('repository landmarks have bilingual routed pages with the actual commit and held files', async () => {
    const listed = await get('/products/tiny/api/entities?kind=code.snapshot');
    expect(listed.status).toBe(200);
    const names = ['first', 'last', 'refs/tags/baseline-read'];
    expect(listed.body.total).toBe(names.length);
    expect(listed.body.rows.map((row: { id: string }) => row.id).sort()).toEqual(names.map((name) => recordKey('code.snapshot', name)).sort());
    const status = await get('/products/tiny/api/status');
    expect(status.body.kinds.find((kind: { kind: string }) => kind.kind === 'code.snapshot')).toMatchObject({ group: 'history.work', count: names.length, origins: ['history'], labels: { en: { one: 'Repository landmark', many: 'Repository landmarks' }, ru: { one: 'Ориентир репозитория', many: 'Ориентиры репозитория' } } });
    const declaration = status.body.kinds.find((kind: { kind: string }) => kind.kind === 'code.snapshot');
    expect(declaration.descriptions.en).toBe('A repository landmark read from Git, with its commit and the files held by that tree.');
    expect(declaration.descriptions.ru).toBe('Ориентир из Git с его коммитом и файлами этого дерева репозитория.');
    for (const name of names) {
      const id = recordKey('code.snapshot', name);
      const expectedCommit = name === 'last' ? git(repository, 'rev-parse', 'HEAD').trim() : firstCommit;
      const expectedFiles = (name === 'last' ? ['package.json', 'src/a.ts', 'src/b.ts'] : ['package.json', 'src/a.ts']).map((path) => recordKey('code.file', path)).sort();
      for (const lang of ['en', 'ru']) {
        const page = await get(`/products/tiny/api/page?${new URLSearchParams({ id, lang, full: '1' })}`);
        expect(page.status).toBe(200);
        expect(page.body.findings).toEqual([]);
        const blocks: Block[] = page.body.blocks;
        expect(blocks.filter((entry) => entry.type === 'problem')).toEqual([]);
        const details = blocks.find((entry): entry is Extract<Block, { type: 'properties' }> => entry.type === 'properties');
        expect(details).toBeDefined();
        if (!details) throw new Error(`Landmark page ${id} in ${lang} omitted its properties block`);
        expect(details.title).toBe(lang === 'ru' ? 'Сведения' : 'Details');
        expect(details.rows).toContainEqual({ name: 'commit', label: lang === 'ru' ? 'Коммит' : 'Commit', value: expectedCommit });
        const relations = blocks.find((entry): entry is Extract<Block, { type: 'related' }> => entry.type === 'related' && entry.groups.some((group) => group.relation === 'code.held'));
        expect(relations).toBeDefined();
        if (!relations) throw new Error(`Landmark page ${id} in ${lang} omitted its held-file relations`);
        const held = relations.groups.find((group) => group.relation === 'code.held');
        expect(held).toBeDefined();
        if (!held) throw new Error(`Landmark page ${id} in ${lang} omitted code.held`);
        expect(held.total).toBe(expectedFiles.length);
        expect(held.rows.map((row) => row.entity.id).sort()).toEqual(expectedFiles);
        for (const row of held.rows) {
          expect(row.entity.href).toBeTruthy();
          expect(row.entity.broken).toBeUndefined();
          const target = await get(`/products/tiny/api/page?${new URLSearchParams({ id: row.entity.id, lang })}`);
          expect(target.status).toBe(200);
          expect(target.body.findings).toEqual([]);
        }
        const neighbors = await get(`/products/tiny/api/neighborhood?${new URLSearchParams({ id, lang })}`);
        expect(neighbors.status).toBe(200);
        expect(neighbors.body.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(expectedFiles));
      }
    }
  }, 30_000);

  test('a kind is listed from the graph in key order, filtered by text', async () => {
    const all = await get('/products/tiny/api/entities?kind=code.symbol');
    expect(all.body.rows.map((row: { id: string }) => row.id)).toEqual([sym('src/a.ts#leaf'), sym('src/a.ts#root'), sym('src/b.ts#entry')]);
    expect(all.body.total).toBe(3);
    const some = await get('/products/tiny/api/entities?kind=code.symbol&q=ent');
    expect(some.body.rows.map((row: { id: string }) => row.id)).toEqual([sym('src/b.ts#entry')]);
  });

  test('a domain map accepts the manifest kind scope rather than looking for an entity with that id', async () => {
    const map = await get('/products/tiny/api/view?type=domain-map&subject=domain&lang=en');
    expect(map.status).toBe(200);
    expect(map.body.views[0]).toMatchObject({ spec: { type: 'domain-map', subject: 'domain' }, empty: expect.any(String) });
  });

  test('filling again an unchanged repository is done at once and changes no page', async () => {
    const id = recordKey('code.file', 'tiny/src/a.ts');
    const before = await get(`/products/tiny/api/page?id=${encodeURIComponent(id)}`);
    expect(before.status).toBe(200);
    const started = await fetch(`${server.url}/products/tiny/api/fill`, { method: 'POST' });
    expect(started.status).toBe(202);
    for (let tries = 0; tries < 400; tries += 1) {
      const status = (await get('/products/tiny/api/status')).body;
      if (status.fill.state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 250));
    }
    const after = await get(`/products/tiny/api/page?id=${encodeURIComponent(id)}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  }, 120_000);
});

describe('the pages for agents', () => {
  const prefix = '/products/tiny';
  const pageAddress = (id: string): string => `${prefix}/e/${encodeURIComponent(id)}`;

  test("a page is Markdown and JSON at its .md and .json siblings, and its HTML names the Markdown", async () => {
    const id = sym('src/a.ts#root');
    const html = await get(pageAddress(id));
    expect(html.status).toBe(200);
    expect(html.type).toContain('text/html');
    expect(html.body).toContain(`<link rel="alternate" type="text/markdown" href="${pageAddress(id)}.md">`);

    const page = (await get(`/products/tiny/api/page?id=${encodeURIComponent(id)}&full=1`)).body;
    const markdown = await get(`${pageAddress(id)}.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.type).toContain('text/markdown');
    expect(markdown.body).toContain(`# ${page.title}`);
    for (const block of page.blocks as Block[]) {
      if ((block.type === 'markdown' || block.type === 'body') && block.markdown.trim() !== '') {
        expect(markdown.body).toContain(block.markdown.trim().split('\n')[0]!);
      }
    }

    // Every wiki address the page holds is a link in the Markdown and a url in the JSON: none is dropped.
    const hrefs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
      if (value === null || typeof value !== 'object') return;
      for (const [key, held] of Object.entries(value)) {
        if (key === 'href' && typeof held === 'string' && held.startsWith('/')) hrefs.push(held);
        else walk(held);
      }
    };
    walk(page.blocks);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(markdown.body).toContain(`](${prefix}${href})`);

    const document = await get(`${pageAddress(id)}.json`);
    expect(document.status).toBe(200);
    expect(document.type).toContain('application/json');
    expect(document.body).toMatchObject({
      schema: 'madarch.page.v1',
      id,
      kind: page.kind,
      title: page.title,
      address: pageAddress(id),
      markdown: `${pageAddress(id)}.md`,
      json: `${pageAddress(id)}.json`,
    });
    expect(document.body.sections).toHaveLength(page.blocks.length + (page.planned === undefined ? 0 : 1));
    expect(document.body.trail.map((entry: { title: string }) => entry.title)).toEqual(page.trail.map((entry: { label: string }) => entry.label));
    for (const href of hrefs) expect(JSON.stringify(document.body)).toContain(`${prefix}${href}`);
    // The blocks that carry lists of entities keep them, rather than folding them into text.
    const types: string[] = document.body.sections.map((section: { type: string }) => section.type);
    for (const block of page.blocks as Block[]) {
      if (block.type === 'related') expect(types).toContain('relations');
      if (block.type === 'callers' || block.type === 'callees' || block.type === 'refs') expect(types).toContain('links');
      if (block.type === 'properties') expect(types).toContain('properties');
      if (block.type === 'source') expect(types).toContain('source');
      if (block.type === 'graph' || block.type === 'diagrams') expect(types).toContain('diagram');
    }
    // A relation list keeps every row of its group: the landmark page holds the two files of its tree.
    const landmark = recordKey('code.snapshot', 'first');
    const landmarkAddress = pageAddress(landmark);
    const held = (await get(`${landmarkAddress}.json`)).body.sections
      .flatMap((section: { type: string; groups?: { relation: string; total: number; items: { id: string; url: string | null }[] }[] }) => section.type === 'relations' ? section.groups ?? [] : [])
      .find((group: { relation: string }) => group.relation === 'code.held');
    expect(held.total).toBe(2);
    expect(held.items.map((item: { id: string }) => item.id).sort()).toEqual([recordKey('code.file', 'package.json'), recordKey('code.file', 'src/a.ts')].sort());
    const landmarkMarkdown = (await get(`${landmarkAddress}.md`)).body;
    for (const item of held.items) expect(landmarkMarkdown).toContain(`](${item.url})`);
  }, 60_000);

  test('the Markdown of a page writes its history figures in the reader\'s language, as the app draws them', async () => {
    const ids = [recordKey('code.author', 'Fixture'), recordKey('code.module', 'src')];
    const countedOf = new Map<string, { kind: string; value: string }[]>();
    for (const id of ids) {
      const page = (await get(`/products/tiny/api/page?${new URLSearchParams({ id, lang: 'en', full: '1' })}`)).body;
      const figures = (page.blocks as Block[]).flatMap((block) => block.type === 'history' ? block.sections.flatMap((section) => section.rows.flatMap((row) => row.figures)) : []);
      const counted = figures.filter((figure) => isCountedFigure(figure.kind));
      expect(counted.length).toBeGreaterThan(0);
      countedOf.set(id, counted);
      const english = (await get(`${pageAddress(id)}.md`)).body;
      const russian = (await get(`${pageAddress(id)}.md?lang=ru`)).body;
      for (const figure of counted) {
        expect(english).toContain(historyFigureText(figure, 'en'));
        expect(russian).toContain(historyFigureText(figure, 'ru'));
        // A counted figure is a phrase, never the kind's name followed by the numeral.
        expect(english).not.toContain(`${figure.kind}: ${figure.value}`);
        expect(russian).not.toContain(`${figure.kind}: ${figure.value}`);
      }
      // The JSON keeps every figure as its kind and its value, whatever the language of the Markdown.
      const document = (await get(`${pageAddress(id)}.json?lang=ru`)).body;
      for (const figure of counted) expect(JSON.stringify(document)).toContain(JSON.stringify(figure));
    }
    // One author's page holds a commit figure of one and of two, so both forms are written.
    const author = recordKey('code.author', 'Fixture');
    expect(countedOf.get(author)!.map((figure) => `${figure.kind} ${figure.value}`)).toEqual(['commits 2', 'commits 1', 'commits 1']);
    const authorEnglish = (await get(`${pageAddress(author)}.md`)).body;
    const authorRussian = (await get(`${pageAddress(author)}.md?lang=ru`)).body;
    expect(authorEnglish).toContain('1 commit');
    expect(authorEnglish).toContain('2 commits');
    expect(authorRussian).toContain('1 коммит');
    expect(authorRussian).toContain('2 коммита');
  });

  test('a kind is Markdown and JSON at its .md and .json siblings, every entity of the kind', async () => {
    const status = (await get('/products/tiny/api/status')).body;
    expect(status.kinds.length).toBeGreaterThan(0);
    for (const kind of status.kinds) {
      const address = `${prefix}/kind/${encodeURIComponent(kind.kind)}`;
      const html = await get(address);
      expect(html.status).toBe(200);
      expect(html.body).toContain(`<link rel="alternate" type="text/markdown" href="${address}.md">`);
      const markdown = await get(`${address}.md`);
      expect(markdown.status).toBe(200);
      expect(markdown.type).toContain('text/markdown');
      expect(markdown.body).toContain(`# ${kind.labels[status.language].many}`);
      const document = await get(`${address}.json`);
      expect(document.status).toBe(200);
      expect(document.body).toMatchObject({ schema: 'madarch.kind.v1', kind: kind.kind, title: kind.labels[status.language].many });
      // The list's own total is what it serves; the catalogue of operations also holds the channels of actual contracts.
      expect(document.body.entries).toHaveLength(document.body.total);
      expect(document.body.total).toBeGreaterThanOrEqual(kind.count);
      for (const entry of document.body.entries) {
        if (entry.url === null) continue;
        expect(entry.url.startsWith(`${prefix}/e/`)).toBe(true);
        expect(markdown.body).toContain(`](${entry.url})`);
      }
    }
    const symbols = (await get(`${prefix}/kind/code.symbol.json`)).body;
    expect(symbols.entries.map((entry: { id: string }) => entry.id).sort()).toEqual([sym('src/a.ts#leaf'), sym('src/a.ts#root'), sym('src/b.ts#entry')].sort());
    expect(symbols.entries.length).toBe(symbols.total);
    expect((await get(`${prefix}/kind/no.such.kind.json`)).status).toBe(404);
  }, 60_000);

  test("the product's llms.txt lists every declared kind and the addresses of its lists", async () => {
    const status = (await get('/products/tiny/api/status')).body;
    const llms = await get(`${prefix}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(llms.type).toContain('text/plain');
    expect(llms.body).toContain(`# ${status.product.name}`);
    for (const kind of status.kinds) {
      expect(llms.body).toContain(`kind \`${kind.kind}\``);
      expect(llms.body).toContain(`${prefix}/kind/${encodeURIComponent(kind.kind)}.md`);
      expect(llms.body).toContain(`${prefix}/kind/${encodeURIComponent(kind.kind)}.json`);
    }
    expect(llms.body).toContain(`${prefix}/e/<id>.md`);
    expect(llms.body).toContain(`${prefix}/llms.txt`);
  });

  test('a file address that names nothing is refused with the address it was asked for', async () => {
    const empty = await get(`${prefix}/e/.md`);
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('/e/.md');
    const missing = await get(`${prefix}/e/${encodeURIComponent('no.such#entity')}.md`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toContain('no.such#entity');
    const badEscape = await get(`${prefix}/e/%ZZ.md`);
    expect(badEscape.status).toBe(400);
    expect(badEscape.body.error.message).toContain('%ZZ.md');
  });
});

describe('what a refresh changed', () => {
  /** Presses the fill and waits for its end: the status the Sync button reads when it opens its result. */
  const refresh = async (): Promise<any> => {
    const press = await fetch(`${server.url}/products/tiny/api/fill`, { method: 'POST' });
    expect(press.status).toBe(202);
    let status: any;
    for (let tries = 0; tries < 400; tries += 1) {
      status = (await get('/products/tiny/api/status')).body;
      if (status.fill.state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 250));
    }
    if (status === undefined || status.fill.state === 'running') throw new Error('the fill of the tiny product did not end within 100 s');
    // The pages the run changed are recorded when it ends, in a notify of their own: wait a little for the status that has them.
    for (let grace = 0; grace < 40 && status.fill.state === 'done' && status.fill.changed === undefined; grace += 1) {
      await new Promise((rest) => setTimeout(rest, 250));
      status = (await get('/products/tiny/api/status')).body;
    }
    return status;
  };

  test('a refresh that reads a new commit names the pages of the file it touched and of the function it added; one with nothing new says nothing changed, and every page named opens', async () => {
    // A store that begins empty (or is rebuilt) names every page it wrote; the next run, with nothing new, names none.
    await refresh();
    const settled = await refresh();
    expect(settled.fill).toMatchObject({ state: 'done', changed: [] });
    writeFileSync(join(repository, 'src', 'a.ts'), `${A_TS}\nexport function extra(): number {\n  return 2;\n}\n`);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the extra step', '--date', '2026-03-04T10:00:00Z');
    const after = await refresh();
    expect(after.fill.state).toBe('done');
    const changed: { id: string; title: string }[] = after.fill.changed;
    const ids = changed.map((page) => page.id);
    expect(ids).toContain(recordKey('code.file', 'src/a.ts'));
    expect(ids).toContain(sym('src/a.ts#extra'));
    expect(ids).not.toContain(recordKey('code.file', 'src/b.ts'));
    for (const page of changed) {
      const opened = await get(`/products/tiny/api/page?id=${encodeURIComponent(page.id)}`);
      expect(opened.status).toBe(200);
      expect(opened.body.title).toBe(page.title);
    }
    expect((await refresh()).fill).toMatchObject({ state: 'done', changed: [] });
  }, 180_000);

  test('a file page\'s trail ends in the file, and its History is the commits Git gives for the path', async () => {
    // Native inventory publishes file/history facts; this fixture authors its graph-backed layouts.
    const product = join(home, 'tiny');
    const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(product, join(work, 'store'))), connectOnly: true });
    try {
      await publishFixtureTemplate(owner, product, 'templates/file.liquid', [{ type: 'block', name: 'file-page', params: {}, line: 1 }]);
      await publishFixtureTemplate(owner, product, 'templates/directory.liquid', [{ type: 'block', name: 'folder', params: {}, line: 1 }]);
    } finally { await owner.close(); }
    const id = recordKey('code.file', 'tiny/src/a.ts');
    const answer = await get(`/products/tiny/api/page?id=${encodeURIComponent(id)}`);
    expect(answer.status).toBe(200);
    expect(answer.body.trail.at(-1)).toMatchObject({ id, label: 'src/a.ts' });
    expect(answer.body.trail[0]).toMatchObject({ href: '/' });
    const file = (answer.body.blocks as { type: string; history?: { hash: string }[]; cochange?: { path: string; share: number }[]; commits?: number }[]).find((block) => block.type === 'filePage')!;
    expect(file).toBeDefined();
    const expected = git(repository, 'log', '--follow', '--no-merges', '--format=%H', '--', 'src/a.ts').trim().split('\n').filter(Boolean).sort();
    expect(file.history!.map((row) => row.hash).sort()).toEqual(expected);
    expect(file.cochange!.every((row) => row.path !== '' && row.share >= 0 && row.share <= 1)).toBe(true);
    // A root file and a folder keep the same trail rule: the last part is the entity itself, never a lone root.
    const root = await get(`/products/tiny/api/page?id=${encodeURIComponent(recordKey('code.file', 'tiny/package.json'))}`);
    expect(root.status).toBe(200);
    expect(root.body.trail.at(-1)).toMatchObject({ label: 'package.json' });
    expect(root.body.trail.some((entry: { label: string }) => entry.label === '/')).toBe(false);
    const folder = await get(`/products/tiny/api/page?id=${encodeURIComponent(recordKey('code.directory', 'tiny/src'))}`);
    expect(folder.status).toBe(200);
    expect(folder.body.trail.at(-1)).toMatchObject({ label: 'src' });
  }, 60_000);
});
