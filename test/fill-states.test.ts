/**
 * The wiki's fill states (madarch-8bdc.2.5, item 2): an empty product, the press,
 * the progress read from the run's own trace, the end state with the counts and
 * the time, and a failure with its file, line and path.
 *
 * The products are fixtures this test makes; no model runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { startKnowledgeFill } from '../src/knowledge/fill-run.js';
import type { FillProgressView } from '../src/knowledge/model.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';

/** A product whose one repository the test writes. */
function product(name: string, write: (repository: string) => void): string {
  const repository = join(root, `${name}-code`);
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  write(repository);
  const folder = makeProduct(home, name.trim(), repository, `${name}-code`);
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', `the product ${name}`);
  return folder;
}

const json = async (server: StartedServer, productName: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.url}/products/${productName}${path}`, { headers: { accept: 'application/json' } });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

/** Presses the fill and follows the status while it runs, answering every answer it saw. */
async function press(server: StartedServer, name: string): Promise<Record<string, unknown>[]> {
  const pressed = await fetch(`${server.url}/products/${name}/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  const seen: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await json(server, name, '/api/k/status');
    seen.push(status.body);
    const fill = status.body['fill'] as Record<string, unknown>;
    if (fill['state'] !== 'running') return seen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the fill never ended');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-fill-states-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the fill states', () => {
  test('an empty product is idle, the press runs, its progress is the run trace, and the end has the counts and the time', async () => {
    product('states', (repository) => {
      mkdirSync(join(repository, 'src', 'nested'), { recursive: true });
      writeFileSync(join(repository, 'README.md'), '# States\n');
      writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repository, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
      git(repository, 'add', '-A');
      git(repository, 'commit', '-qm', 'the tree is written');
    });
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const empty = await json(server, 'states', '/api/k/status');
      expect((empty.body['fill'] as Record<string, unknown>)['state']).toBe('idle');
      expect(empty.body['filled']).toBe(false);

      const seen = await press(server, 'states');
      const ended = seen[seen.length - 1]!;
      const fill = ended['fill'] as Record<string, unknown>;
      expect(fill['state']).toBe('done');
      // The counts and the time: the store's own numbers, and the run's own moments.
      expect(fill['counts']).toEqual({ files: 3, commits: 1, folders: 2 });
      expect(typeof fill['startedAt']).toBe('string');
      expect(typeof fill['finishedAt']).toBe('string');
      expect(ended['filled']).toBe(true);
      expect(ended['incomplete']).toBe(false);
      // A running answer carried the run's trace: its spans, or the units it planned.
      const running = seen.filter((one) => (one['fill'] as Record<string, unknown>)['state'] === 'running');
      expect(running.length).toBeGreaterThan(0);
      const progress = running.map((one) => (one['fill'] as Record<string, unknown>)['progress'] as FillProgressView | undefined).filter((one): one is FillProgressView => one !== undefined);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((one) => typeof one.spans === 'number' && typeof one.planned === 'number')).toBe(true);
      expect(Math.max(...progress.map((one) => one.spans))).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('a fill that cannot read its repository fails with its file and line, and the product path', async () => {
    // A declared repository that is no Git checkout: the product's pins refuse it by name, and the
    // message names the file and the line it was raised from. (A checkout that holds no commit is
    // not a failure: the run reads the other repositories and says what it did for it.)
    const repository = join(root, 'lost-code');
    mkdirSync(join(repository, 'src'), { recursive: true });
    git(repository, 'init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'src.ts'), 'export const a = 1;\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-qm', 'a repository the product connects');
    const folder = makeProduct(home, 'lost', repository, 'lost-code');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'a product whose checkout is replaced');
    // The connected checkout is replaced by a plain folder: it is no Git checkout any more.
    rmSync(join(folder, 'repos', 'lost-code'));
    mkdirSync(join(folder, 'repos', 'lost-code'), { recursive: true });
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const run = await startKnowledgeFill({ productFolder: folder, storeFolder: join(root, 'lost-store'), runId: 'lost', database: owner });
      const result = await run.done;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/src\/product\/fill-stages\.ts:\d+:\d+: .*is no Git checkout of its own/u);
    } finally {
      await owner.close().catch(() => undefined);
    }
  }, 300_000);
});
