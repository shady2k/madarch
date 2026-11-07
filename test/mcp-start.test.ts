/**
 * A served checkout of any size (madarch-8bdc.2.5): there is no file count
 * above which `madarch mcp` refuses to build a graph. The fill is the path, and
 * a machine that runs out of memory is a fill defect to fix, never a reason to
 * leave a repository unserved. These cases serve a small checkout and read what
 * its producers wrote.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, type PendingRepository } from '../src/mcp/server.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-start-repo-'));
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-start-home-'));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

const put = (relativePath: string, text: string): void => {
  mkdirSync(path.dirname(path.join(REPOSITORY, relativePath)), { recursive: true });
  writeFileSync(path.join(REPOSITORY, relativePath), text, 'utf8');
};

/** The code files of the fixture: a small tree whose start must not be refused for its size. */
const CODE_FILES = 6;

beforeAll(() => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: REPOSITORY, env: GIT_ENV }); };
  git('init', '-q', '-b', 'main');
  put('package.json', `${JSON.stringify({ name: 'start-kit', version: '1.0.0', type: 'module' }, null, 2)}\n`);
  for (let index = 0; index < CODE_FILES; index++) {
    const name = `f${String(index).padStart(3, '0')}`;
    put(`src/${name}.ts`, `/** The number ${index}. */\nexport function ${name}(): number {\n  return ${index};\n}\n`);
  }
  // The producers a served graph must reach: a contract and a migration live in the same tree.
  put('contracts/openapi/items.yaml', 'openapi: 3.1.0\ninfo:\n  title: Items\n  version: 1.0.0\npaths:\n  /items:\n    get:\n      operationId: listItems\n      responses:\n        \'200\':\n          description: the items\n');
  put('db/migrations/0001-items.sql', 'CREATE TABLE items (\n  id TEXT PRIMARY KEY\n);\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start-kit: a small tree, a contract, a migration');
}, 120_000);

afterAll(() => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe('a served checkout', () => {
  test('opens and answers its own symbol', async () => {
    const session = await RepositorySession.open({ repository: REPOSITORY, env: { ...process.env, MADARCH_HOME: HOME } });
    try {
      const answer = await session.call('get_symbol', { name: 'f000' });
      expect(answer.isError).toBe(false);
      const text = JSON.stringify(answer.answer);
      expect(text).toContain('f000');
      expect(text).not.toContain('startup-failed');
    } finally {
      await session.close();
    }
  }, 300_000);

  test('serves through the protocol, and a contract answer is the graph own, never a startup failure', async () => {
    const ready = RepositorySession.open({ repository: REPOSITORY, env: { ...process.env, MADARCH_HOME: HOME } });
    const pending: PendingRepository = { repository: REPOSITORY, ready };
    try {
      const initialized = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, pending);
      expect((initialized?.['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'madarch' });
      const called = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: { entity: 'code.contract:contracts/openapi/items.yaml', purpose: 'domain' } } }, pending);
      const result = called?.['result'] as Record<string, unknown>;
      const text = (result['content'] as { text: string }[])[0]!.text;
      expect(text).not.toContain('startup-failed');
      expect(text).not.toContain('startup-failed');
    } finally {
      await (await ready).close();
    }
  }, 300_000);
});
