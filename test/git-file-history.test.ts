
/**
 * The git plugin's file answer (madarch-64o5.65): a file in the current tree is a file, a path only the history
 * names is an identity its commits reach, and every current file carries the history git states for it.
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
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Author One', GIT_AUTHOR_EMAIL: 'one@example.test',
  GIT_COMMITTER_NAME: 'Author One', GIT_COMMITTER_EMAIL: 'one@example.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  TZ: 'UTC', LC_ALL: 'C',
};
const SECOND = {
  GIT_AUTHOR_NAME: 'Author Two', GIT_AUTHOR_EMAIL: 'two@example.test',
  GIT_COMMITTER_NAME: 'Author Two', GIT_COMMITTER_EMAIL: 'two@example.test',
  GIT_AUTHOR_DATE: '2026-01-02T00:00:00+0000', GIT_COMMITTER_DATE: '2026-01-02T00:00:00+0000',
  TZ: 'UTC', LC_ALL: 'C',
};
const priorGit = process.env['MADARCH_TOOL_GIT'];
let first = '', second = '';

function git(folder: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim();
}

beforeAll(() => {
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  mkdirSync(REPOSITORY);
  git(REPOSITORY, IDENTITY, 'init', '-q', '-b', 'main');
  git(REPOSITORY, IDENTITY, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(REPOSITORY, 'kept.txt'), 'one\n');
  writeFileSync(join(REPOSITORY, 'gone.txt'), 'gone\n');
  git(REPOSITORY, IDENTITY, 'add', '-A');
  git(REPOSITORY, IDENTITY, 'commit', '-qm', 'add two');
  first = git(REPOSITORY, IDENTITY, 'rev-parse', 'HEAD');
  git(REPOSITORY, SECOND, 'rm', '-q', 'gone.txt');
  writeFileSync(join(REPOSITORY, 'kept.txt'), 'two\n');
  git(REPOSITORY, SECOND, 'add', '-A');
  git(REPOSITORY, SECOND, 'commit', '-qm', 'delete and change');
  second = git(REPOSITORY, SECOND, 'rev-parse', 'HEAD');
  mkdirSync(join(PRODUCT, 'repos'), { recursive: true });
  symlinkSync(REPOSITORY, join(PRODUCT, 'repos', 'fixture'));
  writeFileSync(join(PRODUCT, 'workspace.yaml'), `schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: code-data\nrepos:\n  - name: fixture\n    url: file://${REPOSITORY}\n`);
  seedRepositoryPlugins(PRODUCT);
  restrictRepositoryDeclarations(PRODUCT);
  git(PRODUCT, IDENTITY, 'init', '-q');
  git(PRODUCT, IDENTITY, 'add', '-A');
  git(PRODUCT, IDENTITY, 'commit', '-qm', 'Declare repository plugins');
});

afterAll(() => {
  if (priorGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
  else process.env['MADARCH_TOOL_GIT'] = priorGit;
  rmSync(ROOT, { recursive: true, force: true });
});

const current = (): string[] => git(REPOSITORY, IDENTITY, 'ls-files').split('\n').filter((path) => path !== '');
const pin = () => ({ repository: 'fixture', root: REPOSITORY, commit: second, url: `file://${REPOSITORY}` });
const context = (files: readonly string[]): Context => ({
  signal: new AbortController().signal,
  progress() {},
  graph: {
    files: async () => files.map((path) => ({ kind: 'code.file', key: { repository: 'fixture', path } })),
    value: async () => 'file://fixture',
  },
} as unknown as Context);
const unit = (kind: string, edgeOutputs: readonly { kind: string; from: string; to: string }[]): Unit => ({
  kind,
  inputs: { repositories: [pin()], edgeOutputs, contract: gitContract.outputs },
} as unknown as Unit);
const fileEdges = [{ kind: 'code.renamed-from', from: 'code.file', to: 'code.file' }];
const commitEdges = gitContract.outputs.edges
  .filter((edge) => edge.kind !== 'code.renamed-from')
  .map((edge) => ({ kind: edge.kind, from: typeof edge.from === 'string' ? edge.from : edge.from[0]!, to: typeof edge.to === 'string' ? edge.to : edge.to[0]! }));

test('the git file answer names only current files as files, and a deleted path as an identity', async () => {
  expect(current()).toEqual(['kept.txt']);
  const files = await gitExtract(unit('code.file', fileEdges), context(current()));
  const vertices = files.vertices ?? [];
  const named = vertices.filter((vertex) => vertex.kind === 'code.file' && vertex.identityOnly !== true);
  expect(named.map((vertex) => String(vertex.key['path'])).sort()).toEqual(current());
  const kept = named.find((vertex) => vertex.key['path'] === 'kept.txt');
  expect(kept?.values).toMatchObject({ commit_count: 2, last_change: '2026-01-02T00:00:00.000Z' });
  const history = vertices.filter((vertex) => vertex.kind === 'code.file' && vertex.identityOnly === true);
  expect(history.map((vertex) => String(vertex.key['path'])).sort()).toEqual(['gone.txt']);
  expect(history[0]).not.toHaveProperty('values');
  expect(history[0]).not.toHaveProperty('evidence');
});

test('the commits touch every current file and reach the deleted path, and the deleted path is not a current file', async () => {
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
  const identities = (answer.vertices ?? []).filter((vertex) => vertex.kind === 'code.file');
  expect(identities.every((vertex) => vertex.identityOnly === true)).toBe(true);
  // The current file is the tree producer's; the commit unit names only the path its commits reach and the tree lost.
  expect(identities.map((vertex) => String(vertex.key['path']))).toEqual(['gone.txt']);
});

test('a fill lists the current tree, keeps the deleted path on its commits, and states every current file\'s history', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: repositoryContract });
  try {
    const run = await runFill({ product: PRODUCT, database: owner, home: join(ROOT, 'home'), runId: 'code-data', prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
    if (!run.ok) throw new Error(`fill refused: ${run.reason}`);
    expect(run.state).toBe('succeeded');
    const listed = await new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads)
      .byPrefix('code.file', 'code.file:fixture/', 100);
    expect(listed.rows.map((row) => row.key)).toEqual(current().map((path) => `code.file:fixture/${path}`));
    expect((await repositoryFacts(owner, 'fixture'))?.fileCount).toBe(current().length);
    const history = await owner.transaction('snapshot', async (tx) => (await tx.query<{ path: string; commits: string; current: boolean }>(
      `SELECT n.key->>'path' AS path,
              (SELECT count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = 'code.touched' WHERE e.to_node = n.id) AS commits,
              EXISTS (SELECT 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = 'code.contains' WHERE e.to_node = n.id) AS current
       FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = 'code.file' WHERE n.key->>'path' IN ('kept.txt', 'gone.txt') ORDER BY path`,
    )).rows);
    expect(history).toEqual([{ path: 'gone.txt', commits: '2', current: false }, { path: 'kept.txt', commits: '2', current: true }]);
    const kept = await fileFacts(owner, 'fixture', 'kept.txt');
    expect(kept).toMatchObject({ commitCount: 2, authors: ['Author One', 'Author Two'] });
    expect(kept?.created?.commit).toBe(first);
    expect(kept?.modified?.commit).toBe(second);
    // The catalogue's class rules reach the plugin, and the file states its class beside its other facts.
    const fileClass = await owner.transaction('snapshot', async (tx) => (await tx.query<{ class: string }>(
      `SELECT o."class" FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id WHERE (n.key->>'path') = 'kept.txt' AND o."state" = 'open' AND split_part(o."said_by", '@', 1) = 'disk'`,
    )).rows);
    expect(fileClass).toEqual([{ class: 'code' }]);
  } finally {
    await owner.close();
  }
}, 120_000);
