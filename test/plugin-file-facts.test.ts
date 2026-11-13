import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract as diskExtract } from '../plugins/disk/main.js';
import { extract as gitExtract } from '../plugins/git/main.js';
import diskContract from '../plugins/disk/contract.json';
import gitContract from '../plugins/git/contract.json';

type Context = Parameters<typeof gitExtract>[1];
type Unit = Parameters<typeof gitExtract>[0];

async function fixture(work: (repo: { root: string; git: (...args: string[]) => string; commit: (message: string, date: string) => string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-file-facts-'));
  const previousGit = process.env['MADARCH_TOOL_GIT'];
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  const command = (args: string[], env = process.env) => {
    const result = Bun.spawnSync([executable, '-C', root, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const git = (...args: string[]) => command(args);
  const commit = (message: string, date: string) => {
    git('add', '-A');
    command(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message], { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    await work({ root, git, commit });
  } finally {
    if (previousGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
    else process.env['MADARCH_TOOL_GIT'] = previousGit;
    rmSync(root, { recursive: true, force: true });
  }
}

const context = (paths: string[] = []): Context => ({
  signal: new AbortController().signal,
  progress() {},
  graph: {
    files: async () => paths.map(path => ({ kind: 'code.file', key: { repository: 'fixture', path } })),
    value: async () => '',
  },
} as unknown as Context);

const unit = (root: string, commit: string, contract: typeof diskContract.outputs | typeof gitContract.outputs): Unit => ({
  kind: 'code.file',
  inputs: { repositories: [{ repository: 'fixture', root, commit, url: '' }], edgeOutputs: [], contract },
} as unknown as Unit);

test('disk publishes root and nested directories as selected ordinary fields with pinned evidence', async () => {
  await fixture(async ({ root, commit }) => {
    mkdirSync(join(root, 'src/nested'), { recursive: true });
    writeFileSync(join(root, 'root.txt'), 'root\n');
    writeFileSync(join(root, 'src/nested/file.txt'), 'nested\n');
    const pin = commit('files', '2026-01-01T00:00:00Z');
    const selected = { ...diskContract.outputs, vertices: diskContract.outputs.vertices.map(vertex => vertex.kind === 'code.file' ? { ...vertex, fields: vertex.fields.filter(field => field.name === 'directory') } : vertex) };
    const result = await diskExtract(unit(root, pin, selected), context());
    expect(result.end?.state).toBe('complete');
    expect(result.vertices?.map(vertex => ({ path: vertex.key['path'], values: vertex.values, evidence: vertex.evidence }))).toEqual([
      { path: 'root.txt', values: { directory: '.' }, evidence: { repository: 'fixture', path: 'root.txt', commitOrDigest: pin } },
      { path: 'src/nested/file.txt', values: { directory: 'src/nested' }, evidence: { repository: 'fixture', path: 'src/nested/file.txt', commitOrDigest: pin } },
    ]);
  });
}, 60_000);

test('git file facts count exact non-merge touches at the pin and take the maximum date', async () => {
  await fixture(async ({ root, git, commit }) => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'old.txt'), 'old\n');
    writeFileSync(join(root, 'src/file.txt'), 'nested\n');
    commit('base with later clock', '2026-01-10T00:00:00Z');
    writeFileSync(join(root, 'old.txt'), 'old\nedited\n');
    commit('edit with earlier clock', '2026-01-05T00:00:00Z');
    git('mv', 'old.txt', 'renamed.txt');
    commit('rename', '2026-01-06T00:00:00Z');
    git('checkout', '-qb', 'side');
    writeFileSync(join(root, 'src/file.txt'), 'nested\nside\n');
    commit('side change', '2026-01-07T00:00:00Z');
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'main.txt'), 'main\n');
    commit('main change', '2026-01-08T00:00:00Z');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '--no-commit', 'side');
    const pin = commit('merge is not another file change', '2026-01-20T00:00:00Z');
    writeFileSync(join(root, 'src/file.txt'), 'future\n');
    commit('outside pin', '2026-02-01T00:00:00Z');
    const result = await gitExtract(unit(root, pin, gitContract.outputs), context(['renamed.txt', 'src/file.txt', 'main.txt', 'untouched.txt']));
    expect(result.end?.state).toBe('complete');
    const vertices = new Map(result.vertices?.map(vertex => [vertex.key['path'], vertex]));
    expect(vertices.get('old.txt')?.values).toEqual({ commit_count: 2, last_change: '2026-01-10T00:00:00.000Z' });
    expect(vertices.get('renamed.txt')?.values).toEqual({ commit_count: 1, last_change: '2026-01-06T00:00:00.000Z' });
    expect(vertices.get('src/file.txt')?.values).toEqual({ commit_count: 2, last_change: '2026-01-10T00:00:00.000Z' });
    expect(vertices.get('main.txt')?.values).toEqual({ commit_count: 1, last_change: '2026-01-08T00:00:00.000Z' });
    expect(vertices.get('untouched.txt')?.values).toEqual({ commit_count: 0, last_change: null });
    for (const [path, vertex] of vertices) expect(vertex.evidence).toEqual({ repository: 'fixture', path, commitOrDigest: pin });
  });
}, 60_000);
