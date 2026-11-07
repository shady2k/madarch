/**
 * The review of madarch-ztyq.10 (PR #211), case by case: the freshness gaps a
 * person's checkout exposes, the provenance every answer names, what the journal
 * counts, the server that answers while its graph is still building, and the
 * reuse of a graph that already exists.
 *
 * The fixture is a throwaway repository with neutral names: a caller and its
 * callee in two files, two declarations that share a name, a SQL migration and
 * an OpenAPI document.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);
import { readJournal, summarize } from '../src/mcp/journal.js';
import { mcpStoreFolder } from '../src/mcp/graph.js';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, type PendingRepository } from '../src/mcp/server.js';

const PROJECT = path.resolve(import.meta.dir, '..');
const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-repo-'));
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-home-'));
const COMMIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPOSITORY, encoding: 'utf8', env: COMMIT_ENV });

function put(relativePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(REPOSITORY, relativePath)), { recursive: true });
  writeFileSync(path.join(REPOSITORY, relativePath), text, 'utf8');
}

const A_SOURCE = "import { f } from './b.js';\n\n/** Calls f. */\nexport function g(): number {\n  return f();\n}\n";
const B_SOURCE = '/** The number one. */\nexport function f(): number {\n  return 1;\n}\n';
const INIT_SQL = 'CREATE TABLE saved_items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL\n);\n\nCREATE TABLE items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL\n);\n';

