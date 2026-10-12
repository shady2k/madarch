/**
 * The release assets the compiled binary carries (madarch-lfhu): the
 * wiki-app folder and the version file are read through Bun.main's
 * directory; a root argument answers the tests with a scratch tree shaped
 * like the release build lays it, and a checkout's own root (the module
 * runs beside the sources there) sees nothing.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { embeddedWikiApp, releaseVersion } from '../src/product-wiki/release-assets.js';

describe('the release assets', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function scratch(): string {
    home = mkdtempSync(join(tmpdir(), 'madarch-release-assets-'));
    return home;
  }

  test('the module beside the sources holds no wiki-app folder and no version file', () => {
    expect(embeddedWikiApp()).toBeUndefined();
    expect(releaseVersion()).toBeUndefined();
  });

  test('the wiki-app folder answers when its dist carries index.html, not otherwise', () => {
    const root = scratch();
    expect(embeddedWikiApp(root)).toBeUndefined();
    mkdirSync(join(root, 'wiki-app', 'dist'), { recursive: true });
    expect(embeddedWikiApp(root)).toBeUndefined();
    writeFileSync(join(root, 'wiki-app', 'dist', 'index.html'), '<!doctype html>');
    expect(embeddedWikiApp(root)).toBe(join(root, 'wiki-app'));
  });

  test('the version file answers its trimmed text, and an empty one answers undefined', () => {
    const root = scratch();
    expect(releaseVersion(root)).toBeUndefined();
    writeFileSync(join(root, 'version'), '1.2.3\n');
    expect(releaseVersion(root)).toBe('1.2.3');
    writeFileSync(join(root, 'version'), '  \n');
    expect(releaseVersion(root)).toBeUndefined();
  });

  test('a version file that cannot be read answers undefined, never a half version', () => {
    const root = scratch();
    mkdirSync(join(root, 'version'), { recursive: true });
    expect(releaseVersion(root)).toBeUndefined();
  });
});
