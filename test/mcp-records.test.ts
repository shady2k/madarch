import { requestStorePreparation } from '../src/product/store-preparation.js';
import { repositoryStoreFolder } from '../src/mcp/graph.js';
import { storeDatabasePath } from '../src/product/store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { useRepositoryPlugins } from './enabled-plugins-fixture.js';
import { withStorePreparationOwner } from '../src/adapters/store-preparation-owner.js';

let releasePreparationOwner!: () => void;
let preparationOwner: Promise<void>;
async function openPreparationOwner(): Promise<void> {
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const closed = new Promise<void>((resolve) => { releasePreparationOwner = resolve; });
  preparationOwner = withStorePreparationOwner(async () => { opened(); await closed; });
  await ready;
}
/**
 * The five tools of this step (madarch-8bdc.2.5, item 1), served over the
 * normal form: a checkout filled by the one fill, read only from the record
 * store, every answer naming the as-is commit it is true at and the paths the
 * working tree changed.
 *
 * The fixtures are throwaway repositories this test makes — a text file, a
 * binary file, a folder, a rename, a second commit — and a shallow clone whose
 * history pass records the shallow gap the answers must state. No outside
 * checkout is read.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RepositorySession } from '../src/mcp/session.js';
import { RECORD_FILE_LIMIT } from '../src/mcp/records.js';

const REPOSITORY = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-records-'));
/** The products home whose one knowledge store the served checkout is filled into. */
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-records-home-'));
const SHALLOW_HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-records-shallow-home-'));
const SHALLOW = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-records-shallow-repo-'));
const COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test',
  GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test',
  TZ: 'Europe/Moscow', LC_ALL: 'C',
};

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: COMMIT_ENV }).trim();

function put(relativePath: string, text: string | Uint8Array): void {
  mkdirSync(path.dirname(path.join(REPOSITORY, relativePath)), { recursive: true });
  writeFileSync(path.join(REPOSITORY, relativePath), text);
}

/** The commits the repository holds, oldest first, after the fixture is written. */
let first = '';
let second = '';
let third = '';
let committedPaths: string[] = [];
let committedFolders: string[] = [];

let session: RepositorySession;

