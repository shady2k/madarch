/**
 * The two passes over the shapes git can give a tree and a history (madarch-8bdc.2.5,
 * item 6): a submodule, a shallow clone, a path and a subject written in bytes that are no
 * UTF-8, and a merge commit. Each case asserts the pass's answer equals what git states at
 * the same commit, or — where git stated bytes no text can hold — that a `gap` row names
 * what could not be read. No result is smaller than git's in silence.
 *
 * Every fixture is built here, never read from another checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryHistory, readRepositoryTree, type RepositoryAt } from '../src/fill/stages/repository-facts.js';

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-git-shapes-'));
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test',
  GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00+0000', GIT_COMMITTER_DATE: '2020-01-01T00:00:00+0000',
  TZ: 'UTC', LC_ALL: 'C',
};

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

/** One git command in a folder; answers its bytes as they are, which is what a non-UTF-8 case needs. */
function gitBytes(folder: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync('git', [...args], { cwd: folder, env: { ...process.env, ...IDENTITY }, input, maxBuffer: 64 * 1024 * 1024 });
}

function git(folder: string, ...args: string[]): string {
  return gitBytes(folder, args).toString('utf8').trim();
}

/** A repository with the identity its fixtures commit under. */
function repositoryAt(name: string): string {
  const folder = join(ROOT, name);
  mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'commit.gpgsign', 'false');
  return folder;
}

/** One folder as the passes read it, pinned at HEAD. */
function pin(folder: string, name = folder.slice(folder.lastIndexOf('/') + 1)): RepositoryAt {
  return { repository: name, root: folder, commit: git(folder, 'rev-parse', 'HEAD'), url: `file://${folder}` };
}

/** `git ls-tree -r -l` as git states one tree: path, mode and object, in git's order. */
function lsTree(folder: string, commit: string): { path: string; mode: string; blob: string }[] {
  const text = gitBytes(folder, ['ls-tree', '-r', '-l', '-z', commit]).toString('latin1');
  const rows = text.split('\u0000').filter((row) => row !== '');
  return rows.map((row) => {
    const tab = row.indexOf('\t');
    const [mode, , blob] = row.slice(0, tab).split(/\s+/);
    return { path: row.slice(tab + 1), mode: mode!, blob: blob! };
  });
}

describe('a submodule', () => {
  let outer = '';
  let innerCommit = '';

  beforeAll(() => {
    const inner = repositoryAt('submodule-inner');
    writeFileSync(join(inner, 'inner.txt'), 'inner\n');
    git(inner, 'add', '-A');
    git(inner, 'commit', '-qm', 'inner: one');
    innerCommit = git(inner, 'rev-parse', 'HEAD');
    outer = repositoryAt('submodule-outer');
    writeFileSync(join(outer, 'outer.txt'), 'outer\n');
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub');
    git(outer, 'commit', '-qm', 'outer: the submodule');
  }, 120_000);

  test('the tree pass names the gitlink as git states it: the path and the commit the tree holds', async () => {
    const head = git(outer, 'rev-parse', 'HEAD');
    const stated = lsTree(outer, head).find((row) => row.path === 'sub');
    expect(stated).toBeDefined();
    expect(stated!.mode).toBe('160000');
    const tree = await readRepositoryTree(pin(outer));
    expect(tree.gitlinks).toEqual([{ path: 'sub', otherRepository: 'sub', commit: innerCommit }]);
    expect(tree.gitlinks[0]!.commit).toBe(stated!.blob);
    // The submodule's own files are not this tree's files: git lists the gitlink, and the pass lists no file under it.
    expect(tree.files.some((file) => file.path.startsWith('sub/'))).toBe(false);
    expect(tree.files.map((file) => file.path)).toEqual(lsTree(outer, head).filter((row) => row.mode !== '160000').map((row) => row.path).sort());
    expect(tree.gaps).toEqual([]);
  }, 120_000);
});