let session: RepositorySession;

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  git('init', '-q', '-b', 'main');
  put('package.json', `${JSON.stringify({ name: 'review-kit', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  put('src/a.ts', A_SOURCE);
  put('src/b.ts', B_SOURCE);
  put('src/repeat-one.ts', '/** Repeats one. */\nexport function repeat(): number {\n  return 1;\n}\n');
  put('src/repeat-two.ts', '/** Repeats two. */\nexport function repeat(): number {\n  return 2;\n}\n');
  put('db/migrations/0001-init.sql', INIT_SQL);
  put('contracts/openapi/orders.yaml', 'openapi: 3.1.0\ninfo:\n  title: Orders\n  version: 1.0.0\npaths:\n  /orders:\n    get:\n      operationId: listOrders\n      responses:\n        \'200\':\n          description: the orders\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'review-kit: a caller and a callee, a migration, a contract');
  session = await RepositorySession.open({ repository: REPOSITORY });
}, 180_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await session.close();
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

async function answerOf(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Record<string, unknown> }> {
  const answered = await session.call(tool, args);
  return { isError: answered.isError, answer: answered.answer as Record<string, unknown> };
}

const json = (value: unknown): string => JSON.stringify(value);
const restore = (...paths: string[]): void => { git('checkout', '--', ...paths); };

beforeEach(() => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  // Each case reads its own working tree: the checkout is restored and whatever a case left untracked is removed.
  git('checkout', '--', '.');
  git('clean', '-fdq');
});

describe('a file the working tree changed is named, and the facts stay the filled commit\'s', () => {
  test('a function added to a file without a commit is not a fact of the store, and the trace from the committed caller stands', async () => {
    put('src/a.ts', `${A_SOURCE}\n/** Calls f from the new function. */\nexport function h(): number {\n  return f();\n}\n`);
    const added = await answerOf('get_symbol', { name: 'h' });
    // The store is the fill's at the commit: an edit is not read by a second extraction.
    expect(added.isError).toBe(true);
    expect(json(added.answer)).toContain('no-such-symbol');
    expect((added.answer['source'] as Record<string, unknown>)['dirty']).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
    // The caller the commit holds keeps its call: its facts did not move, and no edit takes them away.
    const kept = await answerOf('trace_flow', { entry: 'g' });
    expect(kept.isError).toBe(false);
    expect(kept.answer['steps']).toContainEqual(expect.objectContaining({ relation: 'code.calls', to: expect.objectContaining({ key: 'code.symbol:src/b.ts#f' }) }));
    restore('src/a.ts');
  }, 120_000);

  test('a callee deleted from the working tree is still the committed caller\'s callee, and the deletion is named', async () => {
    rmSync(path.join(REPOSITORY, 'src/b.ts'));
    const traced = await answerOf('trace_flow', { entry: 'g' });
    expect(traced.isError).toBe(false);
    expect(json(traced.answer['steps'])).toContain('code.symbol:src/b.ts#f');
    expect((traced.answer['source'] as Record<string, unknown>)['dirty']).toContainEqual({ path: 'src/b.ts', status: 'deleted' });
    git('checkout', '--', 'src/b.ts');
  }, 120_000);

  test('a migration added without a commit is a changed path, not a table of the store', async () => {
    put('db/migrations/0002-orders.sql', 'CREATE TABLE saved_orders (\n  id TEXT PRIMARY KEY\n);\n');
    const fresh = await answerOf('get_context', { entity: 'code.table:review-kit/public.saved_orders', purpose: 'domain' });
    expect(fresh.isError).toBe(true);
    expect((fresh.answer['source'] as Record<string, unknown>)['dirty']).toContainEqual({ path: 'db/migrations/0002-orders.sql', status: 'untracked' });
    rmSync(path.join(REPOSITORY, 'db/migrations/0002-orders.sql'));
  }, 120_000);

  test('a migration that alters a table an unchanged migration declares is named, never applied', async () => {
    put('db/migrations/0002-note.sql', 'ALTER TABLE items ADD COLUMN note text;\n');
    const table = await answerOf('get_context', { entity: 'code.table:review-kit/public.items', purpose: 'domain' });
    expect(table.isError).toBe(false);
    expect(table.answer['entity']).toMatchObject({ key: 'code.table:review-kit/public.items' });
    // The commit's columns stand: the added column is not a fact of the store.
    expect(json(table.answer)).toContain('name');
    expect(json(table.answer)).not.toContain('note');
    const column = await answerOf('get_context', { entity: 'code.table:review-kit/public.items/note', purpose: 'domain' });
    expect(column.isError).toBe(true);
    expect((column.answer['source'] as Record<string, unknown>)['dirty']).toContainEqual({ path: 'db/migrations/0002-note.sql', status: 'untracked' });
    restore('db/migrations/0001-init.sql');
    rmSync(path.join(REPOSITORY, 'db/migrations/0002-note.sql'));
  }, 120_000);
});

describe('every answer names the revision it was read at, refusals too', () => {
  test('a missing symbol and a bad argument both answer with the commit and the dirty files', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    const missing = await answerOf('get_symbol', { name: 'no-such-symbol-anywhere' });
    expect(missing.isError).toBe(true);
    expect(missing.answer['source']).toMatchObject({ repository: REPOSITORY, commit: head, dirty: [] });
    const bad = await answerOf('get_symbol', {});
    expect(bad.isError).toBe(true);
    expect(bad.answer['source']).toMatchObject({ commit: head });
  }, 60_000);
});

describe('the journal separates what it measured from what it estimated', () => {
  test('an ambiguous lookup covers candidate files but avoids no read, and repeated calls are counted once', async () => {
    const ambiguous = await answerOf('get_symbol', { name: 'repeat' });
    expect(ambiguous.isError).toBe(false);
    expect(ambiguous.answer['candidates']).toHaveLength(2);
    const afterAmbiguous = readJournal(session.stateFolder).at(-1)!;
    expect(afterAmbiguous.tool).toBe('get_symbol');
    expect(afterAmbiguous.readsAvoided).toBe(0);
    expect(afterAmbiguous.questionsAnswered).toBe(0);
    expect(afterAmbiguous.evidenceFiles).toBe(2);
    const before = summarize(session.stateFolder).readsAvoided;
    // `f` has not been looked up before, so the pair's saving is new: the first call saves one read, the second none.
    await answerOf('get_symbol', { name: 'f' });
    await answerOf('get_symbol', { name: 'f' });
    const summary = summarize(session.stateFolder);
    const symbol = summary.tools.find((one) => one.tool === 'get_symbol')!;
    expect(symbol.calls).toBeGreaterThanOrEqual(3);
    expect(symbol.uniqueCalls).toBeGreaterThanOrEqual(2);
    // The second of two identical calls adds no saving: one file read avoided is what the pair saved.
    expect(summary.readsAvoided - before).toBe(1);
    expect(summary.questionsAnswered).toBeGreaterThan(0);
    expect(summary.evidenceFiles).toBeGreaterThan(0);
  }, 120_000);
});

describe('a commit that moves HEAD moves the store through the one fill', () => {
  test('a symbol the new commit adds answers at once, and the answer names the new as-is commit', async () => {
    put('src/fresh.ts', '/** The number two. */\nexport function two(): number {\n  return 2;\n}\n');
    git('add', '-A');
    git('-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'review-kit: add two');
    const head = git('rev-parse', 'HEAD').trim();
    const answered = await answerOf('get_symbol', { name: 'two' });
    expect(answered.isError).toBe(false);
    expect(answered.answer['selected']).toMatchObject({ key: 'code.symbol:src/fresh.ts#two' });
    expect((answered.answer['source'] as Record<string, unknown>)['commit']).toBe(head);
    expect((answered.answer['source'] as Record<string, unknown>)['dirty']).toEqual([]);
  }, 180_000);
});

describe('the server answers before its graph is built', () => {
  test('initialize and tools/list answer at once, and a tool call says the graph is building', async () => {
    const pending: PendingRepository = { repository: REPOSITORY, ready: new Promise<RepositorySession>(() => {}) };
    const started = performance.now();
    const initialized = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, pending);
    expect((initialized?.['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'madarch' });
    expect(performance.now() - started).toBeLessThan(5_000);
    const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, pending);
    expect(((listed?.['result'] as Record<string, unknown>)['tools'] as unknown[]).length).toBe(7);
    const called = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'g' } } }, pending);
    const result = called?.['result'] as Record<string, unknown>;
    const text = (result['content'] as { text: string }[])[0]!.text;
    expect(text).toContain('graph building');
    expect((JSON.parse(text) as Record<string, unknown>)['source']).toMatchObject({ repository: REPOSITORY, building: true });
    // A session that is open answers its tools as it always did.
    const ready = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'g' } } }, { repository: REPOSITORY, ready: Promise.resolve(session) });
    const body = JSON.parse(((ready?.['result'] as Record<string, unknown>)['content'] as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body['selected']).toMatchObject({ key: 'code.symbol:src/a.ts#g' });
  }, 60_000);
});

describe('the store the button fills is read, not filled twice', () => {
  test('a second server at the same commit opens the store the first one filled, and fills nothing', async () => {
    const env = { ...process.env, MADARCH_HOME: HOME };
    const store = mcpStoreFolder(REPOSITORY, env);
    const first: string[] = [];
    const filled = await RepositorySession.open({ repository: REPOSITORY, env, log: (line) => { first.push(line); } });
    try {
      expect(first.join('\n')).toContain('filling');
      expect(existsSync(path.join(store, 'graph'))).toBe(true);
      const answered = await filled.call('get_symbol', { name: 'f' });
      expect(answered.isError).toBe(false);
    } finally {
      await filled.close();
    }
    const second: string[] = [];
    const reused = await RepositorySession.open({ repository: REPOSITORY, env, log: (line) => { second.push(line); } });
    try {
      // The store holds this commit: the start reads it, and the one fill is not run again.
      expect(store).toBe(mcpStoreFolder(REPOSITORY, env));
      expect(second.join('\n')).not.toContain('filling');
      const answered = await reused.call('get_symbol', { name: 'f' });
      expect(answered.isError).toBe(false);
      expect((answered.answer as Record<string, unknown>)['selected']).toMatchObject({ key: 'code.symbol:src/b.ts#f' });
    } finally {
      await reused.close();
    }
  }, 180_000);
});