beforeAll(async () => {
  await openPreparationOwner();
  git(REPOSITORY, 'init', '-q', '-b', 'main');
  useRepositoryPlugins(REPOSITORY);
  put('README.md', '# Sample kit\n\nA fixture.\n');
  put('src/a.ts', 'export const a = 1;\n');
  put('src/nested/b.ts', 'export const b = 2;\n');
  put('assets/picture.bin', Uint8Array.from([0, 1, 2, 0, 255, 10]));
  git(REPOSITORY, 'add', '-A');
  git(REPOSITORY, 'commit', '-qm', 'the fixture is written');
  first = git(REPOSITORY, 'rev-parse', 'HEAD');
  // A rename with nothing else in the commit, then an edit of the renamed file: the file's history
  // must follow the path it came from, and a rename is read as a rename and not as an add.
  git(REPOSITORY, 'mv', 'src/nested/b.ts', 'src/nested/c.ts');
  git(REPOSITORY, 'commit', '-qm', 'the nested file moves');
  second = git(REPOSITORY, 'rev-parse', 'HEAD');
  put('src/nested/c.ts', 'export const b = 3;\nexport const d = 4;\n');
  put('src/a.ts', 'export const a = 1;\nexport const e = 5;\n');
  git(REPOSITORY, 'add', '-A');
  git(REPOSITORY, 'commit', '-qm', 'the nested file and one export grow');
  third = git(REPOSITORY, 'rev-parse', 'HEAD');
  committedPaths = git(REPOSITORY, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  committedFolders = git(REPOSITORY, 'ls-tree', '-r', '-d', '--name-only', 'HEAD').split('\n');
  await requestStorePreparation(storeDatabasePath(repositoryStoreFolder(REPOSITORY, { MADARCH_HOME: HOME })), await readPinnedGraphContract(REPOSITORY));
  session = await RepositorySession.open({ repository: REPOSITORY, env: { ...process.env, MADARCH_HOME: HOME } });

  // A shallow clone of the same commits: its history pass records the gap a reader must see stated.
  const clone = path.join(SHALLOW, 'kit');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${REPOSITORY}`, clone], { env: COMMIT_ENV });
  await requestStorePreparation(storeDatabasePath(repositoryStoreFolder(clone, { MADARCH_HOME: SHALLOW_HOME })), await readPinnedGraphContract(clone));
  shallow = await RepositorySession.open({ repository: clone, env: { ...process.env, MADARCH_HOME: SHALLOW_HOME } });
}, 120_000);

let shallow: RepositorySession;

afterAll(async () => {
  await session?.close();
  await shallow?.close();
  releasePreparationOwner();
  await preparationOwner;
  for (const folder of [REPOSITORY, HOME, SHALLOW_HOME, SHALLOW]) rmSync(folder, { recursive: true, force: true });
});

type Answer = { isError: boolean; answer: Record<string, unknown> };

const call = async (tool: string, args: Record<string, unknown> = {}): Promise<Answer> => {
  const answered = await session.call(tool, args);
  return { isError: answered.isError, answer: answered.answer as Record<string, unknown> };
};

/** The source every answer carries. */
const sourceOf = (answer: Record<string, unknown>): Record<string, unknown> => answer['source'] as Record<string, unknown>;

describe('the tools this step serves', () => {
  
  test('get_repository names the as-is commit and the counts the graph holds', async () => {
    const { isError, answer } = await call('get_repository');
    expect(isError).toBe(false);
    expect(sourceOf(answer)).toMatchObject({ repository: REPOSITORY, commit: third, branch: 'main', changed: [] });
    expect(answer).toMatchObject({
      repository: path.basename(REPOSITORY),
      url: `file://${REPOSITORY}`,
      defaultBranch: 'main',
      asIsCommit: third,
      counts: { files: committedPaths.length, commits: 3, folders: committedFolders.length },
      steps: { 'plugin-turns': true },
      // The history pass states it: this clone is not shallow.
      historyShallow: false,
    });
  }, 120_000);

  test('list_files pages in code point order, filters by prefix and by language, and names the next page', async () => {
    const firstPage = await call('list_files', { limit: 2 });
    expect(firstPage.isError).toBe(false);
    const files = firstPage.answer['files'] as { path: string }[];
    expect(files.map((file) => file.path)).toEqual(committedPaths.slice(0, 2));
    expect(firstPage.answer['next']).toBe(committedPaths[1]);
    const nextPage = await call('list_files', { limit: 2, after: firstPage.answer['next'] as string });
    expect((nextPage.answer['files'] as { path: string }[]).map((file) => file.path)).toEqual(committedPaths.slice(2, 4));
    // A prefix is a path prefix and nothing else: "src/nested" keeps that folder and no sibling.
    const nested = await call('list_files', { prefix: 'src/nested' });
    expect((nested.answer['files'] as { path: string }[]).map((file) => file.path)).toEqual(['src/nested/c.ts']);
    // The binary blob is a binary: no line count, the bytes the fixture wrote.
    const binary = (await call('list_files', { prefix: 'assets/' })).answer['files'] as Record<string, unknown>[];
    expect(binary[0]).toMatchObject({ path: 'assets/picture.bin', form: 'binary', lines: null, bytes: 6 });
  }, 120_000);

  test('get_file states every fact of one file, its dates and its authors', async () => {
    const { isError, answer } = await call('get_file', { path: 'src/a.ts' });
    expect(isError).toBe(false);
    expect(answer).toMatchObject({
      path: 'src/a.ts', mode: '100644', bytes: 40, lines: 2, form: 'text', language: null,
      commitCount: 2, authors: ['Ada Example'],
    });
    // Step 1 states the dataset's ambiguity; a later producer may publish a resolved language opinion.
    expect(answer['candidates']).toEqual(['TypeScript', 'XML']);
    expect(answer['blob']).toBe(git(REPOSITORY, 'rev-parse', `${third}:src/a.ts`));
    expect(answer['historyShallow']).toBe(false);
    expect(sourceOf(answer)).toMatchObject({ repository: REPOSITORY, commit: third, branch: 'main', changed: [], dirty: [] });
    expect((answer['created'] as Record<string, unknown>)['commit']).toBe(first);
    expect((answer['modified'] as Record<string, unknown>)['commit']).toBe(third);
    expect((answer['created'] as Record<string, unknown>)['author']).toBe('Ada Example');
    // A git date is the clock its author wrote it on, with that offset: `%aI` states both, and the
    // store keeps the same two numbers apart. The fixture commits under Europe/Moscow (offset 180).
    expect((answer['created'] as Record<string, unknown>)['date']).toBe(git(REPOSITORY, 'log', '-1', '--format=%aI', first));
    expect((answer['created'] as Record<string, unknown>)['offsetMin']).toBe(180);
    expect((answer['modified'] as Record<string, unknown>)['date']).toBe(git(REPOSITORY, 'log', '-1', '--format=%aI', third));
    expect((answer['modified'] as Record<string, unknown>)['offsetMin']).toBe(180);
  }, 120_000);

  test('a file the as-is commit does not hold is refused by name', async () => {
    const { isError, answer } = await call('get_file', { path: 'src/missing.ts' });
    expect(isError).toBe(true);
    expect((answer['error'] as Record<string, unknown>)['code']).toBe('no-such-file');
    expect((answer['error'] as Record<string, unknown>)['message']).toContain('src/missing.ts');
  }, 120_000);

  test('get_file_history follows a rename and pages by the exact row it ended on', async () => {
    const { isError, answer } = await call('get_file_history', { path: 'src/nested/c.ts' });
    expect(isError).toBe(false);
    const commits = answer['commits'] as Record<string, unknown>[];
    expect(commits.map((commit) => [commit['commit'], commit['change'], commit['previousPath']])).toEqual([
      [third, 'modified', null],
      [second, 'renamed', 'src/nested/b.ts'],
      [first, 'added', null],
    ]);
    expect(commits.map((commit) => [commit['added'], commit['removed']])).toEqual([[2, 1], [0, 0], [1, 0]]);
    // Every row's date is its commit's own clock with its own offset, not a UTC instant wearing one.
    expect(commits.map((commit) => commit['offsetMin'])).toEqual([180, 180, 180]);
    expect(commits.map((commit) => commit['date'])).toEqual([
      git(REPOSITORY, 'log', '-1', '--format=%aI', third),
      git(REPOSITORY, 'log', '-1', '--format=%aI', second),
      git(REPOSITORY, 'log', '-1', '--format=%aI', first),
    ]);
    const paged = await call('get_file_history', { path: 'src/nested/c.ts', limit: 1 });
    expect(paged.answer['next']).toEqual({ walk: 0, commit: third });
    const after = await call('get_file_history', { path: 'src/nested/c.ts', limit: 1, after: paged.answer['next'] });
    expect((after.answer['commits'] as Record<string, unknown>[]).map((commit) => commit['commit'])).toEqual([second]);
    const last = await call('get_file_history', { path: 'src/nested/c.ts', limit: 1, after: after.answer['next'] });
    expect((last.answer['commits'] as Record<string, unknown>[]).map((commit) => commit['commit'])).toEqual([first]);
    expect(last.answer['next']).toBeNull();
  }, 120_000);

  test('get_commit states the author, both dates with their offsets, the parents and every changed path', async () => {
    const { isError, answer } = await call('get_commit', { hash: third });
    expect(isError).toBe(false);
    expect(answer).toMatchObject({
      hash: third,
      author: { name: 'Ada Example', email: 'ada@example.test' },
      authorOffsetMin: 180, commitOffsetMin: 180,
      authorDate: git(REPOSITORY, 'log', '-1', '--format=%aI', third), commitDate: git(REPOSITORY, 'log', '-1', '--format=%cI', third),
      subject: 'the nested file and one export grow',
      parents: [second],
    });
    expect((answer['changed'] as Record<string, unknown>[]).map((one) => [one['path'], one['change']])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/nested/c.ts', 'modified'],
    ]);
    const renamed = (await call('get_commit', { hash: second }))['answer'] as Record<string, unknown>;
    expect((renamed['changed'] as Record<string, unknown>[])).toEqual([{ path: 'src/nested/c.ts', change: 'renamed', added: 0, removed: 0, previousPath: 'src/nested/b.ts' }]);
    const root = await call('get_commit', { hash: first });
    expect((root['answer'] as Record<string, unknown>)['parents']).toEqual([]);
  }, 120_000);

  test('the working tree\'s changes are named in every answer, and an edit never changes the commit\'s facts', async () => {
    put('src/edited.ts', 'export const edited = 1;\n');
    try {
      const { answer } = await call('get_repository');
      expect(sourceOf(answer)['changed']).toEqual([{ path: 'src/edited.ts', status: 'untracked' }]);
      expect(sourceOf(answer)['commit']).toBe(third);
      // The graph is the commit's: the untracked file is not among its files.
      const files = await call('list_files', {});
      expect((files.answer['files'] as { path: string }[]).some((file) => file.path === 'src/edited.ts')).toBe(false);
    } finally {
      rmSync(path.join(REPOSITORY, 'src/edited.ts'), { force: true });
    }
  }, 120_000);

  test('a shallow history states its gap in the answer, never dropping it', async () => {
    const answered = await shallow.call('get_repository', {});
    expect(answered.isError).toBe(false);
    const answer = answered.answer as Record<string, unknown>;
    expect(answer['counts']).toMatchObject({ commits: 1 });
    // A shallow clone is the history pass's own opinion of the repository, so the answer states it as one.
    expect(answer['historyShallow']).toBe(true);
  }, 180_000);

  test('a tool of a later step answers that its step has not run, naming it', async () => {
    for (const [tool, step] of [['get_symbol', 'syntax'], ['trace_flow', 'semantic-resolution'], ['get_page', 'document-index']] as const) {
      const { isError, answer } = await call(tool, { name: 'a', entry: 'a', page: 'docs/a.md' });
      expect(isError).toBe(true);
      expect((answer['error'] as Record<string, unknown>)['code']).toBe('step-not-run');
      expect((answer['error'] as Record<string, unknown>)['step']).toBe(step);
      expect(String((answer['error'] as Record<string, unknown>)['message'])).toContain(`the step "${step}" has not run`);
      // The answer still says where it would have been true.
      expect(sourceOf(answer)['commit']).toBe(third);
      expect(sourceOf(answer)['repository']).toBe(REPOSITORY);
    }
  }, 120_000);

  test('the page bound is the tool\'s own, and a call over it is cut to it', async () => {
    const everything = await call('list_files', { limit: RECORD_FILE_LIMIT });
    expect((everything.answer['files'] as unknown[]).length).toBeLessThanOrEqual(RECORD_FILE_LIMIT);
    const over = await call('list_files', { limit: 10_000 });
    expect((over.answer['files'] as unknown[]).length).toBeLessThanOrEqual(RECORD_FILE_LIMIT);
  }, 120_000);
});
