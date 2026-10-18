/**
 * The snapshot reader (madarch-tzte.21.1, decision 0026 stage 0): one
 * repository pinned at one commit, its tree listed in code point order with
 * each entry's blob, size and mode, and its files' bytes read at that commit.
 *
 * Every expectation here is taken from the task and the decision, never from
 * the module: the tree and the bytes are compared against git's own answers
 * (`git ls-tree -r` and `git cat-file`), the order is code point order, and
 * every refusal is checked for the repository, the commit and the path it must
 * name. The repository is one the test makes, so nothing here depends on this
 * checkout or on a machine's paths.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  createGitSnapshotSource, isReadableEntry, SnapshotError, SnapshotReader, type RepositoryPin,
} from '../src/fill/snapshot.js';

/** A throwaway repository with two commits: the second changes a file, adds a folder and pins a submodule. */
interface Fixture {
  readonly root: string;
  /** The first commit: `README.md`, `Zed.md`, `link.ts` and `src/a.ts`. */
  readonly first: string;
  /** The second commit: `src/a.ts` changed, `src/nested/b.go` added, `sub` a submodule's commit. */
  readonly second: string;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-snapshot-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'Zed.md'), '# the last name in code point order\n');
  await symlink('src/a.ts', join(root, 'link.ts'));
  git('add', '-A');
  git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD').trim();
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'nested', 'b.go'), 'package b\n');
  git('add', '-A');
  // A submodule: a tree entry whose object is a commit of another repository.
  // It is put in the index after the worktree is staged, since `git add -A`
  // would drop an entry that has no folder on disk.
  git('update-index', '--add', '--cacheinfo', `160000,${first},sub`);
  git('commit', '-qm', 'two');
  const second = git('rev-parse', 'HEAD').trim();
  return { root, first, second, dispose: () => rm(root, { recursive: true, force: true }) };
}

function pinOf(f: Fixture, commit: string, id = 'orders-api'): RepositoryPin {
  return { id, form: 'code', root: f.root, commit };
}

/**
 * One loose git object written by hand: `git hash-object --literally` takes a
 * tree's raw content, which is not what `ls-tree` prints, so a tree no git tool
 * would write is built here as git stores it (mode, name, NUL, raw object id,
 * deflated under `.git/objects`, named by its SHA-1). It is the only way to
 * make a tree holding a name git's own tools refuse to write.
 */
function writeLooseTree(root: string, entries: readonly { mode: string; name: string; id: string }[]): string {
  const body = Buffer.concat(entries.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'),
    Buffer.from(entry.id, 'hex'),
  ])));
  const header = Buffer.from(`tree ${body.length}\u0000`, 'utf8');
  const raw = Buffer.concat([header, body]);
  const id = createHash('sha1').update(raw).digest('hex');
  const at = join(root, '.git', 'objects', id.slice(0, 2), id.slice(2));
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, deflateSync(raw));
  return id;
}

/** A throwaway repository the test fills with the names it wants, and commits. */
async function repositoryOf(paths: readonly string[]): Promise<{ root: string; commit: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-snapshot-names-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const path of paths) {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, `the bytes of ${path}\n`);
  }
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return { root, commit: git('rev-parse', 'HEAD').trim(), dispose: () => rm(root, { recursive: true, force: true }) };
}

/** The failure a call raised, so a test can read what it names. */
function raised(call: () => Promise<unknown>): Promise<SnapshotError> {
  return call().then(
    () => { throw new Error('the reader answered where it must refuse'); },
    (error: unknown) => {
      if (!(error instanceof SnapshotError)) throw error;
      return error;
    },
  );
}

/** Whether a string carries every part of a refusal, in the reader's own words. */
function namesAll(error: SnapshotError, repository: string, commit: string, path: string): boolean {
  return error.message.includes(JSON.stringify(repository))
    && error.message.includes(commit)
    && error.message.includes(JSON.stringify(path));
}

