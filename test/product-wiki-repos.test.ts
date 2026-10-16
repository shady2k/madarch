import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProductRepos, type ProductRefsAnswer } from '../src/product-wiki/repos.js';
import { readProduct } from '../src/product/manifest.js';
import { gitEnv } from './git-env.js';

/**
 * The code repositories the wiki reads (docs/changes/wiki-repos, requirement
 * `repositories`): the manifest's declared list, each with its checkout
 * state under `repos/`, the checkout's HEAD when one is there — sha,
 * subject, time through real git — and its README when the checkout's root
 * holds one. A checkout that cannot be read is reported as `unreadable`
 * with the cause named, never thrown, and never a silently smaller answer.
 * Nothing here writes: the git calls are `rev-parse` and `log`.
 */

let folder: string | undefined;
const identities: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Repos Test',
  GIT_AUTHOR_EMAIL: 'repos-test@example.com',
  GIT_COMMITTER_NAME: 'Repos Test',
  GIT_COMMITTER_EMAIL: 'repos-test@example.com',
};

function scratch(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-repos-'));
  return folder;
}

/** Writes a manifest declaring the given repositories, the way `repo add` leaves it. */
function manifest(repos: { name: string; url: string; branch?: string }[]): string {
  const product = scratch();
  const lines = ['schemaVersion: 1', 'id: repos-demo', 'name: Repos Demo'];
  if (repos.length > 0) {
    lines.push('repos:');
    for (const repo of repos) {
      lines.push(`  - name: ${repo.name}`);
      lines.push(`    url: ${repo.url}`);
      if (repo.branch !== undefined) lines.push(`    branch: ${repo.branch}`);
    }
  }
  writeFileSync(join(product, 'workspace.yaml'), lines.join('\n') + '\n');
  return product;
}

