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
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore } from '../src/graph/index.js';
import { readJournal, summarize } from '../src/mcp/journal.js';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, type PendingRepository } from '../src/mcp/server.js';

const PROJECT = path.resolve(import.meta.dir, '..');
const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-repo-'));
const STATE = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-state-'));
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-home-'));
const STORE = path.join(STATE, 'graph');
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
  session = await RepositorySession.open({ repository: REPOSITORY, folder: STORE });
}, 180_000);

afterAll(async () => {
  await session.close();
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

async function answerOf(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Record<string, unknown> }> {
  const answered = await session.call(tool, args);
  return { isError: answered.isError, answer: answered.answer as Record<string, unknown> };
}

const json = (value: unknown): string => JSON.stringify(value);
const restore = (...paths: string[]): void => { git('checkout', '--', ...paths); };

beforeEach(() => {
  // Each case reads its own working tree: the checkout is restored and whatever a case left untracked is removed.
  git('checkout', '--', '.');
  git('clean', '-fdq');
});

describe('a caller edited alone keeps calling the file it did not change', () => {
  test('trace_flow from a function added to the edited caller reaches the unchanged callee', async () => {
    put('src/a.ts', `${A_SOURCE}\n/** Calls f from the new function. */\nexport function h(): number {\n  return f();\n}\n`);
    const added = await answerOf('get_symbol', { name: 'h' });
    expect(added.isError).toBe(false);
    expect(added.answer['selected']).toMatchObject({ key: 'code.symbol:src/a.ts#h' });
    const traced = await answerOf('trace_flow', { entry: 'h' });
    expect(traced.isError).toBe(false);
    expect(traced.answer['steps']).toContainEqual(expect.objectContaining({ relation: 'code.calls', to: expect.objectContaining({ key: 'code.symbol:src/b.ts#f' }) }));
    // The caller that was there before the edit keeps its call too: the edit must not take the base graph's edge away.
    const kept = await answerOf('trace_flow', { entry: 'g' });
    expect(kept.isError).toBe(false);
    expect(kept.answer['steps']).toContainEqual(expect.objectContaining({ relation: 'code.calls', to: expect.objectContaining({ key: 'code.symbol:src/b.ts#f' }) }));
    restore('src/a.ts');
  }, 120_000);
});

describe('a callee deleted from the working tree is no caller\'s callee', () => {
  test('get_symbol of the unchanged caller names no callee the file on disk no longer declares', async () => {
    rmSync(path.join(REPOSITORY, 'src/b.ts'));
    const answered = await answerOf('get_symbol', { name: 'g' });
    expect(answered.isError).toBe(false);
    expect(json(answered.answer['callees'])).not.toContain('code.symbol:src/b.ts#f');
    const traced = await answerOf('trace_flow', { entry: 'g' });
    expect(traced.isError).toBe(false);
    expect(json(traced.answer['steps'])).not.toContain('code.symbol:src/b.ts#f');
    git('checkout', '--', 'src/b.ts');
  }, 120_000);
});

describe('the producers that are not code are read again when their files change', () => {
  test('an uncommitted migration shows its table, and a dropped table stops answering', async () => {
    put('db/migrations/0002-orders.sql', 'CREATE TABLE saved_orders (\n  id TEXT PRIMARY KEY\n);\n');
    const fresh = await answerOf('get_context', { entity: 'code.table:review-kit/public.saved_orders', purpose: 'domain' });
    expect(fresh.isError).toBe(false);
    expect(fresh.answer['entity']).toMatchObject({ key: 'code.table:review-kit/public.saved_orders' });
    rmSync(path.join(REPOSITORY, 'db/migrations/0002-orders.sql'));
    // The table the working tree no longer declares is hidden by the provenance of the migration that declared it.
    put('db/migrations/0001-init.sql', 'CREATE TABLE archived_items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL\n);\n');
    const gone = await answerOf('get_context', { entity: 'code.table:review-kit/public.saved_items', purpose: 'domain' });
    expect(gone.isError).toBe(true);
    expect(json(gone.answer['error'])).toContain('saved_items');
    restore('db/migrations/0001-init.sql');
  }, 180_000);
});

describe('a migration that alters a table an unchanged migration declares', () => {
  test('an added ALTER resolves the table of the migration it does not touch, and the column it adds answers', async () => {
    // The recheck's input: `items` stands in the committed 0001, and 0002 arrives without a commit.
    put('db/migrations/0002-note.sql', 'ALTER TABLE items ADD COLUMN note text;\n');
    const table = await answerOf('get_context', { entity: 'code.table:review-kit/public.items', purpose: 'domain' });
    expect(table.isError).toBe(false);
    expect(table.answer['entity']).toMatchObject({ key: 'code.table:review-kit/public.items' });
    expect(json(table.answer)).toContain('note');
    const column = await answerOf('get_context', { entity: 'code.table:review-kit/public.items/note', purpose: 'domain' });
    expect(column.isError).toBe(false);
    expect(column.answer['entity']).toMatchObject({ key: 'code.table:review-kit/public.items/note', kind: 'code.column' });
    // The table the unchanged migration declares keeps the columns it declared there.
    const held = await answerOf('get_context', { entity: 'code.table:review-kit/public.items', purpose: 'domain' });
    expect(json(held.answer)).toContain('name');
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

describe('a refresh that fails answers that request and keeps serving', () => {
  test('a dirty symlink to a directory is an error of the call, and the next call answers', async () => {
    symlinkSync(REPOSITORY, path.join(REPOSITORY, 'src/loop.ts'));
    const failed = await session.call('get_symbol', { name: 'g' });
    expect(failed.isError).toBe(true);
    expect(json(failed.answer)).toContain('src/loop.ts');
    // The protocol layer answers the same failure as a tool result, never by ending the stream.
    const overProtocol = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'g' } } }, session);
    expect((overProtocol?.['result'] as Record<string, unknown>)['isError']).toBe(true);
    unlinkSync(path.join(REPOSITORY, 'src/loop.ts'));
    const after = await answerOf('get_symbol', { name: 'g' });
    expect(after.isError).toBe(false);
    expect(after.answer['selected']).toMatchObject({ key: 'code.symbol:src/a.ts#g' });
  }, 120_000);
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

describe('a graph madarch already holds for the commit is reused, not rebuilt', () => {
  test('a product store at HEAD in the madarch home serves a fresh MCP folder without extracting', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    const productStore = path.join(HOME, 'products', '.madarch', 'knowledge', 'review-product', 'graph');
    mkdirSync(path.dirname(productStore), { recursive: true });
    const owner = createPGliteDatabaseOwner({ path: productStore, btreeGist: true, relaxedDurability: true });
    const store = createGraphStore(owner);
    await store.createSchema();
    await fillGraph({ owner, store, repository: REPOSITORY, extractors: TREE_EXTRACTORS });
    await owner.run((tx) => tx.query('CREATE TABLE IF NOT EXISTS knowledge_fill (repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL, commits int NOT NULL, filled_commits int NOT NULL)'));
    await owner.run((tx) => tx.query('INSERT INTO knowledge_fill (repo, scope, head, commit_hash, effective_time, commits, filled_commits) VALUES ($1, $2, $3, $4, $5, 1, 1)', [path.basename(REPOSITORY), 'review', head, head, new Date().toISOString()]));
    await owner.close();
    const lines: string[] = [];
    const reused = await RepositorySession.open({ repository: REPOSITORY, folder: path.join(STATE, 'reused'), env: { ...process.env, MADARCH_HOME: HOME }, log: (line) => { lines.push(line); } });
    try {
      expect(lines.join('\n')).toContain('reusing the graph');
      expect(existsSync(path.join(STATE, 'reused', 'graph'))).toBe(true);
      const answered = await reused.call('get_symbol', { name: 'f' });
      expect(answered.isError).toBe(false);
      expect((answered.answer as Record<string, unknown>)['selected']).toMatchObject({ key: 'code.symbol:src/b.ts#f' });
    } finally {
      await reused.close();
    }
  }, 180_000);
});
