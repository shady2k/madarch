/**
 * A product's git holds its starter plugins' sources and their lock, never the packages those sources import
 * (madarch-64o5.72): `madarch init` writes `plugins/<id>/…` and `madarch/plugins.lock`, the packages a plugin's closure
 * declares stand in the machine store and are restored there from the release when the plugin runs, and the lock's hash
 * is what the restored bytes are held to. The plugin process is the proof that the sandbox resolves its packages from
 * that restored closure, with no `node_modules` anywhere in the product's working tree.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { parsePluginLock, type PluginLockEntry } from '../src/plugin/lock.js';
import { dependencyStoreFolder, lockedClosureOf } from '../src/plugin/dependency-store.js';
import { verifyBlobRead } from '../src/plugin/file-reads.js';
import { PluginHost } from '../src/plugin/host.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';
import type { FactsOperation } from '../src/plugin-sdk.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });

/** The reason this machine cannot run a plugin, when it cannot: the cases that need one are skipped with it. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

let root = '';
let product = '';
/** The product as a fresh clone holds it: the committed tree and nothing else — no packages, no store. */
let clone = '';
let locks: readonly PluginLockEntry[] = [];

/** The message a call refuses with, so an assertion reads what a person would be told. */
function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the call was expected to refuse, and it did not');
}

/** One plugin the product's lock names, or a failure that says which. */
function locked(id: string): PluginLockEntry {
  const entry = locks.find((held) => held.id === id);
  if (entry === undefined) throw new Error(`the product's lock names no plugin ${id}`);
  return entry;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-plugin-store-'));
  const draft = createDraft({ home: join(root, 'products'), name: 'stored', template: 'everything', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(`the draft was not made: ${JSON.stringify(draft)}`);
  product = draft.folder;
  clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', product, clone], { env, encoding: 'utf8' });
  const lock = parsePluginLock(readFileSync(join(clone, 'madarch', 'plugins.lock'), 'utf8'));
  if (!lock.ok) throw new Error(lock.message);
  locks = lock.entries;
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

test('a product made by madarch init carries its starter plugins\' sources and lock, and no dependency code', () => {
  const tracked = git(product, 'ls-files').split('\n').filter((path) => path !== '');
  expect(tracked.filter((path) => path.split('/').includes('node_modules'))).toEqual([]);
  // The sources and the lock are the product's own files, committed with the draft.
  expect(tracked).toContain('plugins/db-schema/main.ts');
  expect(tracked).toContain('plugins/db-schema/package.json');
  expect(tracked).toContain('madarch/plugins.lock');
  // The working tree holds no package either: init wrote none, and a clone of the product is the same tree.
  expect(existsSync(join(product, 'plugins', 'db-schema', 'node_modules'))).toBe(false);
  expect(existsSync(join(clone, 'plugins', 'db-schema', 'node_modules'))).toBe(false);
  // The lock names the closure the release carries, packages included: the hash covers the bytes the store restores.
  expect(locked('db-schema').closure).toMatch(/^[0-9a-f]{64}$/);
  expect(locked('git').closure).toMatch(/^[0-9a-f]{64}$/);
});

test('a fresh clone restores its plugin\'s dependency closure into the machine store and refuses a dependency somebody changed', () => {
  const store = join(root, 'store');
  const entry = locked('db-schema');
  const closure = lockedClosureOf(join(clone, 'plugins', 'db-schema'), entry, store);
  // The closure is the locked one, and its packages now stand in the store, named by that hash — never in the product.
  expect(closure.hash).toBe(entry.closure);
  const restored = dependencyStoreFolder(store, entry.closure);
  expect(closure.dependencies).toBe(restored);
  expect(existsSync(join(restored, 'node_modules', '@babel', 'parser', 'package.json'))).toBe(true);
  expect(existsSync(join(clone, 'plugins', 'db-schema', 'node_modules'))).toBe(false);
  // A second read reuses the restoration: the store is written once per closure, not once per run.
  expect(lockedClosureOf(join(clone, 'plugins', 'db-schema'), entry, store).hash).toBe(entry.closure);
  // The bytes somebody changed are refused by the lock's hash, and the refusal names the store they came from.
  const changed = join(restored, 'node_modules', '@babel', 'parser', 'lib', 'index.js');
  const original = readFileSync(changed, 'utf8');
  writeFileSync(changed, `${original}\nexport const changed = 1;\n`);
  try {
    const refusal = refusalOf(() => lockedClosureOf(join(clone, 'plugins', 'db-schema'), entry, store));
    expect(refusal).toContain(`with its dependencies restored at ${restored}`);
    expect(refusal).toContain(`and madarch/plugins.lock locks ${entry.closure}: a run executes exactly the closure the lock names`);
    expect(refusal).toMatch(/hashes to [0-9a-f]{64}/);
    // A read through a plugin is the same guard, and it refuses before any plugin process is started.
    const repository = join(clone, 'repos', 'sample');
    mkdirSync(repository, { recursive: true });
    git(repository, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'a.ts'), 'export const answer = 42;\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '--quiet', '-m', 'first');
    expect(refusalOf(() => verifyBlobRead({ product: clone, plugin: join('plugins', 'db-schema'), repository: 'sample', root: repository, blob: 'a'.repeat(40) }, store))).toContain(`and madarch/plugins.lock locks ${entry.closure}`);
  } finally {
    writeFileSync(changed, original);
  }
});

describe.skipIf(sandboxProblem !== undefined)('the restored closure at work', () => {
  test('the plugin runs from the machine store\'s packages, with no node_modules in the product', async () => {
    const store = join(root, 'run-store');
    const folder = join(clone, 'plugins', 'db-schema');
    const closure = lockedClosureOf(folder, locked('db-schema'), store);
    const workRoot = join(root, 'host');
    mkdirSync(join(workRoot, 'product', 'src'), { recursive: true });
    const source = 'export const sql = `CREATE TABLE people (id bigint PRIMARY KEY);`;\n';
    writeFileSync(join(workRoot, 'product', 'src', 'schema.ts'), source);
    const operations: FactsOperation[] = [];
    const repository = { kind: 'code.repository', key: { name: 'app' } };
    const file = { kind: 'code.file', key: { path: 'src/schema.ts' }, keyEdges: { 'code.file-repository': repository } };
    const host = new PluginHost({
      pluginFolder: folder,
      closure,
      repository: join(workRoot, 'product'),
      workRoot,
      trust: 'production',
      releaseHashes: [closure.hash],
      ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
      operations: { async apply(_unitId, _key, operation) { operations.push(operation as FactsOperation); return { accepted: true }; } },
      graph: {
        ownFacts: async () => ({ vertices: [], edges: [] }),
        files: async () => [file],
        value: async (_kind, _key, field) => field === 'blob' ? 'source-blob' : null,
      },
      readBlob: async () => ({ text: source, lines: source.split('\n').length, bytes: source.length, binary: false }),
    });
    const session = await host.open();
    try {
      // The plugin parses the file with `@babel/parser` and the SQL with `libpg-query`: both packages stand only in the
      // machine store's restoration, and a plugin that could not resolve them would not answer this unit.
      const outcome = await session.runUnit({ unitId: 'tables', kind: 'code.table', key: {}, inputs: { patterns: ['src/*.ts'] } });
      if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
      expect(outcome.result.end.state).toBe('complete');
      const tables = operations.flatMap((operation) => operation.vertices ?? []).filter((vertex) => vertex.kind === 'code.table');
      expect(tables.map((vertex) => vertex.key['name'])).toEqual(['people']);
      expect(existsSync(join(folder, 'node_modules'))).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);
});
