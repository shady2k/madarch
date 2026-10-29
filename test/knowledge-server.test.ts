/**
 * The knowledge wiki over HTTP (decision 0029): the products home serves each
 * product's status, pages, entities and source; an empty product says what to
 * do; starting the fill runs the extract driver over the product's repository
 * into the product's own graph store and tells an open stream as each commit
 * lands; the product selector lists the home's products. The repository is a
 * two-commit fixture built here; the fill is the real driver and extractors.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct, recordKey } from './knowledge-fixture.js';
import type { Block } from '../src/knowledge/model.js';

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

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
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
  makeProduct(home, 'tiny', repository, 'tiny');
  const bare = makeProduct(home, 'bare', repository, 'tiny');
  rmSync(join(bare, 'madarch'), { recursive: true });
  const empty = makeProduct(home, 'unconnected', repository, 'tiny');
  writeFileSync(join(empty, 'workspace.yaml'), 'schemaVersion: 1\nid: 2ed7a5e0-3aa5-4e9a-9d3c-76d0a0c5c001\nname: unconnected\n');
  const app = join(work, 'app');
  mkdirSync(join(app, 'fonts'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  writeFileSync(join(app, 'fonts', 'Face.woff2'), 'face');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  // The first page of a product waits for its reader to start (a process of its own): the suite's first test does not.
  await fetch(`${server.url}/products/tiny/api/k/status`);
  await fetch(`${server.url}/products/unconnected/api/k/status`);
}, 60_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('an empty product', () => {
  test('a product without a manifest is given the starter set and then reads as any empty product; one with a manifest and no graph says what to do: connect a repository, or start the fill', async () => {
    const bare = await get('/products/bare/api/k/status');
    expect(bare.body).toMatchObject({ manifest: 'ok', filled: false, home: null });
    expect(bare.body.seeded).toEqual(['madarch/kinds.yaml']);
    expect(bare.body.kinds.map((kind: { kind: string }) => kind.kind)).toEqual(expect.arrayContaining(['product', 'domain', 'doc.use-case', 'code.service', 'code.file', 'code.symbol', 'code.route', 'code.table']));
    // The kinds carry their names in both languages, from the manifest.
    expect(bare.body.kinds.find((kind: { kind: string }) => kind.kind === 'code.file').labels).toEqual({ en: { one: 'File', many: 'Files' }, ru: { one: 'Файл', many: 'Файлы' } });
    const tiny = await get('/products/tiny/api/k/status');
    expect(tiny.body).toMatchObject({ manifest: 'ok', filled: false, home: null, fill: { state: 'idle' }, repositories: [{ name: 'tiny', filled: false }] });
    expect(tiny.body.kinds.map((kind: { kind: string; count: number }) => kind.count)).toEqual(tiny.body.kinds.map(() => 0));
    expect(tiny.body.kinds.map((kind: { kind: string }) => kind.kind)).toEqual(expect.arrayContaining(['product', 'domain', 'code.service', 'code.file', 'code.symbol']));
    const unconnected = await get('/products/unconnected/api/k/status');
    expect(unconnected.body.repositories).toEqual([]);
  });

  test('the fill is refused in words where it cannot start: no repository', async () => {
    const none = await fetch(`${server.url}/products/unconnected/api/k/fill`, { method: 'POST' });
    expect(none.status).toBe(409);
    expect((await none.json() as { message: string }).message).toBe('the product declares no code repository: connect one with "madarch repo add <name> <url>", then start the fill');
  });

  test('a page that does not exist is a 404 that names why, and an id is required', async () => {
    const missing = await get(`/products/tiny/api/k/page?id=${encodeURIComponent('code.symbol:nothing')}`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('no entity "code.symbol:nothing" in the graph or among the product\'s Markdown pages');
    expect((await get('/products/tiny/api/k/page')).status).toBe(400);
    expect((await get('/products/tiny/api/k/entities?kind=nothing')).status).toBe(404);
  });
});

describe('the products and the app', () => {
  test('the selector is offered the home\'s products at the root and each product alone under its prefix', async () => {
    const all = await get('/api/products');
    expect(all.body.products.map((product: { folder: string }) => product.folder)).toEqual(['bare', 'tiny', 'unconnected']);
    const one = await get('/products/tiny/api/k/products');
    expect(one.body.products.map((product: { folder: string }) => product.folder)).toEqual(['bare', 'tiny', 'unconnected']);
  });

  test('the app answers /k and its pages at a product\'s prefix, and the app\'s fonts are served at the home\'s root', async () => {
    for (const path of ['/products/tiny/k', '/products/tiny/k/', '/products/tiny/k/e/x', '/products/tiny/k/kind/code.symbol', '/products/tiny/k/src?path=a']) {
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
    const first = await fetch(`${server.url}/products/tiny/api/k/fill`, { method: 'POST' });
    expect(first.status).toBe(202);
    expect((await first.json() as { fill: { state: string } }).fill.state).toBe('running');
    const second = await fetch(`${server.url}/products/tiny/api/k/fill`, { method: 'POST' });
    expect(second.status).toBe(409);
    expect((await second.json() as { message: string }).message).toBe('a fill of this product is already running');
    let status: { fill: { state: string; commit?: number; commits?: number } } = (await get('/products/tiny/api/k/status')).body;
    for (let tries = 0; tries < 1200 && status.fill.state === 'running'; tries += 1) {
      await new Promise((rest) => setTimeout(rest, 100));
      status = (await get('/products/tiny/api/k/status')).body;
    }
    expect(status.fill.state).toBe('done');
    await new Promise((rest) => setTimeout(rest, 700));
    done = true;
    await reader.cancel();
    await listen.catch(() => undefined);
    // The revision moved at the start, after each of the two commits and at the end, and the stream told it each time: each notice a different revision.
    expect(revisions.length - opened).toBeGreaterThanOrEqual(3);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions[revisions.length - 1]).toMatch(/\+\d+$/);

    const final = await get('/products/tiny/api/k/status');
    expect(final.body).toMatchObject({ filled: true, fill: { state: 'done' }, repositories: [{ name: 'tiny', filled: true }] });
    expect(existsSync(join(work, 'store', final.body.product.id, 'graph'))).toBe(true);
  }, 300_000);

  test('after the fill the function page shows its callees and the exact lines of its source, and the file is read at the commit the graph holds', async () => {
    const key = sym('src/a.ts#root');
    const page = await get(`/products/tiny/api/k/page?id=${encodeURIComponent(key)}`);
    expect(page.status).toBe(200);
    const source = page.body.blocks.find((block: { type: string }) => block.type === 'source');
    expect(source.location).toMatchObject({ repo: 'tiny', path: 'src/a.ts', lineStart: 5, lineEnd: 7 });
    expect(source.text).toBe(A_TS.split('\n').slice(4, 7).join('\n'));
    const callees = page.body.blocks.find((block: { type: string }) => block.type === 'callees');
    expect(callees.rows.map((row: { entity: { id: string } }) => row.entity.id)).toEqual([sym('src/a.ts#leaf')]);
    expect(callees.rows[0].entity.location).toMatchObject({ path: 'src/a.ts', lineStart: 1, lineEnd: 3 });
    const callers = page.body.blocks.find((block: { type: string }) => block.type === 'callers');
    expect(callers.rows.map((row: { entity: { id: string }; site: { path: string; lineStart: number } }) => [row.entity.id, row.site.path, row.site.lineStart])).toEqual([[sym('src/b.ts#entry'), 'src/b.ts', 4]]);

    // The diagrams are left to be read on their own, each by the line of its block; `full=1` has them in the page.
    const deferred = page.body.blocks.filter((block: { type: string }) => block.type === 'deferred');
    expect(deferred.map((block: { block: string }) => block.block)).toEqual(['graph', 'modules', 'sequence']);
    const drawn = await get(`/products/tiny/api/k/block?id=${encodeURIComponent(key)}&line=${deferred[2].line}`);
    expect(drawn.status).toBe(200);
    expect(drawn.body.type).toBe('diagrams');
    expect((await get(`/products/tiny/api/k/block?id=${encodeURIComponent(key)}&line=0`)).status).toBe(400);
    expect((await get(`/products/tiny/api/k/block?id=${encodeURIComponent(key)}&line=9999`)).status).toBe(404);
    const whole = await get(`/products/tiny/api/k/page?id=${encodeURIComponent(key)}&full=1`);
    expect(whole.body.blocks.map((block: { type: string }) => block.type)).toEqual(expect.arrayContaining(['graph', 'diagrams']));
    const neighbours = await get(`/products/tiny/api/k/neighborhood?id=${encodeURIComponent(key)}&limit=3`);
    expect(neighbours.status).toBe(200);
    expect(neighbours.body.center).toBe(key);
    expect((await get(`/products/tiny/api/k/neighborhood?id=${encodeURIComponent(key)}&direction=sideways`)).status).toBe(400);

    const file = await get(`/products/tiny/api/k/source?repo=tiny&path=${encodeURIComponent('src/b.ts')}`);
    expect(file.body).toMatchObject({ repo: 'tiny', path: 'src/b.ts', language: 'typescript', commit: git(repository, 'rev-parse', 'HEAD').trim(), text: B_TS });
    expect((await get('/products/tiny/api/k/source?repo=tiny&path=..%2Fsecret')).status).toBe(400);
    expect((await get('/products/tiny/api/k/source?repo=other&path=src/a.ts')).status).toBe(404);
    expect((await get('/products/tiny/api/k/source?repo=tiny&path=src/none.ts')).status).toBe(404);
    const historicalGap = await get('/products/tiny/api/k/source?repo=tiny&path=src/a.ts&at=not-a-date');
    expect(historicalGap.status).toBe(409);
    expect(historicalGap.body.error).toMatchObject({ field: 'at', message: 'historical structure is unknown for tiny at not-a-date; no current source is substituted' });
    expect(historicalGap.body.text).toBeUndefined();
    const unknownRepository = await get('/products/tiny/api/k/source?repo=other&path=src/a.ts&at=2026-03-02');
    expect(unknownRepository.status).toBe(409);
    expect(unknownRepository.body.error.message).toContain('unknown for other at 2026-03-02');
    expect(unknownRepository.body.text).toBeUndefined();
    // The product repository's own files open too, its git folder and dotfiles never.
    const manifest = await get('/products/tiny/api/k/source?path=madarch%2Fkinds.yaml');
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({ repo: null, path: 'madarch/kinds.yaml', language: 'yaml', commit: null });
    expect((await get('/products/tiny/api/k/source?path=.git%2Fconfig')).status).toBe(404);
    expect((await get('/products/tiny/api/k/source?path=.gitignore')).status).toBe(404);
    // The gitignored checkouts are read as the repository the graph was filled from, at that commit, never as the product's own files.
    expect((await get('/products/tiny/api/k/source?path=repos%2Ftiny%2Fsrc%2Fa.ts')).status).toBe(404);
  });

  test('production fill publishes repository first/tag/last trees for dated pages and exact source', async () => {
    const key = sym('src/a.ts#root');
    for (const at of ['2026-03-01', 'refs/tags/baseline-read', 'first']) {
      const selected = new URLSearchParams({ id: key, repo: 'tiny', at });
      const page = await get(`/products/tiny/api/k/page?${selected}`);
      expect(page.status).toBe(200);
      expect(page.body.history).toMatchObject({ coverage: 'covered', commit: firstCommit });
      expect(page.body.historicalAbsent).not.toBe(true);
      const source = await get(`/products/tiny/api/k/source?${new URLSearchParams({ repo: 'tiny', path: 'src/a.ts', at })}`);
      expect(source.status).toBe(200);
      expect(source.body).toMatchObject({ text: FIRST_A_TS, commit: firstCommit, history: { coverage: 'covered', landmarks: { offered: 2, covered: 2, limit: 64, omitted: 0, overflow: false } } });
    }
    const absent = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id: sym('src/b.ts#entry'), repo: 'tiny', at: '2026-03-01' })}`);
    expect(absent.body).toMatchObject({ historicalAbsent: true, history: { coverage: 'covered', commit: firstCommit } });
    const tip = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id: sym('src/b.ts#entry'), repo: 'tiny', at: 'last' })}`);
    expect(tip.body.history).toMatchObject({ coverage: 'covered', commit: git(repository, 'rev-parse', 'HEAD').trim() });
    for (const lang of ['en', 'ru']) {
      const unfilled = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id: key, repo: 'tiny', at: '2026-03-02', lang })}`);
      expect(unfilled.body).toMatchObject({ blocks: [], history: { coverage: 'unfilled', landmarks: { offered: 2, covered: 2 } } });
      const sourceGap = await get(`/products/tiny/api/k/source?${new URLSearchParams({ repo: 'tiny', path: 'src/a.ts', at: '2026-03-02' })}`);
      expect(sourceGap.status).toBe(409); expect(sourceGap.body.text).toBeUndefined();
    }
    const before = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id: key, repo: 'tiny', at: '2026-02-28' })}`);
    expect(before.body.history.coverage).toBe('before');
  }, 20_000);

  test('repository landmarks have bilingual routed pages with the actual commit and held files', async () => {
    const listed = await get('/products/tiny/api/k/entities?kind=code.snapshot');
    expect(listed.status).toBe(200);
    const names = ['first', 'last', 'refs/tags/baseline-read'];
    expect(listed.body.total).toBe(names.length);
    expect(listed.body.rows.map((row: { id: string }) => row.id).sort()).toEqual(names.map((name) => recordKey('code.snapshot', name)).sort());
    const status = await get('/products/tiny/api/k/status');
    expect(status.body.kinds.find((kind: { kind: string }) => kind.kind === 'code.snapshot')).toMatchObject({ group: 'history', count: names.length, origins: ['history'], labels: { en: { one: 'Repository landmark', many: 'Repository landmarks' }, ru: { one: 'Ориентир репозитория', many: 'Ориентиры репозитория' } } });
    const declaration = status.body.kinds.find((kind: { kind: string }) => kind.kind === 'code.snapshot');
    expect(declaration.descriptions.en).toBe('A repository landmark read from Git, with its commit and the files held by that tree.');
    expect(declaration.descriptions.ru).toBe('Ориентир из Git с его коммитом и файлами этого дерева репозитория.');
    for (const name of names) {
      const id = recordKey('code.snapshot', name);
      const expectedCommit = name === 'last' ? git(repository, 'rev-parse', 'HEAD').trim() : firstCommit;
      const expectedFiles = (name === 'last' ? ['package.json', 'src/a.ts', 'src/b.ts'] : ['package.json', 'src/a.ts']).map((path) => recordKey('code.file', path)).sort();
      for (const lang of ['en', 'ru']) {
        const page = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id, lang, full: '1' })}`);
        expect(page.status).toBe(200);
        expect(page.body.findings).toEqual([]);
        const blocks: Block[] = page.body.blocks;
        expect(blocks.filter((entry) => entry.type === 'problem')).toEqual([]);
        const details = blocks.find((entry): entry is Extract<Block, { type: 'properties' }> => entry.type === 'properties');
        expect(details).toBeDefined();
        if (!details) throw new Error(`Landmark page ${id} in ${lang} omitted its properties block`);
        expect(details.title).toBe(lang === 'ru' ? 'Сведения' : 'Details');
        expect(details.rows).toContainEqual({ name: 'commit', value: expectedCommit });
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
          const target = await get(`/products/tiny/api/k/page?${new URLSearchParams({ id: row.entity.id, lang })}`);
          expect(target.status).toBe(200);
          expect(target.body.findings).toEqual([]);
        }
        const neighbors = await get(`/products/tiny/api/k/neighborhood?${new URLSearchParams({ id, lang })}`);
        expect(neighbors.status).toBe(200);
        expect(neighbors.body.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining(expectedFiles));
      }
    }
  }, 30_000);

  test('a kind is listed from the graph in key order, filtered by text', async () => {
    const all = await get('/products/tiny/api/k/entities?kind=code.symbol');
    expect(all.body.rows.map((row: { id: string }) => row.id)).toEqual([sym('src/a.ts#leaf'), sym('src/a.ts#root'), sym('src/b.ts#entry')]);
    expect(all.body.total).toBe(3);
    const some = await get('/products/tiny/api/k/entities?kind=code.symbol&q=ent');
    expect(some.body.rows.map((row: { id: string }) => row.id)).toEqual([sym('src/b.ts#entry')]);
  });

  test('a domain map accepts the manifest kind scope rather than looking for an entity with that id', async () => {
    const map = await get('/products/tiny/api/k/view?type=domain-map&subject=domain&lang=en');
    expect(map.status).toBe(200);
    expect(map.body.views[0]).toMatchObject({ spec: { type: 'domain-map', subject: 'domain' }, empty: expect.any(String) });
  });

  test('filling again an unchanged repository is done at once and changes no page', async () => {
    const before = (await get(`/products/tiny/api/k/page?id=${encodeURIComponent(sym('src/a.ts#root'))}`)).body;
    const started = await fetch(`${server.url}/products/tiny/api/k/fill`, { method: 'POST' });
    expect(started.status).toBe(202);
    for (let tries = 0; tries < 400; tries += 1) {
      const status = (await get('/products/tiny/api/k/status')).body;
      if (status.fill.state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 250));
    }
    const after = (await get(`/products/tiny/api/k/page?id=${encodeURIComponent(sym('src/a.ts#root'))}`)).body;
    expect(after).toEqual(before);
  }, 120_000);
});

describe('what a refresh changed', () => {
  /** Presses the fill and waits for its end: the status the Sync button reads when it opens its result. */
  const refresh = async (): Promise<any> => {
    const press = await fetch(`${server.url}/products/tiny/api/k/fill`, { method: 'POST' });
    expect(press.status).toBe(202);
    let status: any;
    for (let tries = 0; tries < 400; tries += 1) {
      status = (await get('/products/tiny/api/k/status')).body;
      if (status.fill.state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 250));
    }
    if (status === undefined || status.fill.state === 'running') throw new Error('the fill of the tiny product did not end within 100 s');
    // The pages the run changed are recorded when it ends, in a notify of their own: wait a little for the status that has them.
    for (let grace = 0; grace < 40 && status.fill.state === 'done' && status.fill.changed === undefined; grace += 1) {
      await new Promise((rest) => setTimeout(rest, 250));
      status = (await get('/products/tiny/api/k/status')).body;
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
      const opened = await get(`/products/tiny/api/k/page?id=${encodeURIComponent(page.id)}`);
      expect(opened.status).toBe(200);
      expect(opened.body.title).toBe(page.title);
    }
    expect((await refresh()).fill).toMatchObject({ state: 'done', changed: [] });
  }, 180_000);
});
