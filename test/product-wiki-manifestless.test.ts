import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { isExistingDirectoryWithoutManifest } from '../src/product-wiki/manifestless.js';

let folder: string | undefined;
afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the serving-only manifestless directory check', () => {
  test('accepts an existing directory with no manifest entry', () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-manifestless-'));
    expect(isExistingDirectoryWithoutManifest(folder)).toBe(true);
  });

  test('rejects a missing path and a non-directory', () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-manifestless-'));
    expect(isExistingDirectoryWithoutManifest(join(folder, 'missing'))).toBe(false);
    // A regular file is not a directory, even when it has no manifest.
    const file = join(folder, 'file');
    writeFileSync(file, 'not a directory');
    expect(isExistingDirectoryWithoutManifest(file)).toBe(false);
  });

  test('rejects any manifest directory entry, including a dangling symlink', () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-manifestless-'));
    symlinkSync(join(folder, 'missing-target.yaml'), join(folder, 'workspace.yaml'));
    expect(isExistingDirectoryWithoutManifest(folder)).toBe(false);
  });

  test('does not treat a present but unreadable manifest entry as absent', () => {
    const denied = {
      stat: () => ({ isDirectory: () => true }),
      lstat: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    };
    expect(isExistingDirectoryWithoutManifest('/unreadable-product', denied)).toBe(false);
  });
});
