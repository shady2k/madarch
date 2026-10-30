/**
 * A start that cannot finish (madarch-ztyq.10 recheck): a tree too large to build cold, with no graph to reuse, is a
 * failure the server keeps and answers with — never a progress note — and the bound exists because a cold build runs
 * every producer, which needs the tree's expression facts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, type PendingRepository } from '../src/mcp/server.js';

const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-start-repo-'));
const STATE = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-start-state-'));
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-start-home-'));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

const put = (relativePath: string, text: string): void => {
  mkdirSync(path.dirname(path.join(REPOSITORY, relativePath)), { recursive: true });
  writeFileSync(path.join(REPOSITORY, relativePath), text, 'utf8');
};

/** The code files of the fixture: one more than the cold build's bound. */
const CODE_FILES = 401;

beforeAll(() => {
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: REPOSITORY, env: GIT_ENV }); };
  git('init', '-q', '-b', 'main');
  put('package.json', `${JSON.stringify({ name: 'start-kit', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  for (let index = 0; index < CODE_FILES; index++) {
    const name = `f${String(index).padStart(3, '0')}`;
    put(`src/${name}.ts`, `/** The number ${index}. */\nexport function ${name}(): number {\n  return ${index};\n}\n`);
  }
  // The producers a bounded build must not silently drop: a contract and a migration live in the same tree.
  put('contracts/openapi/items.yaml', 'openapi: 3.1.0\ninfo:\n  title: Items\n  version: 1.0.0\npaths:\n  /items:\n    get:\n      operationId: listItems\n      responses:\n        \'200\':\n          description: the items\n');
  put('db/migrations/0001-items.sql', 'CREATE TABLE items (\n  id TEXT PRIMARY KEY\n);\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start-kit: a tree past the bound, a contract, a migration');
}, 120_000);

afterAll(() => {
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe('a start that cannot finish', () => {
  test('a tree past the bound with no graph to reuse is refused with its count, the bound and what to do', async () => {
    let failure: unknown;
    try {
      const session = await RepositorySession.open({ repository: REPOSITORY, folder: path.join(STATE, 'graph'), env: { ...process.env, MADARCH_HOME: HOME } });
      await session.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`${CODE_FILES} code files`);
    expect(message).toContain('bounded to 400');
    expect(message).toMatch(/madarch fill/);
  }, 120_000);

  test('every tool call answers the retained failure, marked as one, and the handshake still answers', async () => {
    let failure: unknown;
    try {
      await RepositorySession.open({ repository: REPOSITORY, folder: path.join(STATE, 'again'), env: { ...process.env, MADARCH_HOME: HOME } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const ready = Promise.reject(failure);
    ready.catch(() => undefined);
    const pending: PendingRepository = { repository: REPOSITORY, ready };
    const initialized = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, pending);
    expect((initialized?.['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'madarch' });
    const called = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_symbol', arguments: { name: 'f000' } } }, pending);
    const result = called?.['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    const text = (result['content'] as { text: string }[])[0]!.text;
    expect(text).not.toContain('graph building');
    expect(text).toContain(`${CODE_FILES} code files`);
    expect(text).toContain('bounded to 400');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body['source']).toMatchObject({ repository: REPOSITORY, building: false, commit: null });
    expect((body['error'] as Record<string, unknown>)['code']).toBe('startup-failed');
    // The same failure is what a second tool call answers, and the tool list still answers.
    const again = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: { entity: 'code.table:start-kit/public.items', purpose: 'domain' } } }, pending);
    expect((again?.['result'] as Record<string, unknown>)['isError']).toBe(true);
    const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, pending);
    expect(((listed?.['result'] as Record<string, unknown>)['tools'] as unknown[]).length).toBe(7);
  }, 120_000);

  test('the tree past the bound answers its contract and its table, or refuses: never a graph missing a producer', async () => {
    let session: RepositorySession | undefined;
    try {
      session = await RepositorySession.open({ repository: REPOSITORY, folder: path.join(STATE, 'producers'), env: { ...process.env, MADARCH_HOME: HOME } });
    } catch (error) {
      // The refusal is the bound's, and it says so: the alternative — a graph without the contract or the table — is
      // the silent loss this case exists to forbid.
      expect((error as Error).message).toContain('bounded to 400');
      return;
    }
    try {
      const table = await session.call('get_context', { entity: 'code.table:start-kit/public.items', purpose: 'domain' });
      const contract = await session.call('get_context', { entity: 'code.contract:contracts/openapi/items.yaml', purpose: 'domain' });
      expect(table.isError).toBe(false);
      expect(contract.isError).toBe(false);
    } finally {
      await session.close();
    }
  }, 300_000);
});
