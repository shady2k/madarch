/**
 * The review of the served checkout (madarch-ztyq.10's cases, on this step's
 * store): what a working tree that differs from the filled commit exposes, the
 * provenance every answer names, what the journal counts, the server that
 * answers while its store is still being filled, and a store that is read
 * rather than filled twice.
 *
 * The seven tools of decision 0032 read the temporal graph, which this step's
 * fill does not publish: their answers here name the step that has not run. The
 * review reads the five tools of this step, from the store the one fill wrote.
 *
 * The fixture is a throwaway repository with neutral names: a caller and its
 * callee in two files, two declarations that share a name, a SQL migration and
 * an OpenAPI document.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readJournal, summarize } from '../src/mcp/journal.js';
import { repositoryStoreFolder } from '../src/mcp/graph.js';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, SERVED_TOOL_NAMES, type PendingRepository } from '../src/mcp/server.js';

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
  session = await RepositorySession.open({ repository: REPOSITORY, env: { ...process.env, MADARCH_HOME: HOME } });
}, 180_000);

afterAll(async () => {
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
const source = (answer: Record<string, unknown>): Record<string, unknown> => answer['source'] as Record<string, unknown>;

beforeEach(() => {
  // Each case reads its own working tree: the checkout is restored and whatever a case left untracked is removed.
  git('checkout', '--', '.');
  git('clean', '-fdq');
});

describe('a file the working tree changed is named, and the facts stay the filled commit\'s', () => {
  test('a file added without a commit is not a file of the store, and the answer names the changed path', async () => {
    put('src/fresh.ts', '/** The number two. */\nexport function two(): number {\n  return 2;\n}\n');
    const added = await answerOf('get_file', { path: 'src/fresh.ts' });
    // The store is the fill's at the commit: an edit is not read by a second extraction.
    expect(added.isError).toBe(true);
    expect(json(added.answer)).toContain('no-such-file');
    expect(source(added.answer)['changed']).toEqual([{ path: 'src/fresh.ts', status: 'untracked' }]);
    rmSync(path.join(REPOSITORY, 'src/fresh.ts'));
  }, 120_000);

  test('an edit to a file\'s bytes is named, and the store\'s own answer stands', async () => {
    const before = await answerOf('get_file', { path: 'src/a.ts' });
    expect(before.isError).toBe(false);
    put('src/a.ts', A_SOURCE.replace('return f();', 'return f() + 1;'));
    const edited = await answerOf('get_file', { path: 'src/a.ts' });
    expect(edited.isError).toBe(false);
    // The same blob: the store is the commit's, and the changed path says the working tree moved past it.
    expect(edited.answer['blob']).toBe(before.answer['blob']);
    expect(source(edited.answer)['changed']).toEqual([{ path: 'src/a.ts', status: 'modified' }]);
    expect(source(edited.answer)['commit']).toBe(git('rev-parse', 'HEAD').trim());
    restore('src/a.ts');
  }, 120_000);

  test('a file deleted from the working tree is still the commit\'s record, and the deletion is named', async () => {
    rmSync(path.join(REPOSITORY, 'src/b.ts'));
    const held = await answerOf('get_file', { path: 'src/b.ts' });
    expect(held.isError).toBe(false);
    expect(held.answer['path']).toBe('src/b.ts');
    expect(source(held.answer)['changed']).toContainEqual({ path: 'src/b.ts', status: 'deleted' });
    // The commit that wrote it still answers for it.
    const history = await answerOf('get_file_history', { path: 'src/b.ts' });
    expect(history.isError).toBe(false);
    expect((history.answer['commits'] as unknown[]).length).toBe(1);
    git('checkout', '--', 'src/b.ts');
  }, 120_000);

  test('a migration added without a commit is a changed path, and the committed one still answers', async () => {
    put('db/migrations/0002-orders.sql', 'CREATE TABLE saved_orders (\n  id TEXT PRIMARY KEY\n);\n');
    const fresh = await answerOf('get_file', { path: 'db/migrations/0002-orders.sql' });
    expect(fresh.isError).toBe(true);
    expect(source(fresh.answer)['changed']).toContainEqual({ path: 'db/migrations/0002-orders.sql', status: 'untracked' });
    const committed = await answerOf('get_file', { path: 'db/migrations/0001-init.sql' });
    expect(committed.isError).toBe(false);
    expect(committed.answer['lines']).toBe(9);
    rmSync(path.join(REPOSITORY, 'db/migrations/0002-orders.sql'));
  }, 120_000);

  test('an altered table is not a fact of the store: the committed file\'s history is what answers', async () => {
    put('db/migrations/0002-note.sql', 'ALTER TABLE items ADD COLUMN note text;\n');
    const file = await answerOf('get_file', { path: 'db/migrations/0001-init.sql' });
    expect(file.isError).toBe(false);
    expect(file.answer['lines']).toBe(9);
    expect(source(file.answer)['changed']).toContainEqual({ path: 'db/migrations/0002-note.sql', status: 'untracked' });
    rmSync(path.join(REPOSITORY, 'db/migrations/0002-note.sql'));
  }, 120_000);
});

