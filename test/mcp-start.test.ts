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
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { useRepositoryPlugins } from './enabled-plugins-fixture.js';

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
  useRepositoryPlugins(REPOSITORY);
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
  test('opens and answers the store the one fill published, naming the step of a tool it does not reach', async () => await withStorePreparationOwner(async () => {
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
  }), 300_000);

  });