describe('the tree of a pinned commit', () => {
  test('the entries are git ls-tree -r answers, in code point order, with each blob, size and mode', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open(pinOf(f, f.second));
      const rows = execFileSync('git', ['-C', f.root, 'ls-tree', '-r', f.second], { encoding: 'utf8' })
        .trim().split('\n').map((row) => {
          const tab = row.indexOf('\t');
          const meta = row.slice(0, tab).split(/\s+/);
          return { path: row.slice(tab + 1), mode: meta[0] ?? '', type: meta[1] ?? '', id: meta[2] ?? '' };
        })
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      expect(reader.entries().map((entry) => ({ path: String(entry.path), mode: String(entry.mode), id: entry.id })))
        .toEqual(rows.map((row) => ({ path: row.path, mode: row.mode, id: row.id })));
      // Code point order, named rather than assumed: the reader's own order.
      const paths: string[] = reader.entries().map((entry) => String(entry.path));
      expect(paths).toEqual([...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
      expect(paths).toEqual(['README.md', 'Zed.md', 'link.ts', 'src/a.ts', 'src/nested/b.go', 'sub']);
      // Each entry's form: a file's blob, a link's target, a submodule's commit.
      expect(reader.entry('link.ts')?.mode).toBe('120000');
      expect(reader.entry('link.ts')?.form).toBe('link');
      expect(reader.entry('sub')?.form).toBe('commit');
      expect(reader.entry('sub')?.bytes).toBeUndefined();
      expect(reader.entry('src/a.ts')?.form).toBe('blob');
      // The sizes are git's own: the tree states them and the files add up.
      expect(reader.entry('src/a.ts')?.bytes).toBe('export const a = 2;\n'.length);
      const held = reader.files();
      expect(held.every(isReadableEntry)).toBe(true);
      expect(held.map((entry) => String(entry.path))).toEqual(['README.md', 'Zed.md', 'link.ts', 'src/a.ts', 'src/nested/b.go']);
      expect(reader.fileCount).toBe(5);
      expect(reader.byteCount).toBe(held.reduce((total, entry) => total + (entry.bytes ?? 0), 0));
      expect(reader.commit).toBe(f.second);
      expect(reader.tree).toBe(execFileSync('git', ['-C', f.root, 'rev-parse', `${f.second}^{tree}`], { encoding: 'utf8' }).trim());
    } finally {
      await f.dispose();
    }
  });

  test('the bytes are the commit\'s bytes, whatever the checkout holds now, and match git cat-file', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open(pinOf(f, f.first));
      // The working tree moves on; the pinned commit's bytes do not.
      await writeFile(join(f.root, 'src', 'a.ts'), 'edited after the commit\n');
      const fromGit = execFileSync('git', ['-C', f.root, 'cat-file', 'blob', `${f.first}:src/a.ts`], { encoding: 'utf8' });
      expect(await reader.readText('src/a.ts')).toBe(fromGit);
      expect(await reader.readText('src/a.ts')).toBe('export const a = 1;\n');
      // A symbolic link's bytes are the path it points at.
      expect(await reader.readText('link.ts')).toBe('src/a.ts');
      // The later commit's file is not in this commit's tree.
      expect(reader.entry('src/nested/b.go')).toBeUndefined();
      expect(reader.entries().map((entry) => String(entry.path))).not.toContain('src/nested/b.go');
      // Bytes, not text: what a parser reads is the same bytes cat-file answers.
      expect([...(await reader.read('README.md'))]).toEqual([...Buffer.from('# fixture\n', 'utf8')]);
    } finally {
      await f.dispose();
    }
  });

  test('a revision is resolved to the commit the facts name, and the tree of that commit is read', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open({ ...pinOf(f, 'HEAD') });
      expect(reader.commit).toBe(f.second);
      const earlier = await SnapshotReader.open(pinOf(f, f.first));
      expect(earlier.commit).toBe(f.first);
      expect(earlier.entries().map((entry) => String(entry.path))).toEqual(['README.md', 'Zed.md', 'link.ts', 'src/a.ts']);
    } finally {
      await f.dispose();
    }
  });
});