describe('a shallow clone', () => {
  let clone = '';

  beforeAll(() => {
    const origin = repositoryAt('shallow-origin');
    writeFileSync(join(origin, 'one.txt'), 'one\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'shallow: one');
    writeFileSync(join(origin, 'two.txt'), 'two\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'shallow: two');
    clone = join(ROOT, 'shallow-clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, clone], { env: { ...process.env, ...IDENTITY } });
  }, 120_000);

  test('the history pass names the shallow history it could not read whole, and reads every commit it can', async () => {
    const at = pin(clone, 'shallow-clone');
    const history = await readRepositoryHistory(at);
    // git's own answer: one commit, and the repository is shallow.
    expect(git(clone, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(history.commits.map((commit) => commit.hash)).toEqual([at.commit]);
    expect(history.gaps).toContainEqual({ what: `shallow-clone at ${at.commit}`, reason: 'shallow-history' });
    expect((await readRepositoryTree(at)).files.map((file) => file.path)).toEqual(['one.txt', 'two.txt']);
  }, 120_000);
});

describe('a path and a subject in bytes that are no UTF-8', () => {
  let folder = '';

  beforeAll(() => {
    folder = repositoryAt('non-utf8');
    writeFileSync(join(folder, 'plain.txt'), 'plain\n');
    // The name's bytes are 0x63 0x61 0x66 0xe9 0x2e 0x74 0x73: `caf`, one byte no UTF-8 holds, `.ts`.
    writeFileSync(Buffer.concat([Buffer.from(folder), Buffer.from('/caf'), Buffer.from([0xe9]), Buffer.from('.ts')]), 'x\n');
    gitBytes(folder, ['add', '-A']);
    // The commit object is written by hand with `git hash-object`, so its subject is the bytes and no encoding is
    // declared: `git log` answers them as they are, which is the shape the pass must not replace.
    const tree = git(folder, 'write-tree');
    const object = Buffer.concat([
      Buffer.from(`tree ${tree}\nauthor Ada Example <ada@example.test> 1577836800 +0000\ncommitter Ada Example <ada@example.test> 1577836800 +0000\n\ncaf`),
      Buffer.from([0xe9]),
      Buffer.from(' subject\n'),
    ]);
    const commit = gitBytes(folder, ['hash-object', '-w', '-t', 'commit', '--stdin'], object).toString('utf8').trim();
    git(folder, 'update-ref', 'refs/heads/main', commit);
  }, 120_000);

  test('a path git wrote in other bytes is a named gap, and every path it wrote as text is the tree\'s', async () => {
    const head = git(folder, 'rev-parse', 'HEAD');
    const stated = lsTree(folder, head).map((row) => row.path).sort();
    // Git states two paths, and one of them is bytes no text can hold.
    expect(stated).toContain('plain.txt');
    expect(stated.some((path) => path.includes('caf'))).toBe(true);
    const tree = await readRepositoryTree(pin(folder));
    expect(tree.files.map((file) => file.path)).toEqual(['plain.txt']);
    expect(tree.gaps).toContainEqual({ what: 'path caf\\xe9.ts', reason: 'non-utf8-path' });
    expect(tree.files.some((file) => file.path.includes('\uFFFD'))).toBe(false);
  }, 120_000);

  test('a subject git wrote in other bytes is escaped as its bytes and named by a gap, and the commit stands', async () => {
    const at = pin(folder);
    const history = await readRepositoryHistory(at);
    expect(history.commits).toHaveLength(1);
    const commit = history.commits[0]!;
    expect(commit.hash).toBe(at.commit);
    expect(commit.subject).toBe('caf\\xe9 subject');
    expect(history.gaps).toContainEqual({ what: 'commit ' + at.commit + ' subject caf\\xe9 subject', reason: 'unreadable' });
    // No replacement character stands in for a byte: the answer is the bytes, escaped, or a gap.
    expect(JSON.stringify(history.commits)).not.toContain('\uFFFD');
  }, 120_000);
});

describe('a merge commit', () => {
  let folder = '';
  let merge = '';

  beforeAll(() => {
    folder = repositoryAt('merge');
    writeFileSync(join(folder, 'base.txt'), 'base\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'merge: base');
    git(folder, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(folder, 'feature.txt'), 'feature\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'merge: feature');
    git(folder, 'checkout', '-q', 'main');
    writeFileSync(join(folder, 'main.txt'), 'main\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'merge: main');
    git(folder, 'merge', '-q', '--no-ff', '-m', 'merge: the merge', 'feature');
    merge = git(folder, 'rev-parse', 'HEAD');
  }, 120_000);

  test('the history pass names both parents and the paths the merge changed against its first parent, as git states them', async () => {
    const at = { ...pin(folder), commit: merge };
    const history = await readRepositoryHistory(at);
    const stated = git(folder, 'rev-list', '--parents', '-n', '1', merge).split(' ');
    const row = history.commits.find((commit) => commit.hash === merge)!;
    expect(row.parents).toEqual(stated.slice(1));
    expect(row.parents).toHaveLength(2);
    // Git's own first-parent statement of what the merge touched.
    const status = gitBytes(folder, ['log', '-1', '--first-parent', '--name-status', '--format=', '-z', merge]).toString('latin1').split('\u0000').filter((one) => one !== '' && one !== '\n');
    const statedPaths: string[] = [];
    for (let index = 0; index < status.length; index += 2) if (/^[ACDMRT]/.test(status[index]!)) statedPaths.push(status[index + 1]!);
    expect(row.touched.map((touched) => touched.path).sort()).toEqual(statedPaths.sort());
    expect(row.touched.map((touched) => touched.path)).toContain('feature.txt');
    expect(history.gaps).toEqual([]);
  }, 120_000);
});
