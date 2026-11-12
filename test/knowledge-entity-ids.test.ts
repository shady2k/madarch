/**
 * Entity ids carry the reference a kind's natural key names (review of the CI wiki walk): two repositories that
 * each hold `docs` are two directory entities, not one id twice.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFill } from '../src/fill/run.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
let root = '';
let home = '';
let app = '';
let folder = '';
let server: StartedServer | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-entity-ids-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const first = join(root, 'first');
  const second = join(root, 'second');
  for (const [path, name] of [[first, 'first'], [second, 'second']] as const) {
    mkdirSync(join(path, 'docs'), { recursive: true });
    writeFileSync(join(path, 'docs', 'index.md'), `# ${name}\n`);
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', `${name} docs`);
  }
  folder = makeProduct(home, 'shop', first, 'first');
  useFixturePlugins(folder, ['disk']);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), `workflows:
  first-fill:
    status: implemented
    stages: [plugin-turns]
`);
  const manifest = join(folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'second', linked: true }));
  symlinkSync(second, join(folder, 'repos', 'second'));
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', 'Connect both fixture repositories');
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  mkdirSync(join(store, 'graph'), { recursive: true });
  const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
  try {
    await prepareStore(owner, { contract: await readPinnedGraphContract(folder) });
    const run = await runFill({ product: folder, database: owner, store, home: store, runId: 'two-repositories', prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
    expect(run.ok).toBe(true);
  } finally {
    await owner.close();
  }
  server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

test('two repositories sharing docs have two directory ids, each naming its repository', async () => {
  const answer = await fetch(`${server!.url}/products/shop/api/entities?kind=code.directory&limit=200`, { headers: { accept: 'application/json' } });
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { rows: { id: string; label: string }[]; total: number };
  const ids = body.rows.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain('code.directory:first/docs');
  expect(ids).toContain('code.directory:second/docs');
}, 30_000);
