/**
 * The wiki's fill button and the pages it publishes (madarch-8bdc.2.5, items 2 and 3): a small product is filled
 * through the route the button calls, over HTTP, and its pages are then read over HTTP — the repository, its tree and
 * one file, from the store this path published.
 *
 * The product is a fixture this test makes: its manifest, a native tree/history workflow, and one code repository
 * with one source file. No plugin or model runs: these pages need only repository inventory and history.
 */
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { afterAll, beforeAll, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';

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
  // The product holds its own copy of the starter set, as `madarch init` leaves it; the fill workflow is its own.
  seedStarterSet(product);
  useFixturePlugins(product, []);
  writeFileSync(join(product, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [repository-tree, repository-history]\n');
  git(product, 'init', '-q', '-b', 'main');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'the product the walk fills');
  // The app's built files are not what this walk reads: the routes answer JSON, and the server asks only for an
  // app folder that exists.
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>walk</title>\n');
  server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: (line) => console.error(line) });
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
  const pressed = await fetch(`${server.url}/products/walk/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  const started = (await pressed.json()) as { fill: { state: string } };
  expect(started.fill.state).toBe('running');
  // The run ends on its own; the pages are read after it.
  let state = '';
  let filledAt: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 600 && state !== 'done'; attempt++) {
    const status = await json('/products/walk/api/status');
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    filledAt = status.body;
    state = String((filledAt['fill'] as { state?: string } | undefined)?.state ?? '');
    if (state === 'failed' || state === 'stopped') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect({ state, message: (filledAt['fill'] as { message?: string } | undefined)?.message }).toEqual({ state: 'done', message: undefined });
  // Native inventory publishes facts, not agent-authored layouts. Supply the fixture's explicit graph templates.
  const owner = await createTestDatabaseOwner({
    store: storeDatabasePath(productStoreFolder(product, knowledgeRootOf(home))),
    graphContract: withManifestContract(await readPinnedGraphContract(product)),
  });
  try {
    await publishFixtureTemplate(owner, product, 'templates/repository.liquid', [
      { type: 'block', name: 'repository', params: {}, line: 1 },
      { type: 'block', name: 'folder', params: {}, line: 2 },
    ]);
    await publishFixtureTemplate(owner, product, 'templates/file.liquid', [
      { type: 'block', name: 'file-page', params: {}, line: 1 },
    ]);
  } finally { await owner.close(); }
  // The pages read the store this fill published: the repository's own page, its tree, and the file
  // page with the facts of the fixture's file (madarch-8bdc.2.5, items 2 and 3). The old entity index
  // of the agent stage is not what this step's fill writes, and no page is drawn from it here.
  expect(JSON.stringify(filledAt)).toContain('walk-code');
  expect((filledAt['repository'] as Record<string, unknown>)['steps']).toEqual({ 'tree': true, 'history': true });
  const repository = await json('/products/walk/api/page?id=code.repository%3Awalk-code&full=1');
  expect(repository.status, JSON.stringify(repository.body)).toBe(200);
  expect(JSON.stringify(repository.body)).toContain('walk-code');
  const rootBlock = (repository.body['blocks'] as { type: string; data: Record<string, unknown> }[]).find((block) => block.type === 'folder')!;
  expect((rootBlock.data['folders'] as { path: string }[]).map((folder) => folder.path)).toContain('src');
  const file = await json('/products/walk/api/page?id=code.file%3Awalk-code%2Fsrc%2Fslice.ts&full=1');
  expect(file.status).toBe(200);
  const fileBlock = (file.body['blocks'] as { type: string; data: Record<string, unknown> }[]).find((block) => block.type === 'filePage')!;
  expect(fileBlock.data['path']).toBe('src/slice.ts');
  expect(fileBlock.data['created']).not.toBeNull();
  const history = (fileBlock as unknown as { history: unknown[] }).history;
  expect(history.length).toBe(1);
}, 240_000);

test('the server still answers a page after the fill queue has been left alone', async () => {
  // A store's pg-boss asks its owner for statements on its own timer: a queue left open when the reader's owner
  // closes is the crash of madarch-8bdc.12. Wait past a supervise pass, then read a page.
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  const status = await fetch(`${server.url}/products/walk/api/status`, { headers: { accept: 'application/json' } });
  expect(status.status).toBe(200);
  const body = (await status.json()) as { product?: { name?: string } };
  expect(body.product?.name).toBe('walk');
}, 40_000);
