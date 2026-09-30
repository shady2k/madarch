import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureWikiCacheRoot, wikiCacheRoot } from '../src/wiki/cache.js';

/**
 * The wiki's per-user cache root (src/wiki/cache.ts): where the root is
 * derived from, and the trust rules it is created and re-checked by — the
 * folder is private to the running user, or the build refuses it, because
 * installs are executed from it and the LikeC4 scratch is kept in it.
 */

/**
 * Every temporary folder this file makes, removed after each test and on
 * exit with whatever is left, pass or fail: a run of the suite leaves the
 * system temporary folder as it found it.
 */
const made: string[] = [];

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

describe('wikiCacheRoot', () => {
  test('MADARCH_WIKI_CACHE names the root outright', () => {
    expect(wikiCacheRoot({ MADARCH_WIKI_CACHE: '/data/wikicache' })).toBe('/data/wikicache');
  });

  test('without the override the root is madarch/wiki under XDG_CACHE_HOME, else under ~/.cache', () => {
    expect(wikiCacheRoot({ XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'madarch', 'wiki'));
    expect(wikiCacheRoot({})).toBe(join(homedir(), '.cache', 'madarch', 'wiki'));
  });
});

describe('ensureWikiCacheRoot', () => {
  test('a missing root is created private to the user, nested folders included', () => {
    const base = tempFolder('madarch-cache-base-');
    const root = join(base, 'madarch', 'wiki');
    const ensured = ensureWikiCacheRoot({ MADARCH_WIKI_CACHE: root });
    expect(ensured).toEqual({ ok: true, root });
    const stats = lstatSync(root);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test('an existing private root is accepted as it stands', () => {
    const root = tempFolder('madarch-cache-ok-');
    chmodSync(root, 0o700);
    expect(ensureWikiCacheRoot({ MADARCH_WIKI_CACHE: root })).toEqual({ ok: true, root });
  });

  test('a root writable by group or others is refused, naming the fix', () => {
    const root = tempFolder('madarch-cache-loose-');
    chmodSync(root, 0o722);
    const ensured = ensureWikiCacheRoot({ MADARCH_WIKI_CACHE: root });
    expect(ensured.ok).toBe(false);
    if (!ensured.ok) {
      expect(ensured.message).toContain(root);
      expect(ensured.message).toContain('chmod 700');
      expect(ensured.message).toContain('MADARCH_WIKI_CACHE');
    }
  });

  test('a root that is a symlink is refused, wherever it points', () => {
    const base = tempFolder('madarch-cache-link-');
    const real = join(base, 'elsewhere');
    mkdirSync(real, { recursive: true });
    const root = join(base, 'wiki');
    symlinkSync(real, root);
    const ensured = ensureWikiCacheRoot({ MADARCH_WIKI_CACHE: root });
    expect(ensured.ok).toBe(false);
    if (!ensured.ok) expect(ensured.message).toContain('symlink');
  });

  test('a root that is a file is refused as one that cannot be created', () => {
    const base = tempFolder('madarch-cache-file-');
    const root = join(base, 'wiki');
    writeFileSync(root, 'not a folder\n');
    const ensured = ensureWikiCacheRoot({ MADARCH_WIKI_CACHE: root });
    expect(ensured.ok).toBe(false);
    if (!ensured.ok) expect(ensured.message).toContain('cannot be created');
  });
});
