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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RepositorySession } from '../src/mcp/session.js';
import { answerRepositoryMcpMessage, type PendingRepository } from '../src/mcp/server.js';
import { SERVED_TOOL_NAMES } from '../src/mcp/server.js';

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
  rmSync(REPOSITORY, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe('a served checkout', () => {
  test('opens and answers the store the one fill published, naming the step of a tool it does not reach', async () => {
    const session = await RepositorySession.open({ repository: REPOSITORY, env: { ...process.env, MADARCH_HOME: HOME } });
    try {
      // The five tools of this step answer from the record store: the fill's own tree at the checkout's HEAD.
      const files = await session.call('list_files', { prefix: 'src/' });
      expect(files.isError).toBe(false);
      const body = files.answer as Record<string, unknown>;
      expect((body['files'] as { path: string }[]).map((file) => file.path)).toContain('src/f000.ts');
      expect((body['source'] as Record<string, unknown>)['commit']).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY, encoding: 'utf8' }).trim());
      // A tool of a later step names its step rather than answering an empty result.
      const symbol = await session.call('get_symbol', { name: 'f000' });
      expect(symbol.isError).toBe(true);
      expect((symbol.answer as Record<string, unknown>)['error']).toMatchObject({ code: 'step-not-run', step: 'syntax' });
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
      const listed = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, pending);
      expect(((listed?.['result'] as Record<string, unknown>)['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual([...SERVED_TOOL_NAMES]);
      // A client that asks while the store is being filled is told so and asks again (madarch-ztyq.10 review).
      let text = '';
      for (let attempt = 0; attempt < 120; attempt++) {
        const called = await answerRepositoryMcpMessage({ jsonrpc: '2.0', id: 3 + attempt, method: 'tools/call', params: { name: 'get_file', arguments: { path: 'contracts/openapi/items.yaml' } } }, pending);
        const result = called?.['result'] as Record<string, unknown>;
        text = ((result['content'] as { text: string }[])[0]!.text);
        if (!text.includes('graph-building')) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(text).toContain('"path":"contracts/openapi/items.yaml"');
      expect(text).not.toContain('startup-failed');
    } finally {
      await (await ready).close();
    }
  }, 300_000);
});
