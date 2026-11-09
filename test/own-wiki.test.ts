/**
 * madarch's own wiki on a machine (decision 0031): the first start installs the
 * pinned copy (a git bundle the binary carries) or, in a checkout, clones the
 * repository, as a git checkout whose origin is the repository; a later start
 * fast-forwards it only when it has no change of its own. Every refusal names
 * the folder and the repository. The repository here is a fixture on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWN_WIKI_FOLDER, installOwnWiki, ownWikiFolder, ownWikiOff, refreshOwnWiki } from '../src/product/own-wiki.js';
import { makeWikiRepository, ownGit } from './own-wiki-fixture.js';

let work: string;
let source: string;
let home: string;
let env: Record<string, string>;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'madarch-own-wiki-'));
  source = makeWikiRepository(join(work, 'source'));
  home = join(work, 'madarch-home');
  env = { MADARCH_HOME: home };
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('installing the wiki', () => {
  test('a clean machine gets a checkout of the repository in the madarch home, with the repository as its origin', () => {
    const installed = installOwnWiki({ env, repository: source });
    expect(installed).toEqual({ ok: true, folder: join(home, OWN_WIKI_FOLDER), installed: true });
    expect(ownWikiFolder(env)).toBe(join(home, 'madarch-wiki'));
    expect(readFileSync(join(home, 'madarch-wiki', 'docs', 'product.md'), 'utf8')).toContain('product:docs');
    expect(ownGit(join(home, 'madarch-wiki'), ['remote', 'get-url', 'origin'])).toBe(source);
    expect(ownGit(join(home, 'madarch-wiki'), ['status', '--porcelain'])).toBe('');
    // A second start finds it and installs nothing.
    expect(installOwnWiki({ env, repository: source })).toEqual({ ok: true, folder: join(home, 'madarch-wiki'), installed: false });
  });

  test('the pinned copy the binary carries is installed with no network: a bundle of the repository, origin set to the repository', () => {
    ownGit(source, ['bundle', 'create', join(work, 'pinned.bundle'), 'main']);
    const installed = installOwnWiki({ env, repository: 'https://example.invalid/never-fetched.git', bundle: join(work, 'pinned.bundle') });
    expect(installed.ok).toBe(true);
    expect(ownGit(join(home, 'madarch-wiki'), ['remote', 'get-url', 'origin'])).toBe('https://example.invalid/never-fetched.git');
    expect(existsSync(join(home, 'madarch-wiki', 'docs', 'glossary.md'))).toBe(true);
    // No staging folder is left in the madarch home.
    expect(require('node:fs').readdirSync(home)).toEqual(['madarch-wiki']);
  });

  test('a repository that cannot be cloned is a refusal naming the folder and the repository, and nothing is left behind', () => {
    const installed = installOwnWiki({ env, repository: join(work, 'no-such-repository') });
    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.message).toContain(join(home, 'madarch-wiki'));
    expect(installed.message).toContain(join(work, 'no-such-repository'));
    expect(require('node:fs').readdirSync(home)).toEqual([]);
  });

  test('a repository that is no product is refused with the manifest\'s file and line', () => {
    const notProduct = join(work, 'plain');
    require('node:fs').mkdirSync(notProduct);
    writeFileSync(join(notProduct, 'README.md'), 'hello\n');
    ownGit(notProduct, ['init', '--quiet', '--initial-branch=main']);
    ownGit(notProduct, ['add', '.']);
    ownGit(notProduct, ['commit', '--quiet', '-m', 'plain']);
    const installed = installOwnWiki({ env, repository: notProduct });
    expect(installed.ok).toBe(false);
    if (!installed.ok) expect(installed.message).toContain('workspace.yaml');
  });

  test('a folder that is in the way is named, not replaced', () => {
    require('node:fs').mkdirSync(join(home, 'madarch-wiki'), { recursive: true });
    writeFileSync(join(home, 'madarch-wiki', 'note.txt'), 'mine\n');
    const installed = installOwnWiki({ env, repository: source });
    expect(installed.ok).toBe(false);
    if (!installed.ok) expect(installed.message).toContain(join(home, 'madarch-wiki'));
    expect(readFileSync(join(home, 'madarch-wiki', 'note.txt'), 'utf8')).toBe('mine\n');
  });

  test('MADARCH_OWN_WIKI=off switches it off', () => {
    expect(ownWikiOff({ MADARCH_OWN_WIKI: 'off' })).toBe(true);
    expect(ownWikiOff({ MADARCH_OWN_WIKI: ' OFF ' })).toBe(true);
    expect(ownWikiOff({})).toBe(false);
  });
});

describe('refreshing the wiki', () => {
  test('an untouched checkout is fast-forwarded to the repository, and a second refresh says it is up to date', async () => {
    installOwnWiki({ env, repository: source });
    writeFileSync(join(source, 'docs', 'more.md'), '# More\n');
    ownGit(source, ['add', '.']);
    ownGit(source, ['commit', '--quiet', '-m', 'More']);
    const line = await refreshOwnWiki({ env, repository: source });
    expect(line).toContain('was updated to');
    expect(existsSync(join(home, 'madarch-wiki', 'docs', 'more.md'))).toBe(true);
    expect(await refreshOwnWiki({ env, repository: source })).toContain('is up to date');
  });

  test('a checkout with an uncommitted change is left as it is, and the log names the folder and the change', async () => {
    installOwnWiki({ env, repository: source });
    writeFileSync(join(home, 'madarch-wiki', 'docs', 'product.md'), 'edited\n');
    const line = await refreshOwnWiki({ env, repository: source });
    expect(line).toContain('was not refreshed');
    expect(line).toContain(join(home, 'madarch-wiki'));
    expect(line).toContain('docs/product.md');
    expect(readFileSync(join(home, 'madarch-wiki', 'docs', 'product.md'), 'utf8')).toBe('edited\n');
  });

  test('a checkout with a commit of its own is never moved', async () => {
    installOwnWiki({ env, repository: source });
    const folder = join(home, 'madarch-wiki');
    writeFileSync(join(folder, 'docs', 'mine.md'), '# Mine\n');
    ownGit(folder, ['add', '.']);
    ownGit(folder, ['commit', '--quiet', '-m', 'Mine']);
    writeFileSync(join(source, 'docs', 'theirs.md'), '# Theirs\n');
    ownGit(source, ['add', '.']);
    ownGit(source, ['commit', '--quiet', '-m', 'Theirs']);
    const before = ownGit(folder, ['rev-parse', 'HEAD']);
    expect(await refreshOwnWiki({ env, repository: source })).toContain('has commits of its own');
    expect(ownGit(folder, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('git variables that point at another repository are not passed on: the refresh answers for the wiki\'s folder alone', async () => {
    installOwnWiki({ env, repository: source });
    const other = makeWikiRepository(join(work, 'other'));
    writeFileSync(join(source, 'docs', 'new.md'), '# New\n');
    ownGit(source, ['add', '.']);
    ownGit(source, ['commit', '--quiet', '-m', 'New']);
    const before = ownGit(other, ['rev-parse', 'HEAD']);
    const held = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      expect(await refreshOwnWiki({ env })).toContain('was updated to');
    } finally {
      if (held.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = held.dir;
      if (held.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = held.tree;
    }
    expect(ownGit(other, ['rev-parse', 'HEAD'])).toBe(before);
    expect(existsSync(join(home, 'madarch-wiki', 'docs', 'new.md'))).toBe(true);
  });

  test('an unreachable repository is told with the repository and the folder, and the wiki stands as it was', async () => {
    installOwnWiki({ env, repository: source });
    const before = ownGit(join(home, 'madarch-wiki'), ['rev-parse', 'HEAD']);
    ownGit(join(home, 'madarch-wiki'), ['remote', 'set-url', 'origin', join(work, 'gone')]);
    const line = await refreshOwnWiki({ env });
    expect(line).toContain('was not refreshed');
    expect(line).toContain(join(work, 'gone'));
    expect(line).toContain(join(home, 'madarch-wiki'));
    expect(ownGit(join(home, 'madarch-wiki'), ['rev-parse', 'HEAD'])).toBe(before);
  });
});
