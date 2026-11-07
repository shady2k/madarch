/**
 * `madarch mcp` on the store the one fill writes (madarch-8bdc.2.5, item 4a): a fresh store holds the tree pass's
 * records and no graph reading, and the server must start and answer — every answer the empty one, naming the
 * commit the store's records name. An older store's temporal rows are a different commit's and must not be served
 * under the new one.
 *
 * The fixture is a throwaway checkout the test makes and commits here, and a store under its own madarch home.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { ensureGraphSchema } from '../src/fill/stages/static-graph.js';
import { createGraphStore } from '../src/graph/index.js';
import { repositoryStoreFolder } from '../src/mcp/graph.js';
import { RepositorySession } from '../src/mcp/session.js';
import { knowledgeRootOf, storeDatabasePath } from '../src/product/store.js';

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-mcp-fresh-'));
const REPOSITORY = join(ROOT, 'checkout');
const ENV = { ...process.env, MADARCH_HOME: ROOT };
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPOSITORY, encoding: 'utf8', env: GIT_ENV }).trim();
}

function commitAll(message: string): string {
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

beforeAll(() => {
  mkdirSync(join(REPOSITORY, 'src'), { recursive: true });
  writeFileSync(join(REPOSITORY, 'src', 'a.ts'), 'export function one(): number {\n  return 1;\n}\n');
  writeFileSync(join(REPOSITORY, 'README.md'), '# Review kit\n\nSaves items.\n');
  git('init', '-q', '-b', 'main');
  commitAll('one');
}, 120_000);

/** The source an answer names: its commit and the instant it was read at. */
function sourceOf(answer: Record<string, unknown>): Record<string, unknown> {
  return answer['source'] as Record<string, unknown>;
}

describe('a fresh store', () => {
  test('starts, answers the empty reading, and names the commit its records are at', async () => {
    const head = git('rev-parse', 'HEAD');
    const store = repositoryStoreFolder(REPOSITORY, ENV);
    mkdirSync(dirname(storeDatabasePath(store)), { recursive: true });
    const owner = createPGliteDatabaseOwner({ path: storeDatabasePath(store), btreeGist: true });
    await owner.ready;
    try {
      const run = await runFill({ product: REPOSITORY, database: owner, runId: 'fresh-store', home: store, store });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.state).toBe('succeeded');
    } finally {
      await owner.close();
    }
    const session = await RepositorySession.open({ repository: REPOSITORY, env: ENV });
    try {
      expect(session.filledCommit).toBe(head);
      const symbol = await session.call('get_symbol', { name: 'one' });
      expect(symbol.isError).toBe(true);
      expect(JSON.stringify(symbol.answer)).toContain('no-such-symbol');
      expect(sourceOf(symbol.answer as Record<string, unknown>)['commit']).toBe(head);
      // No document is listed either: the tree pass publishes records, and the graph holds no reading.
      const pages = await session.call('search_pages', { text: 'Saves items' });
      expect(pages.isError).toBe(false);
      expect((pages.answer as Record<string, unknown>)['pages']).toEqual([]);
      expect(typeof sourceOf(pages.answer as Record<string, unknown>)['at']).toBe('string');
    } finally {
      await session.close();
    }
  }, 300_000);
});

describe('a store whose temporal rows are an older commit\'s', () => {
  test('the rows are not served under the new commit, and the answers are the new commit\'s empty ones', async () => {
    const store = repositoryStoreFolder(REPOSITORY, ENV);
    // What a store filled by the static stages at this commit holds: a file node at the instant of its publication.
    mkdirSync(dirname(storeDatabasePath(store)), { recursive: true });
    const owner = createPGliteDatabaseOwner({ path: storeDatabasePath(store), btreeGist: true });
    await owner.ready;
    const graph = createGraphStore(owner);
    await ensureGraphSchema(graph);
    const scope = await graph.newNode();
    const at = new Date().toISOString();
    await graph.openWorkItem({ producer: 'planted', scope, generation: 1, inputDigest: 'planted', leaseToken: 't1', leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    await graph.publish({
      producer: 'planted', scope, generation: 1, leaseToken: 't1', inputDigest: 'planted',
      nodes: [{ ref: 'file', kind: 'code.file', label: 'README.md', validFrom: at, properties: { recordKey: 'code.file:README.md', path: 'README.md', blob: 'b'.repeat(40), mode: '100644' } }],
    });
    await owner.close();
    // A new commit, and a fill through the record passes: the tree pass moves the as-is commit.
    writeFileSync(join(REPOSITORY, 'src', 'a.ts'), 'export function one(): number {\n  return 2;\n}\n');
    const head = commitAll('two');
    const session = await RepositorySession.open({ repository: REPOSITORY, env: ENV });
    try {
      expect(session.filledCommit).toBe(head);
      const pages = await session.call('search_pages', { text: 'Saves items' });
      expect(pages.isError).toBe(false);
      // The file node planted at the older commit is not this commit's, so no page stands on it.
      expect((pages.answer as Record<string, unknown>)['pages']).toEqual([]);
      expect(sourceOf(pages.answer as Record<string, unknown>)['commit']).toBe(head);
    } finally {
      await session.close();
    }
  }, 300_000);
});
