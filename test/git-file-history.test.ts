
/**
 * A file's existence (madarch-64o5.65): every path the history named is a code.file entity with its latest period of
 * existence, and the current tree is the files whose removal is empty.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract as gitExtract } from '../plugins/git/main.js';
import gitContract from '../plugins/git/contract.json';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { runFill } from '../src/fill/run.js';
import { repositoryFacts, fileFacts } from '../src/graph/index.js';
import { GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { seedRepositoryPlugins } from './enabled-plugins-fixture.js';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads, restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

type Context = Parameters<typeof gitExtract>[1];
type Unit = Parameters<typeof gitExtract>[0];

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-git-file-history-'));
const REPOSITORY = join(ROOT, 'repo');
const PRODUCT = join(ROOT, 'product');
const base = (name: string, date: string) => ({
  GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name.toLowerCase().replaceAll(' ', '.')}@example.test`,
  GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name.toLowerCase().replaceAll(' ', '.')}@example.test`,
  GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, TZ: 'UTC', LC_ALL: 'C',
});
const ONE = base('Author One', '2026-01-01T00:00:00+0000');
const TWO = base('Author Two', '2026-01-02T00:00:00+0000');
const THREE = base('Author Two', '2026-01-03T00:00:00+0000');
const priorGit = process.env['MADARCH_TOOL_GIT'];
let first = '', second = '';

function git(folder: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim();
}
function commit(folder: string, env: Record<string, string>, message: string): string {
  git(folder, env, 'add', '-f', '-A');
  git(folder, env, 'commit', '-qm', message);
  return git(folder, env, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  mkdirSync(REPOSITORY);
  git(REPOSITORY, ONE, 'init', '-q', '-b', 'main');
  git(REPOSITORY, ONE, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(REPOSITORY, 'kept.txt'), 'one\n');
  writeFileSync(join(REPOSITORY, 'gone.txt'), 'gone\n');
  first = commit(REPOSITORY, ONE, 'add two');
  git(REPOSITORY, TWO, 'rm', '-q', 'gone.txt');
  writeFileSync(join(REPOSITORY, 'kept.txt'), 'two\n');
  second = commit(REPOSITORY, TWO, 'delete and change');
  mkdirSync(join(PRODUCT, 'repos'), { recursive: true });
  symlinkSync(REPOSITORY, join(PRODUCT, 'repos', 'fixture'));
  writeFileSync(join(PRODUCT, 'workspace.yaml'), `schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: code-data\nrepos:\n  - name: fixture\n    url: file://${REPOSITORY}\n`);
  seedRepositoryPlugins(PRODUCT);
  restrictRepositoryDeclarations(PRODUCT);
  git(PRODUCT, ONE, 'init', '-q');
  commit(PRODUCT, ONE, 'Declare repository plugins');
});

afterAll(() => {
  if (priorGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
  else process.env['MADARCH_TOOL_GIT'] = priorGit;
  rmSync(ROOT, { recursive: true, force: true });
});

const current = (folder = REPOSITORY): string[] => git(folder, ONE, 'ls-files').split('\n').filter((path) => path !== '');
const pin = (folder = REPOSITORY, name = 'fixture', commitAt = second) => ({ repository: name, root: folder, commit: commitAt, url: `file://${folder}` });
const context = (files: readonly string[]): Context => ({
  signal: new AbortController().signal,
  progress() {},
  graph: {
    files: async () => files.map((path) => ({ kind: 'code.file', key: { repository: 'fixture', path } })),
    value: async () => 'file://fixture',
  },
} as unknown as Context);
const unit = (kind: string, edgeOutputs: readonly { kind: string; from: string; to: string }[], repository = pin()): Unit => ({
  kind,
  inputs: { repositories: [repository], edgeOutputs, contract: gitContract.outputs },
} as unknown as Unit);
const fileEdges = [{ kind: 'code.renamed-from', from: 'code.file', to: 'code.file' }];
const commitEdges = gitContract.outputs.edges
  .filter((edge) => edge.kind !== 'code.renamed-from')
  .map((edge) => ({ kind: edge.kind, from: typeof edge.from === 'string' ? edge.from : edge.from[0]!, to: typeof edge.to === 'string' ? edge.to : edge.to[0]! }));

test('every path the history named is a file with its latest period of existence', async () => {
  expect(current()).toEqual(['kept.txt']);
  const answer = await gitExtract(unit('code.file', fileEdges), context(current()));
  const files = (answer.vertices ?? []).filter((vertex) => vertex.kind === 'code.file');
  expect(files.map((vertex) => String(vertex.key['path'])).sort()).toEqual(['gone.txt', 'kept.txt']);
  const byPath = new Map(files.map((vertex) => [String(vertex.key['path']), vertex]));
  expect(byPath.get('kept.txt')?.values).toEqual({
    commit_count: 2, last_change: '2026-01-02T00:00:00.000Z',
    added_at: '2026-01-01T00:00:00.000Z', added_in: first, removed_at: null, removed_in: null,
  });
  expect(byPath.get('gone.txt')?.values).toEqual({
    commit_count: 2, last_change: '2026-01-02T00:00:00.000Z',
    added_at: '2026-01-01T00:00:00.000Z', added_in: first,
    removed_at: '2026-01-02T00:00:00.000Z', removed_in: second,
  });
  for (const [path, vertex] of byPath) expect(vertex.evidence).toEqual({ repository: 'fixture', path, commitOrDigest: second });
});

test('the commits touch a deleted file too, and it keeps its history', async () => {
  const answer = await gitExtract(unit('code.commit', commitEdges), context(current()));
  const touched = (answer.edges ?? []).filter((edge) => edge.kind === 'code.touched');
  const byPath = new Map<string, string[]>();
  for (const edge of touched) {
    const path = String(edge.to.key['path']);
    byPath.set(path, [...(byPath.get(path) ?? []), String(edge.from.key['hash'])]);
  }
  expect([...byPath.keys()].sort()).toEqual(['gone.txt', 'kept.txt']);
  expect(byPath.get('kept.txt')?.sort()).toEqual([first, second].sort());
  expect(byPath.get('gone.txt')?.sort()).toEqual([first, second].sort());
  expect(touched.find((edge) => edge.to.key['path'] === 'gone.txt' && edge.from.key['hash'] === second)?.values).toMatchObject({ change: 'deleted' });
});

test('a fill counts the files whose removal is empty, and dates and commits every file', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: repositoryContract });
  try {
    const run = await runFill({ product: PRODUCT, database: owner, home: join(ROOT, 'home'), runId: 'code-data', prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
    if (!run.ok) throw new Error(`fill refused: ${run.reason}`);
    expect(run.state).toBe('succeeded');
    const periods = await owner.transaction('snapshot', async (tx) => (await tx.query<{ path: string; added_at: string | null; added_in: string | null; removed_at: string | null; removed_in: string | null }>(
      `SELECT n.key->>'path' AS path,
              to_char(o.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS added_at, o.added_in,
              to_char(o.removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS removed_at, o.removed_in
       FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id
       WHERE o.state = 'open' AND split_part(o.said_by, '@', 1) = 'git' AND n.key->>'repository' = 'fixture' ORDER BY path`,
    )).rows);
    expect(periods).toEqual([
      { path: 'gone.txt', added_at: '2026-01-01T00:00:00.000Z', added_in: first, removed_at: '2026-01-02T00:00:00.000Z', removed_in: second },
      { path: 'kept.txt', added_at: '2026-01-01T00:00:00.000Z', added_in: first, removed_at: null, removed_in: null },
    ]);
    const counted = await owner.transaction('snapshot', async (tx) => (await tx.query<{ n: number }>(
      `SELECT count(DISTINCT n.id)::integer AS n FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id
       WHERE o.state = 'open' AND split_part(o.said_by, '@', 1) = 'git' AND n.key->>'repository' = 'fixture' AND o.removed_at IS NULL`,
    )).rows[0]!.n);
    expect(counted).toBe(current().length);
    expect((await repositoryFacts(owner, 'fixture'))?.fileCount).toBe(current().length);
    const listed = await new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads)
      .byPrefix('code.file', 'code.file:fixture/', 100);
    expect(listed.rows.map((row) => row.key).sort()).toEqual(['code.file:fixture/gone.txt', 'code.file:fixture/kept.txt']);
    for (const path of ['kept.txt', 'gone.txt']) {
      const facts = await fileFacts(owner, 'fixture', path);
      expect(facts).toMatchObject({ commitCount: 2, authors: ['Author One', 'Author Two'] });
      expect(facts?.created?.commit).toBe(first);
      expect(facts?.modified?.commit).toBe(second);
    }
    // The catalogue's class rules reach the plugin, and the file states its class beside its other facts.
    const fileClass = await owner.transaction('snapshot', async (tx) => (await tx.query<{ class: string }>(
      `SELECT o."class" FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id WHERE (n.key->>'path') = 'kept.txt' AND o."state" = 'open' AND split_part(o."said_by", '@', 1) = 'disk'`,
    )).rows);
    expect(fileClass).toEqual([{ class: 'code' }]);
  } finally {
    await owner.close();
  }
}, 120_000);

test('a path deleted and added again states its latest period', async () => {
  const folder = join(ROOT, 'twice');
  mkdirSync(folder);
  git(folder, ONE, 'init', '-q', '-b', 'main');
  git(folder, ONE, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(folder, 'twice.txt'), 'first\n');
  commit(folder, ONE, 'add');
  git(folder, TWO, 'rm', '-q', 'twice.txt');
  commit(folder, TWO, 'delete');
  writeFileSync(join(folder, 'twice.txt'), 'again\n');
  const again = commit(folder, THREE, 'add again');
  const answer = await gitExtract(unit('code.file', fileEdges, pin(folder, 'twice', again)), context(['twice.txt']));
  const file = (answer.vertices ?? []).find((vertex) => vertex.kind === 'code.file' && vertex.key['path'] === 'twice.txt');
  expect(file?.values).toEqual({
    commit_count: 3, last_change: '2026-01-03T00:00:00.000Z',
    added_at: '2026-01-03T00:00:00.000Z', added_in: again, removed_at: null, removed_in: null,
  });
  expect(file?.evidence).toEqual({ repository: 'twice', path: 'twice.txt', commitOrDigest: again });
});
