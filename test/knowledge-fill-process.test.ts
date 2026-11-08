/**
 * The fill runs in a process of its own (madarch-m38l.4, decision 0033 item 27): a PGlite runs every statement on the
 * thread that owns it, so a store opened inside the server's process holds every page of the wiki while it boots and
 * while it is written. This file reads the three consequences a reader of the wiki sees:
 *
 * - the server's thread answers throughout the fill — no page waits on the store's boot (the CI failure measured
 *   2 454-2 936 ms for three pages while a first fill opened its store);
 * - a pin the reader opens carries the scope of the store's temporal graph or nothing, never a repository's name in a
 *   column the reader compares as an id (`invalid input syntax for type bigint: "shop"` was a failed page);
 * - the files the fill published are the kind `code.file`'s listing and its count, from the same store.
 *
 * Each product here is a fixture this test makes: one repository of four files and the product around it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import type { FillState } from '../src/knowledge/model.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

/** The bound a page of the wiki answers within while a fill runs: the owner's walk took about three seconds. */
const BOUND_MS = 300;

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';

/** The files the fixture repository holds, in code-point order. */
const FILES = ['README.md', 'docs/note.md', 'src/a.ts', 'src/nested/b.ts'];

const json = async (server: StartedServer, product: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.url}/products/${product}${path}`, { headers: { accept: 'application/json' } });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

/** One product with one repository of four files, and its own commit: what a fill of it reads. */
function makeWalk(name: string): void {
  const repository = join(root, `${name}-code`);
  mkdirSync(join(repository, 'src', 'nested'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  writeFileSync(join(repository, 'README.md'), '# Walk\n\nA fixture.\n');
  writeFileSync(join(repository, 'docs', 'note.md'), '# Note\n\nA note.\n');
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'the tree is written');
  const folder = makeProduct(home, name, repository, `${name}-code`);
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', `the product ${name}`);
}

/** Presses the fill and waits for the run to end; answers the fill state that says how it ended. */
async function fill(server: StartedServer, name: string): Promise<FillState> {
  const pressed = await fetch(`${server.url}/products/${name}/api/k/fill`, { method: 'POST' });
  expect(pressed.status).toBe(202);
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await json(server, name, '/api/k/status');
    const state = (status.body['fill'] as FillState).state;
    if (state !== 'running') return status.body['fill'] as FillState;
    await new Promise((rest) => setTimeout(rest, 100));
  }
  throw new Error('the fill never ended');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-fill-process-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  makeWalk('thread');
  makeWalk('walk');
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the wiki while a fill runs', () => {
  test('the server’s thread answers throughout the fill: no page waits on the store the fill opens', async () => {
    const errors: string[] = [];
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: (line) => { errors.push(line); } });
    try {
      // The pattern that failed in CI: the wiki is open before the press, and the pages are asked while the fill runs.
      for (const path of ['/api/k/status', '/api/k/entities?kind=code.file&limit=100']) await json(server, 'thread', path);
      // The server's own thread, sampled every 5 ms: a page waits for whatever the thread is doing when it is asked.
      const gaps: { at: number; ms: number }[] = [];
      const startedAt = performance.now();
      let expected = performance.now() + 5;
      const timer = setInterval(() => {
        const now = performance.now();
        const late = now - expected;
        if (late > 20) gaps.push({ at: Math.round(expected - startedAt), ms: Math.round(late) });
        expected = now + 5;
      }, 5);
      let asked = 0;
      let slowest = 0;
      let ended: FillState | undefined;
      try {
        const pressed = await fetch(`${server.url}/products/thread/api/k/fill`, { method: 'POST' });
        expect(pressed.status).toBe(202);
        for (let attempt = 0; attempt < 1200; attempt++) {
          const before = performance.now();
          const status = await json(server, 'thread', '/api/k/status');
          const files = await json(server, 'thread', '/api/k/entities?kind=code.file&limit=100');
          slowest = Math.max(slowest, performance.now() - before);
          expect(status.status).toBe(200);
          expect(files.status).toBe(200);
          asked += 1;
          const fill = status.body['fill'] as FillState;
          if (fill.state !== 'running') { ended = fill; break; }
          await new Promise((rest) => setTimeout(rest, 40));
        }
      } finally {
        clearInterval(timer);
      }
      expect(ended?.state).toBe('done');
      expect(asked).toBeGreaterThan(2);
      const blocked = gaps.reduce((worst, gap) => (gap.ms > worst.ms ? gap : worst), { at: 0, ms: 0 });
      // The bound a page answers within: the thread that serves the pages is never held by the fill's store for longer.
      expect(blocked.ms, `the server's thread was blocked for ${String(blocked.ms)} ms at ${String(blocked.at)} ms into the fill, and a page asked then waited for it`).toBeLessThan(BOUND_MS);
      expect(Math.round(slowest), `the slowest status-and-files answer during the fill was ${String(Math.round(slowest))} ms`).toBeLessThan(BOUND_MS);
      expect(errors).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 300_000);
});