describe('what the reader refuses', () => {
  test('a path outside the tree names the repository, the commit and the path', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open(pinOf(f, f.second));
      const missing = await raised(() => reader.read('src/nowhere.ts'));
      expect(missing.refusal).toBe('not-in-tree');
      expect(missing.repository).toBe('orders-api');
      expect(missing.commit).toBe(f.second);
      expect(missing.path).toBe('src/nowhere.ts');
      expect(namesAll(missing, 'orders-api', f.second, 'src/nowhere.ts')).toBe(true);
      // A folder holds no bytes of its own, and the refusal says so.
      const folder = await raised(() => reader.read('src'));
      expect(folder.refusal).toBe('not-in-tree');
      expect(namesAll(folder, 'orders-api', f.second, 'src')).toBe(true);
      // requireEntry refuses where entry looks up.
      expect(reader.entry('src/nowhere.ts')).toBeUndefined();
      expect(() => reader.requireEntry('src/nowhere.ts')).toThrow(SnapshotError);
      // A path that is no repository path is refused by both: a lookup never
      // answers "the tree does not hold it" for a machine's own path.
      const machine = await raised(() => reader.read('/etc/passwd'));
      expect(machine.refusal).toBe('not-a-repository-path');
      expect(() => reader.entry('/etc/passwd')).toThrow(SnapshotError);
      expect(() => reader.requireEntry('../outside.ts')).toThrow(SnapshotError);
    } finally {
      await f.dispose();
    }
  });

  test('a submodule is refused as bytes standing in another repository', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open(pinOf(f, f.second));
      const refusal = await raised(() => reader.read('sub'));
      expect(refusal.refusal).toBe('not-read-here');
      expect(namesAll(refusal, 'orders-api', f.second, 'sub')).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a path that is not a repository path is refused, naming it', async () => {
    const f = await fixture();
    try {
      const reader = await SnapshotReader.open(pinOf(f, f.second));
      for (const path of ['/etc/passwd', '../outside.ts', 'src/', '', 'C:\\checkout\\a.ts', 'src/./a.ts']) {
        const refusal = await raised(() => reader.read(path));
        expect(refusal.refusal).toBe('not-a-repository-path');
        expect(refusal.path).toBe(path);
        expect(namesAll(refusal, 'orders-api', f.second, path)).toBe(true);
      }
    } finally {
      await f.dispose();
    }
  });

  test('a commit the repository does not hold is refused, naming the repository and the commit', async () => {
    const f = await fixture();
    try {
      const missing = '0'.repeat(40);
      const refusal = await raised(() => SnapshotReader.open(pinOf(f, missing)));
      expect(refusal.refusal).toBe('no-commit');
      expect(refusal.repository).toBe('orders-api');
      expect(refusal.commit).toBe(missing);
      expect(refusal.message).toContain(JSON.stringify('orders-api'));
      expect(refusal.message).toContain(missing);
    } finally {
      await f.dispose();
    }
  });

  test('a tree path the fill cannot name is listed as unfiled, never renamed and never dropped in silence', async () => {
    // Git separates with "/" on every machine, so a backslash here is a byte of
    // the name, and two names must never answer as one path. The drive-shaped
    // name is a repository path of git's own that the fill's path form refuses;
    // both are listed as unfiled with why, and the rest of the tree reads.
    const f = await repositoryOf(['a\\b.txt', 'a/b.txt', 'C:/inside.txt', 'plain.ts']);
    try {
      const reader = await SnapshotReader.open({ id: 'orders-api', form: 'code', root: f.root, commit: f.commit });
      expect(reader.entries().map((entry) => String(entry.path))).toEqual(['a/b.txt', 'plain.ts']);
      expect(reader.unfiled().map((entry) => entry.path)).toEqual(['C:/inside.txt', 'a\\b.txt']);
      expect(reader.unfiled().every((entry) => entry.why.length > 0)).toBe(true);
      expect(reader.unfiled()[0]?.why).toContain('machine');
      expect(reader.unfiled()[1]?.why).toContain('backslash');
      // The two files are two, and the one the fill can name answers its own
      // bytes. A path a *caller* asks for is read in the fill's own form, where
      // a backslash is a machine separator (facts.ts): asking for the name git
      // holds with a backslash answers the file the fold names. What the reader
      // never does is take the tree's own path that way — the tree's entry is
      // unfiled, above, and nothing writes a fact of the other file's path.
      expect(reader.files().map((entry) => String(entry.path))).toEqual(['a/b.txt', 'plain.ts']);
      expect(await reader.readText('a/b.txt')).toBe('the bytes of a/b.txt\n');
      expect(await reader.readText('a\\b.txt')).toBe('the bytes of a/b.txt\n');
      // Nothing was renamed: the unfiled entries keep git's own path and id.
      const listed = execFileSync('git', ['-C', f.root, 'ls-tree', '-r', f.commit], { encoding: 'utf8' });
      for (const entry of reader.unfiled()) expect(listed).toContain(entry.id);
    } finally {
      await f.dispose();
    }
  });

  test('a name the fill\'s own path form would change is unfiled, whatever the fold would change in it', async () => {
    // A tree only `hash-object --literally` can write, holding a plain name and
    // a name `repositoryPath` folds: folding files two files under one path and
    // answers one file's bytes for the other, so the fold is refused. The two
    // files stand apart and neither is lost.
    const f = await fixture();
    try {
      const plain = execFileSync('git', ['-C', f.root, 'hash-object', '-w', '--stdin'], { input: 'the plain file\n', encoding: 'utf8' }).trim();
      const dotted = execFileSync('git', ['-C', f.root, 'hash-object', '-w', '--stdin'], { input: 'the dotted file\n', encoding: 'utf8' }).trim();
      const tree = writeLooseTree(f.root, [
        { mode: '100644', name: 'a.ts', id: plain },
        { mode: '100644', name: './a.ts', id: dotted },
      ]);
      const commit = execFileSync('git', ['-C', f.root, 'commit-tree', tree, '-m', 'dotted'], { encoding: 'utf8' }).trim();
      // Git lists the name as the tree holds it; ordinary git tools refuse to
      // write one, which is why the object above is written by hand.
      const listed = execFileSync('git', ['-C', f.root, 'ls-tree', '-r', '-z', commit], { encoding: 'utf8' })
        .split('\u0000').filter((row) => row !== '').map((row) => row.slice(row.indexOf('\t') + 1));
      expect(listed).toEqual(['a.ts', './a.ts']);
      const reader = await SnapshotReader.open({ id: 'orders-api', form: 'code', root: f.root, commit });
      expect(reader.entries().map((entry) => String(entry.path))).toEqual(['a.ts']);
      expect(reader.unfiled().map((entry) => entry.path)).toEqual(['./a.ts']);
      expect(reader.unfiled()[0]?.why).toContain('never folded');
      // The file the fill can name answers its own bytes, and the other file is
      // not the one behind that path.
      expect(await reader.readText('a.ts')).toBe('the plain file\n');
      expect(reader.entry('a.ts')?.id).toBe(plain);
      expect(reader.unfiled()[0]?.id).toBe(dotted);
    } finally {
      await f.dispose();
    }
  });

  test('the entries stand in the project\'s own order, which is what a fact list is read in', async () => {
    // The fill orders by `byCodePoint`, UTF-16 code-unit order: the same order
    // for every name of the basic plane, and the order a supplementary-plane
    // name sorts by. The reader answers that order, and this fixture holds a
    // name no ASCII-only fixture can tell apart from the other order.
    const f = await repositoryOf(['a\uE000.txt', 'a\u{1F600}.txt', 'b.txt']);
    try {
      const reader = await SnapshotReader.open({ id: 'orders-api', form: 'code', root: f.root, commit: f.commit });
      const paths = reader.entries().map((entry) => String(entry.path));
      expect(paths).toEqual(['a\u{1F600}.txt', 'a\uE000.txt', 'b.txt']);
      // Git's own listing is its tree's byte order, which differs from the
      // fill's for a supplementary-plane name (its UTF-8 bytes start above
      // U+E000's) and agrees with it for every name of the basic plane. Both
      // orders are deterministic; the fill's is the order its fact lists are
      // read in, which is why the reader answers that one.
      // `-z` is git's own answer without its C-style quoting of a name that is
      // not ASCII, which is the same answer the reader reads.
      const fromGit = execFileSync('git', ['-C', f.root, 'ls-tree', '-r', '-z', f.commit], { encoding: 'utf8' })
        .split('\0').filter((row) => row !== '').map((row) => row.slice(row.indexOf('\t') + 1));
      expect(fromGit).toEqual(['a\uE000.txt', 'a\u{1F600}.txt', 'b.txt']);
      expect([...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(paths);
    } finally {
      await f.dispose();
    }
  });

  test('a folder that is no repository is refused, naming the folder', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'madarch-not-a-repository-'));
    try {
      const refusal = await raised(() => SnapshotReader.open({ id: 'orders-api', form: 'code', root: plain, commit: 'HEAD' }));
      expect(refusal.refusal).toBe('no-repository');
      expect(refusal.message).toContain(JSON.stringify(plain));
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('the source of a run\'s pins', () => {
  test('the pins come back in code point order, each opened by its repository id', async () => {
    const f = await fixture();
    try {
      const source = createGitSnapshotSource([
        { id: 'web', form: 'code', root: f.root, commit: f.first },
        { id: 'catalog', form: 'product', root: f.root, commit: f.second, defaultBranch: 'main' },
      ]);
      const pins = await source.pins();
      expect(pins.map((pin) => pin.id)).toEqual(['catalog', 'web']);
      const reader = await source.open('catalog');
      expect(reader.repository).toBe('catalog');
      expect(reader.form).toBe('product');
      expect(reader.defaultBranch).toBe('main');
      expect(reader.commit).toBe(f.second);
      // What every fact read here stands on: git and its version on this machine.
      expect(reader.source.system).toBe('git');
      expect(reader.source.version.length).toBeGreaterThan(0);
      expect(reader.defaultBranch).toBe('main');
      expect((await source.open('web')).commit).toBe(f.first);
    } finally {
      await f.dispose();
    }
  });

  test('a repository the pins do not hold, a duplicate pin and a pin that reads as nothing are all refused', async () => {
    const f = await fixture();
    try {
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: f.first }]);
      const unknown = await source.open('catalog-api').then(() => 'answered', (error: Error) => error.message);
      expect(String(unknown)).toContain('"catalog-api"');
      expect(String(unknown)).toContain('"orders-api"');

      // A pin that is no pin at all is named, whatever stands beside it: the
      // pins are judged before they are sorted.
      const beside = createGitSnapshotSource([null as unknown as RepositoryPin, { id: 'orders-api', form: 'code', root: f.root, commit: f.first }]);
      expect(await beside.pins().then(() => 'answered', (error: Error) => error.message)).toContain('is no pinned repository');

      const twice = createGitSnapshotSource([
        { id: 'orders-api', form: 'code', root: f.root, commit: f.first },
        { id: 'orders-api', form: 'code', root: f.root, commit: f.second },
      ]);
      expect(await twice.pins().then(() => 'answered', (error: Error) => error.message)).toContain('the repository "orders-api" is pinned twice');

      for (const broken of [
        { id: 'Orders API', form: 'code' as const, root: f.root, commit: f.first },
        { id: 'orders-api', form: 'library' as never, root: f.root, commit: f.first },
        { id: 'orders-api', form: 'code' as const, root: '', commit: f.first },
        { id: 'orders-api', form: 'code' as const, root: f.root, commit: '  ' },
        { id: 'orders-api', form: 'code' as const, root: f.root, commit: f.first, defaultBranch: '' },
      ]) {
        const message = await createGitSnapshotSource([broken]).pins().then(() => 'answered', (error: Error) => error.message);
        expect(message).not.toBe('answered');
      }
    } finally {
      await f.dispose();
    }
  });

  test('one reader stands per repository, commit and folder, so a unit\'s execute does not list the tree again', async () => {
    const f = await fixture();
    try {
      const source = createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit: f.first }]);
      const once = await source.open('orders-api');
      expect(await source.open('orders-api')).toBe(once);
      // Another commit is another reader: the tree of a commit never changes,
      // and two commits are two trees.
      let commit = f.first;
      const perRun = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      expect((await perRun.open('orders-api')).commit).toBe(f.first);
      commit = f.second;
      expect((await perRun.open('orders-api')).commit).toBe(f.second);
    } finally {
      await f.dispose();
    }
  });

  test('pins read through a function are read when they are asked for, so a run pins its own commit', async () => {
    const f = await fixture();
    try {
      let commit = f.first;
      const source = createGitSnapshotSource(() => [{ id: 'orders-api', form: 'code', root: f.root, commit }]);
      expect((await source.open('orders-api')).commit).toBe(f.first);
      commit = f.second;
      expect((await source.open('orders-api')).commit).toBe(f.second);
    } finally {
      await f.dispose();
    }
  });
});