describe('every answer names the revision it was read at, refusals too', () => {
  test('a missing file and a bad argument both answer with the commit and the changed paths', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    const missing = await answerOf('get_file', { path: 'no-such-file.ts' });
    expect(missing.isError).toBe(true);
    expect(source(missing.answer)).toMatchObject({ repository: REPOSITORY, commit: head, changed: [] });
    const bad = await answerOf('get_file', {});
    expect(bad.isError).toBe(true);
    expect(source(bad.answer)).toMatchObject({ commit: head });
    // A tool of a later step names its step, and still says where it would have been true.
    const later = await answerOf('get_symbol', { name: 'g' });
    expect(later.isError).toBe(true);
    expect(later.answer['error']).toMatchObject({ code: 'step-not-run', step: 'syntax' });
    expect(source(later.answer)).toMatchObject({ commit: head, changed: [] });
  }, 60_000);
});

describe('the journal separates what it measured from what it estimated', () => {
  test('a record answer covers the files it names and avoids no read, and repeated calls are counted once', async () => {
    const listed = await answerOf('list_files', { prefix: 'src/' });
    expect(listed.isError).toBe(false);
    const covered = listed.answer['files'] as { path: string }[];
    expect(covered.length).toBeGreaterThan(0);
    const entry = readJournal(session.stateFolder).at(-1)!;
    expect(entry.tool).toBe('list_files');
    // Every answer is the store's: no file is read, so no read is avoided either.
    expect(entry.readsAvoided).toBe(0);
    expect(entry.covered).toEqual(covered.map((file) => file.path).sort());
    const before = summarize(session.stateFolder);
    const first = await answerOf('get_file', { path: 'src/repeat-one.ts' });
    expect(first.isError).toBe(false);
    const twice = await answerOf('get_file', { path: 'src/repeat-one.ts' });
    expect(twice.isError).toBe(false);
    const summary = summarize(session.stateFolder);
    const file = summary.tools.find((one) => one.tool === 'get_file')!;
    expect(file.calls - before.tools.find((one) => one.tool === 'get_file')!.calls).toBe(2);
    expect(file.uniqueCalls).toBeGreaterThanOrEqual(1);
    expect(summary.answerBytes).toBeGreaterThan(before.answerBytes);
  }, 120_000);
});

describe('a commit that moves HEAD moves the store through the one fill', () => {
  test('a file the new commit adds answers at once, and the answer names the new as-is commit', async () => {
    put('src/fresh.ts', '/** The number two. */\nexport function two(): number {\n  return 2;\n}\n');
    git('add', '-A');
    git('-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'review-kit: add two');
    const head = git('rev-parse', 'HEAD').trim();
    const answered = await answerOf('get_file', { path: 'src/fresh.ts' });
    expect(answered.isError).toBe(false);
    expect(answered.answer['path']).toBe('src/fresh.ts');
    expect(source(answered.answer)['commit']).toBe(head);
    expect(source(answered.answer)['changed']).toEqual([]);
  }, 180_000);
});

describe('the server answers before its store is filled', () => {
  test('initialize and tools/list answer at once, and a tool call says the store is building', async () => {
    const pending: PendingRepository = { repository: REPOSITORY, ready: new Promise<RepositorySession>(() => {}) };
    const started = performance.now();
    const initialized = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, pending);
    expect((initialized?.['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'madarch' });
    expect(performance.now() - started).toBeLessThan(5_000);
    const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, pending);
    expect(((listed?.['result'] as Record<string, unknown>)['tools'] as unknown[]).length).toBe(SERVED_TOOL_NAMES.length);
    const called = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_file', arguments: { path: 'src/a.ts' } } }, pending);
    const result = called?.['result'] as Record<string, unknown>;
    const text = (result['content'] as { text: string }[])[0]!.text;
    expect(text).toContain('graph building');
    expect((JSON.parse(text) as Record<string, unknown>)['source']).toMatchObject({ repository: REPOSITORY, building: true });
    // A session that is open answers its tools as it always did.
    const ready = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_file', arguments: { path: 'src/a.ts' } } }, { repository: REPOSITORY, ready: Promise.resolve(session) });
    const body = JSON.parse(((ready?.['result'] as Record<string, unknown>)['content'] as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body['path']).toBe('src/a.ts');
    expect(body['form']).toBe('text');
  }, 60_000);
});

describe('the store the button fills is read, not filled twice', () => {
  test('a second server at the same commit opens the store the first one filled, and fills nothing', async () => {
    // A products home of this case's own: one store serves one process at a time, and the suite's own
    // session holds the default home's store for the whole file.
    const home = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-review-reuse-'));
    const env = { ...process.env, MADARCH_HOME: home };
    const store = repositoryStoreFolder(REPOSITORY, env);
    const first: string[] = [];
    const filled = await RepositorySession.open({ repository: REPOSITORY, env, log: (line) => { first.push(line); } });
    try {
      expect(first.join('\n')).toContain('filling');
      expect(existsSync(path.join(store, 'graph'))).toBe(true);
      const answered = await filled.call('get_file', { path: 'src/a.ts' });
      expect(answered.isError).toBe(false);
    } finally {
      await filled.close();
    }
    const second: string[] = [];
    const reused = await RepositorySession.open({ repository: REPOSITORY, env, log: (line) => { second.push(line); } });
    try {
      // The store holds this commit: the start reads it, and the one fill is not run again.
      expect(store).toBe(repositoryStoreFolder(REPOSITORY, env));
      expect(second.join('\n')).not.toContain('filling');
      const answered = await reused.call('get_file', { path: 'src/b.ts' });
      expect(answered.isError).toBe(false);
      expect((answered.answer as Record<string, unknown>)['path']).toBe('src/b.ts');
    } finally {
      await reused.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
