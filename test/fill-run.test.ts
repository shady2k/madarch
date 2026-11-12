import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * The one fill (madarch-8bdc.2.5, item 6): `runFill` over a neutral fixture — every
 * step, one step alone, and a path subset — through the same function every caller
 * uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { listFiles, repositoryFacts } from '../src/graph/index.js';
import { runFill } from '../src/fill/run.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { readFillEnd } from '../src/fill/orchestrator-store.js';
import { readRun } from '../src/fill/state-store.js';
import { startKnowledgeFill } from '../src/knowledge/fill-run.js';
import { fillSteps } from '../src/fill/steps.js';

let root = '';
let product = '';
let owner: DatabaseOwner | undefined;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-runfill-'));
  product = join(root, 'product');
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repository, 'docs', 'readme.md'), '# readme\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['add', '-A'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'one'], { cwd: repository });
  mkdirSync(join(product, 'repos'), { recursive: true });
  require('node:fs').symlinkSync(repository, join(product, 'repos', 'repo'), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1', 'id: 5c2e8a52-9c3e-4f7a-8b21-6d2e9c0a5b41', 'name: run-product', 'repos:', '  - name: repo', '    url: file:///repo', '',
  ].join('\n'));
  writeFirstFillWorkflow(product);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product');
  owner = await createTestDatabaseOwner({ btreeGist: true });
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the one fill', () => {
  test('names this step\'s passes and nothing else', () => {
    // The tree and the history, and the plugin turn that reads the file vertices the tree published
    // (decision 0035, items 6 and 15).
    expect(fillSteps()).toEqual(['plugin-turns', 'repository-history', 'repository-tree']);
  }, 120_000);

  test('runs every step through one function', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
    const preparedOwner = owner;
    const run = await runFill({ product, database: owner, runId: 'all-steps', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state).toBe('succeeded');
    expect([...new Set(run.units.map((unit) => unit.stageId))].sort()).toEqual(['repository-history', 'repository-tree']);
    const facts = await repositoryFacts(owner, 'repo');
    expect(facts?.fileCount).toBe(2);
    expect(facts?.commitCount).toBe(1);
  }, 300_000);

  test('runs one step alone through the same function', async () => {
    // A store of its own: the first case's run already published the tree at this commit, and a
    // second run writes nothing, so a unit is planned only where the step had not run.
    const alone = await createTestDatabaseOwner({ btreeGist: true });
    try {
      await prepareStore(alone, { contract: await readPinnedGraphContract(product) });
      const run = await runFill({ product, database: alone, steps: ['repository-tree'], runId: 'one-step', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(alone, { contract }); } });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect([...new Set(run.units.map((unit) => unit.stageId))]).toEqual(['repository-tree']);
      const facts = await repositoryFacts(alone, 'repo');
      expect(facts?.fileCount).toBe(2);
      // The history step did not run: no commit's own row stands.
      expect(facts?.commitCount).toBe(0);
    } finally {
      await alone.close();
    }
  }, 300_000);

  test('covers the paths a caller names, and refuses a step it does not hold', async () => {
    // A path subset is a fill of its own store: it writes what it covers and never retracts
    // what another fill wrote outside its paths.
    const narrow = await createTestDatabaseOwner({ btreeGist: true });
    try {
      await prepareStore(narrow, { contract: await readPinnedGraphContract(product) });
      const run = await runFill({ product, database: narrow, steps: ['repository-tree'], paths: ['src/'], runId: 'paths', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(narrow, { contract }); } });
      expect(run.ok).toBe(true);
      const files = await listFiles(narrow, { repository: 'repo', limit: 100 });
      expect(files.rows.map((row) => row.path)).toEqual(['src/a.ts']);
    } finally {
      await narrow.close();
    }
    if (owner === undefined) throw new Error('the store was not opened');
    await expect(runFill({ product, database: owner, steps: ['nope'], home: join(root, 'home') })).rejects.toThrow(/is not a step of this fill/);
  }, 300_000);

  test('a scoped fill after a full one leaves every file outside its paths standing', async () => {
    const store = await createTestDatabaseOwner({ btreeGist: true });
    const code = join(root, 'repo');
    const inCode = (...args: string[]): void => { execFileSync('git', ['-C', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); };
    try {
      await prepareStore(store, { contract: await readPinnedGraphContract(product) });
      const full = await runFill({ product, database: store, runId: 'full-tree', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(store, { contract }); } });
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.state).toBe('succeeded');
      const before = (await listFiles(store, { repository: 'repo', limit: 100 })).rows;
      expect(before.map((file) => file.path).sort()).toEqual(['docs/readme.md', 'src/a.ts']);
      const docsBlob = before.find((file) => file.path === 'docs/readme.md')!.blob;
      const oldBlob = before.find((file) => file.path === 'src/a.ts')!.blob;
      // A commit inside the scope moves one file; the fill of `src/` covers that path and no other.
      writeFileSync(join(code, 'src', 'a.ts'), 'export const a = 2;\n');
      inCode('add', '-A');
      inCode('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'two');
      await prepareStore(store, { contract: await readPinnedGraphContract(product) });
      const scoped = await runFill({ product, database: store, steps: ['repository-tree'], paths: ['src/'], runId: 'scoped-tree', home: join(root, 'home'), prepareContract: async (contract) => { await prepareStore(store, { contract }); } });
      expect(scoped.ok).toBe(true);
      if (!scoped.ok) return;
      expect(scoped.state).toBe('succeeded');
      const after = (await listFiles(store, { repository: 'repo', limit: 100 })).rows;
      // The file outside the scope stands with the blob it had: a scoped publication touches its scope only.
      expect(after.map((file) => file.path).sort()).toEqual(['docs/readme.md', 'src/a.ts']);
      expect(after.find((file) => file.path === 'docs/readme.md')!.blob).toBe(docsBlob);
      expect(after.find((file) => file.path === 'src/a.ts')!.blob).not.toBe(oldBlob);
    } finally {
      await store.close();
    }
  }, 300_000);
});

describe('the end of a run another process reads', () => {
  test('a run that could not start still writes its end, with the reason it gave, after the store it filled', async () => {
    // The api role states a fill from that row alone (madarch-8bdc.9): even a product with no manifest must
    // leave its end in the caller-prepared store, or the process that pressed the fill would answer `running` for ever.
    const store = join(root, 'end-store');
    const writer = await createDatabaseOwner({ store });
    await prepareStore(writer);
    const reader = await createDatabaseOwner({ store });
    const empty = join(root, 'no-manifest');
    mkdirSync(empty, { recursive: true });
    try {
      const run = await startKnowledgeFill({ productFolder: empty, storeFolder: store, runId: 'no-manifest', database: writer });
      const answer = await run.done;
      expect(answer.ok).toBe(false);
      const end = await readFillEnd(reader, 'no-manifest');
      expect(end).not.toBeNull();
      expect(end?.state).toBe('failed');
      expect(end?.message).toBe(answer.message);
      expect(end?.message).toContain('no-manifest');
      const failed = await readRun(reader, 'no-manifest');
      expect(failed?.state).toBe('failed');
      expect(failed?.product).toBe('no-manifest');
    } finally {
      await reader.close();
      await writer.close();
    }
  }, 120_000);
});