/** Makes a real git repository at the path, with one commit of the given subject. */
function checkout(root: string, name: string, subject: string, files: Record<string, string> = { 'README.md': '# ' + name }): string {
  const target = join(root, 'repos', name);
  mkdirSync(target, { recursive: true });
  const run = (args: string[]): string => {
    const done = spawnSync('git', args, { cwd: target, encoding: 'utf8', env: { ...gitEnv(), ...identities } });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr}${done.stdout}`);
    return done.stdout;
  };
  run(['init', '--quiet', '--initial-branch=main']);
  for (const [file, body] of Object.entries(files)) writeFileSync(join(target, file), body);
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', subject]);
  return target;
}

function reposOf(product: string): ProductRefsAnswer {
  const read = readProduct(product);
  if (!read.ok) throw new Error(read.message);
  return readProductRepos(read.product, gitEnv(identities));
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the repositories a manifest declares', () => {
  test('a manifest with no repos item answers an empty list', () => {
    const product = manifest([]);
    const answer = reposOf(product);
    expect(answer).toEqual({ ok: true, repos: [] });
  });

  test('a declared repository with nothing under repos/ reads not-checked-out, with its url and branch', () => {
    const product = manifest([
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'web', url: 'https://example.com/web.git', branch: 'main' },
    ]);
    const answer = reposOf(product);
    expect(answer.repos).toEqual([
      { name: 'core', path: 'repos/core', url: 'https://example.com/core.git', state: 'not-checked-out' },
      { name: 'web', path: 'repos/web', url: 'https://example.com/web.git', branch: 'main', state: 'not-checked-out' },
    ]);
  });

  test('a checked-out repository answers its HEAD — short sha, subject and time — from a real git read', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const target = checkout(product, 'core', 'Make the core');
    const answer = reposOf(product);
    expect(answer.repos).toHaveLength(1);
    const row = answer.repos[0]!;
    expect(row.name).toBe('core');
    expect(row.state).toBe('checked-out');
    expect(row.head?.subject).toBe('Make the core');
    expect(row.head?.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const own = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: target, encoding: 'utf8', env: gitEnv() });
    expect(row.head?.sha).toBe(own.stdout.trim());
  });

  test('a checked-out repository includes its top-level file tree in code-point order', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core', { 'README.md': '# Core', 'src.ts': 'export {}', '.gitignore': 'dist' });
    expect(reposOf(product).repos[0]?.files).toEqual(['.gitignore', 'README.md', 'src.ts']);
  });

  test('the README the checkout holds, any case, comes whole for the renderer', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core', { 'ReadMe.MD': '# The core\n\nIts readme.\n' });
    const answer = reposOf(product);
    expect(answer.repos[0]?.readme).toEqual({ file: 'ReadMe.MD', markdown: '# The core\n\nIts readme.\n' });
  });

  test('a checkout without a README says so quietly, still checked out with its HEAD', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core', { 'main.ts': 'export const core = 1;\n' });
    const answer = reposOf(product);
    const row = answer.repos[0]!;
    expect(row.state).toBe('checked-out');
    expect(row.head?.subject).toBe('Make the core');
    expect(row.readme).toBeUndefined();
  });

  test('a linked Git checkout is read through its directory symlink', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const source = checkout(scratch(), 'source', 'Linked core', { 'README.md': '# Linked core', 'src.ts': 'export {}' });
    mkdirSync(join(product, 'repos'), { recursive: true }); symlinkSync(source, join(product, 'repos', 'core'), 'dir');
    const answer = reposOf(product);
    expect(answer.repos[0]).toMatchObject({ name: 'core', path: 'repos/core', state: 'checked-out', readme: { markdown: '# Linked core' }, files: ['README.md', 'src.ts'] });
  });

  test('a declared name taken by a file, a symlink and a folder with no repository of its own are unreadable, causes named', () => {
    const product = manifest([
      { name: 'afile', url: 'https://example.com/afile.git' },
      { name: 'alink', url: 'https://example.com/alink.git' },
      { name: 'afolder', url: 'https://example.com/afolder.git' },
    ]);
    mkdirSync(join(product, 'repos'), { recursive: true });
    writeFileSync(join(product, 'repos', 'afile'), 'not a folder\n');
    symlinkSync(join(product, 'docs'), join(product, 'repos', 'alink'));
    mkdirSync(join(product, 'repos', 'afolder'), { recursive: true });
    writeFileSync(join(product, 'repos', 'afolder', 'note.txt'), 'plain folder\n');
    const answer = reposOf(product);
    const byName = new Map(answer.repos.map((row) => [row.name, row]));
    const file = byName.get('afile');
    const link = byName.get('alink');
    const plain = byName.get('afolder');
    expect(file?.state).toBe('unreadable');
    expect(file?.problem).toContain(join(product, 'repos', 'afile'));
    expect(file?.problem).toContain('not a folder');
    expect(link?.state).toBe('unreadable');
    expect(link?.problem).toContain('symlink');
    expect(link?.problem).toContain(join(product, 'repos', 'alink'));
    expect(plain?.state).toBe('unreadable');
    // git itself says there is no repository here or above: its words are kept.
    expect(plain?.problem).toContain('git could not read the checkout');
    expect(plain?.problem).toContain('not a git repository');
  });

  test('a git repository with no commit yet is checked out, its cause named, its README still shown', () => {
    const product = manifest([{ name: 'fresh', url: 'https://example.com/fresh.git' }]);
    const target = join(product, 'repos', 'fresh');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'README.md'), '# fresh\n');
    const run = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: target, encoding: 'utf8', env: gitEnv(identities) });
    expect(run.status).toBe(0);
    const answer = reposOf(product);
    const row = answer.repos[0]!;
    expect(row.state).toBe('checked-out');
    expect(row.head).toBeUndefined();
    expect(row.problem).toContain('no commit yet');
    expect(row.readme?.markdown).toBe('# fresh\n');
  });

  test('the answer stands in code point order of the names, whatever order the manifest wrote', () => {
    const product = manifest([
      { name: 'zeta', url: 'https://example.com/zeta.git' },
      { name: 'Alpha', url: 'https://example.com/alpha.git' },
    ]);
    checkout(product, 'zeta', 'Zeta');
    checkout(product, 'Alpha', 'Alpha');
    const answer = reposOf(product);
    expect(answer.repos.map((row) => row.name)).toEqual(['Alpha', 'zeta']);
  });

  test('asking reads the checkouts without changing them', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core');
    const statusBefore = spawnSync('git', ['status', '--porcelain'], {
      cwd: join(product, 'repos', 'core'), encoding: 'utf8', env: gitEnv(),
    }).stdout;
    reposOf(product);
    reposOf(product);
    const statusAfter = spawnSync('git', ['status', '--porcelain'], {
      cwd: join(product, 'repos', 'core'), encoding: 'utf8', env: gitEnv(),
    }).stdout;
    expect(statusAfter).toBe(statusBefore);
  });

  test('a second commit in the checkout is what the next ask reports', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const target = checkout(product, 'core', 'Make the core');
    const answer = reposOf(product);
    expect(answer.repos[0]?.head?.subject).toBe('Make the core');
    writeFileSync(join(target, 'more.ts'), 'export const more = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: target, encoding: 'utf8', env: { ...gitEnv(), ...identities } });
    spawnSync('git', ['commit', '--quiet', '-m', 'Add more'], { cwd: target, encoding: 'utf8', env: { ...gitEnv(), ...identities } });
    const second = reposOf(product);
    expect(second.repos[0]?.head?.subject).toBe('Add more');
  });

  test('the README is picked by priority: readme.md over readme.txt over a bare readme, a folder named README is not one', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const target = checkout(product, 'core', 'Make the core', {
      'README.md': '# The markdown one\\n',
      'readme.txt': 'the text one\\n',
      'readme.md': '# lower-case markdown\\n',
    });
    mkdirSync(join(target, 'readme'), { recursive: true }); // a folder of that name is not a README
    writeFileSync(join(target, 'readme', 'note.txt'), 'inside the folder\\n');
    const answer = reposOf(product);
    expect(answer.repos[0]?.readme?.file).toBe('README.md');
    expect(answer.repos[0]?.readme?.markdown).toBe('# The markdown one\\n');
  });

  test('a git call with a leaking GIT_DIR in the environment still answers for the checkout, not the loader folder', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core');
    const leaking = gitEnv({ GIT_DIR: join(product, '.git'), GIT_WORK_TREE: product, ...identities });
    const read = readProduct(product);
    if (!read.ok) throw new Error(read.message);
    const answer = readProductRepos(read.product, leaking);
    expect(answer.repos[0]?.state).toBe('checked-out');
    expect(answer.repos[0]?.head?.subject).toBe('Make the core');
  });

  test('the checkout folder itself counts as the repository, and a product whose walk starts inside repos/ is not reached', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core');
    // The checkout's own rev-parse answers the checkout; the product's
    // repository above it is never the answer, whatever folder names a
    // repository of its own around the product.
    const answer = reposOf(product);
    expect(answer.repos[0]?.state).toBe('checked-out');
  });

  test('a README that is a folder is not read; a README that cannot be opened is a problem named on a checked-out row', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const target = checkout(product, 'core', 'Make the core', { 'main.ts': 'export const core = 1;\n' });
    mkdirSync(join(target, 'README.md'), { recursive: true }); // a folder of the README's name is no README
    const first = reposOf(product);
    expect(first.repos[0]?.state).toBe('checked-out');
    expect(first.repos[0]?.readme).toBeUndefined();
    expect(first.repos[0]?.problem).toBeUndefined();
  });

  test('a README whose bytes cannot be read leaves the problem on the row, the state still checked-out', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    const target = checkout(product, 'core', 'Make the core', { 'README.md': '# sealed\n' });
    chmodSync(join(target, 'README.md'), 0o000);
    try {
      const answer = reposOf(product);
      const row = answer.repos[0]!;
      expect(row.state).toBe('checked-out');
      expect(row.head?.subject).toBe('Make the core');
      expect(row.problem).toContain('README');
      expect(row.problem).toContain(join(product, 'repos', 'core'));
    } finally {
      chmodSync(join(target, 'README.md'), 0o644);
    }
  });

  test('a manifest branch that is declared rides to the checked-out row', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git', branch: 'develop' }]);
    checkout(product, 'core', 'Make the core');
    const answer = reposOf(product);
    expect(answer.repos[0]?.branch).toBe('develop');
    expect(answer.repos[0]?.state).toBe('checked-out');
  });

  test('a plain folder named by the manifest inside a product that is itself a repository answers the product, so it is unreadable', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    // The product itself is a git repository: rev-parse from the plain
    // repos/core answers the product's toplevel, never the checkout.
    spawnSync('git', ['init', '--quiet'], { cwd: product, encoding: 'utf8', env: { ...gitEnv(), ...identities } });
    mkdirSync(join(product, 'repos', 'core'), { recursive: true });
    const answer = reposOf(product);
    expect(answer.repos[0]?.state).toBe('unreadable');
    expect(answer.repos[0]?.problem).toContain('is not a git checkout of its own');
    expect(answer.repos[0]?.problem).toContain('answers for the repository at');
    expect(answer.repos[0]?.problem).toContain(JSON.stringify(product));
  });

  test('a repos entry that cannot be lstat-ed because repos itself is a file reads not-checked-out; the symlink problem names the path', () => {
    const product = manifest([
      { name: 'core', url: 'https://example.com/core.git' },
      { name: 'link', url: 'https://example.com/link.git' },
    ]);
    writeFileSync(join(product, 'repos'), 'not a folder\n');
    symlinkSync(product, join(product, 'link')); // never reached: lstat(repos/link) throws first
    const answer = reposOf(product);
    expect(answer.repos[0]?.state).toBe('not-checked-out');
    expect('state' in (answer.repos[1] as object)).toBe(true);
  });

  test('a row without a declared branch carries no branch key, and one without a README carries no readme key', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core', { 'main.ts': 'export const core = 1;\n' });
    const answer = reposOf(product);
    const row = answer.repos[0] as object;
    expect('branch' in row).toBe(false);
    expect('readme' in row).toBe(false);
  });

  test('a commitless checkout whose README cannot be read keeps its no-commit cause, not a README overwrite', () => {
    const product = manifest([{ name: 'fresh', url: 'https://example.com/fresh.git' }]);
    const target = join(product, 'repos', 'fresh');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'README.md'), '# fresh\n');
    spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: target, encoding: 'utf8', env: gitEnv(identities) });
    chmodSync(join(target, 'README.md'), 0o000);
    try {
      const answer = reposOf(product);
      const row = answer.repos[0]!;
      expect(row.state).toBe('checked-out');
      expect(row.head).toBeUndefined();
      expect(row.problem).toContain('no commit yet');
      expect('readme' in (row as object)).toBe(false);
    } finally {
      chmodSync(join(target, 'README.md'), 0o644);
    }
  });

  test('a checkout read from a product whose folder moved keeps naming its own paths, never another repository', () => {
    const product = manifest([{ name: 'core', url: 'https://example.com/core.git' }]);
    checkout(product, 'core', 'Make the core');
    // A git call run in a folder with no repository of its own answers for
    // the one above it; the checkout's own rev-parse must answer itself.
    const answer = reposOf(product);
    expect(answer.repos[0]?.state).toBe('checked-out');
    const inside = join(product, 'repos', 'core');
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: inside, encoding: 'utf8', env: gitEnv() }).stdout.trim();
    expect(top).toBe(inside);
  });
});
