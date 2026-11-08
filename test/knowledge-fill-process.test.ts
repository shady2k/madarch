/**
 * The fill runs in a process of its own (madarch-m38l.4, decision 0033 item 27): a PGlite runs every statement on the
 * thread that owns it, so a store opened inside the server's process holds every page of the wiki while it boots and
 * while it is written. The server's thread answers throughout the fill: no page waits on the store's boot (the CI
 * failure measured 2 454-2 936 ms for three pages while a first fill opened its store).
 *
 * Each product here is a fixture this test makes: one repository of four files and the product around it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FillState } from '../src/knowledge/model.js';
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