describe('the store a fill wrote', () => {
  // One fill for both cases below: they read the store it left, not a run of their own.
  beforeAll(async () => {
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      expect((await fill(server, 'walk')).state).toBe('done');
    } finally {
      await server.stop();
    }
  }, 120_000);

  test('a pin carries the scope of the store’s temporal graph or nothing, and a code page of this store draws', async () => {
    // The store this fill wrote: its pins are what the reader opens. A pin's scope is an id of the temporal graph, and
    // this fill publishes no version, so the column says NULL — a repository's name there failed a page with
    // `invalid input syntax for type bigint`.
    const storeFolder = productStoreFolder(join(home, 'walk'), knowledgeRootOf(home));
    const owner = createPGliteDatabaseOwner({ path: join(storeFolder, 'graph'), btreeGist: true });
    try {
      await owner.ready;
      const pins = (await owner.run((tx) => tx.query<{ repo: string; scope: string | null }>('SELECT repo, scope FROM knowledge_fill ORDER BY repo'))).rows;
      expect(pins.map((pin) => pin.repo)).toEqual(['walk', 'walk-code']);
      for (const pin of pins) expect(pin.scope).toBeNull();
    } finally {
      await owner.close();
    }
    const errors: string[] = [];
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: (line) => { errors.push(line); } });
    try {
      // A code page of the store, and the page's own history navigation: the reads that named a scope.
      const page = await json(server, 'walk', `/api/k/page?id=${encodeURIComponent('code.file:src/a.ts')}`);
      expect([200, 404]).toContain(page.status);
      const symbol = await json(server, 'walk', `/api/k/page?id=${encodeURIComponent('code.symbol:src/a.ts#a')}`);
      expect([200, 404]).toContain(symbol.status);
      expect((await json(server, 'walk', '/api/k/status')).status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 120_000);

  test('the files the store published are the kind code.file’s listing and its count', async () => {
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const repository = await json(server, 'walk', '/api/k/repository');
      expect(repository.status).toBe(200);
      const counts = (repository.body['repository'] as { counts: { files: number } }).counts;
      expect(counts.files).toBe(FILES.length);
      const listing = await json(server, 'walk', '/api/k/entities?kind=code.file&limit=100');
      expect(listing.status).toBe(200);
      const held = listing.body as { total: number; rows: { id: string; label: string; href: string }[]; next: string | null };
      // The listing answers the files the fill published, and its count is the store's own count of them.
      expect(held.rows.map((row) => row.label)).toEqual(FILES);
      expect(held.total).toBe(counts.files);
      expect(held.rows.length).toBe(Math.min(100, held.total));
      expect(held.next).toBeNull();
      // A file's page is the repository's own, and its place is the file.
      const first = held.rows[0]!;
      expect(first.id).toBe(`code.file:${first.label}`);
      expect(first.href).toBe(`/k/file?${new URLSearchParams({ path: first.label }).toString()}`);
      // The listing's filter reads the store: a path prefix, and the count of what it holds.
      const filtered = await json(server, 'walk', `/api/k/entities?kind=code.file&limit=100&q=${encodeURIComponent('src/')}`);
      const narrowed = filtered.body as { total: number; rows: { label: string }[] };
      expect(narrowed.rows.map((row) => row.label)).toEqual(['src/a.ts', 'src/nested/b.ts']);
      expect(narrowed.total).toBe(2);
    } finally {
      await server.stop();
    }
  }, 120_000);
});
