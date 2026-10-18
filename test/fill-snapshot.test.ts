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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
