/**
 * The wiki's fill button and the pages it publishes (decision 0033, item 1; the owner's item 3): a small product is
 * filled through the route the button calls, over HTTP, and its pages are then read over HTTP — the graph the pages
 * show is the one this path published.
 *
 * The product is a fixture this test makes: its manifest, its workflow manifest (the starter set's first fill), one
 * code repository with one source file. No model runs: the fill is the static stages, and the pages that a model would
 * write are absent by design.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

let root = '';
let home = '';
let product = '';
let server: StartedServer;

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-fill-button-'));
  home = join(root, 'products');
  product = join(home, 'walk');
  const repository = join(root, 'walk-code');
  mkdirSync(join(product, 'repos'), { recursive: true });
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(product, 'docs'), { recursive: true });
  expect(git(repository, 'init', '-q', '-b', 'main')).toBe('');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(repository, join(product, 'repos', 'walk-code'), 'dir');
  writeFileSync(join(repository, 'package.json'), '{\n  "name": "walk-code",\n  "version": "1.0.0",\n  "type": "module"\n}\n');
  writeFileSync(join(repository, 'src', 'slice.ts'), '/** Splits a list. */\nexport function halvesOf(items: readonly number[]): number[] {\n  return items.slice(0, 1);\n}\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'the code the walk reads');
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: 6a2f3c14-6a4e-4b0a-9a2c-2f7a1b3c4d5e\nname: walk\nrepos:\n  - name: walk-code\n    url: file:///walk-code\n');
  writeFileSync(join(product, 'docs', 'product.md'), '# Walk\n\nA small product the walk fills.\n');
  writeFirstFillWorkflow(product);
  git(product, 'init', '-q', '-b', 'main');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'the product the walk fills');
  // The app's built files are not what this walk reads: the routes answer JSON, and the server asks only for an
  // app folder that exists.
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>walk</title>\n');
  server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 180_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

const json = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.url}${path}`, { headers: { accept: 'application/json' } });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

test('the button fills the store and the pages read the graph it published', async () => {
  // The press the button makes: the product's own route, no agent, no model.
  const pressed = await fetch(`${server.url}/products/walk/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  const started = (await pressed.json()) as { fill: { state: string } };
  expect(started.fill.state).toBe('running');
  // The run ends on its own; the pages are read after it.
  let state = '';
  let filledAt: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 600 && state !== 'done'; attempt++) {
    const status = await json('/products/walk/api/k/status');
    expect(status.status).toBe(200);
    filledAt = status.body;
    state = String((filledAt['fill'] as { state?: string } | undefined)?.state ?? '');
    if (state === 'failed' || state === 'stopped') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect({ state, message: (filledAt['fill'] as { message?: string } | undefined)?.message }).toEqual({ state: 'done', message: undefined });
  // The graph the pages read is the one this fill published: the fixture's file, symbol and the repository stand in it.
  const files = await json('/products/walk/api/k/entities?kind=code.file&limit=100');
  expect(files.status).toBe(200);
  expect(JSON.stringify(files.body)).toContain('src/slice.ts');
  const symbols = await json('/products/walk/api/k/entities?kind=code.symbol&limit=100');
  expect(symbols.status).toBe(200);
  expect(JSON.stringify(symbols.body)).toContain('halvesOf');
  // The status names the repository the fill pinned, read from the store's own `knowledge_fill` rows.
  expect(JSON.stringify(filledAt)).toContain('walk-code');
}, 240_000);
