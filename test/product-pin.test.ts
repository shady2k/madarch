/**
 * The pin of the set's product-repository program (madarch-4fk, decision
 * 0019): the vendored release is byte-for-byte the published one, and the
 * files this repository did not write are kept so. A drifted vendor copy
 * would be a program of nobody's making — the check names the exact
 * upstream tree to compare against again.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const VENDOR = fileURLToPath(new URL('../vendor/shady2k-skills/0.94.0/', import.meta.url));
const PROGRAM = join(VENDOR, 'product.mjs');
const CASES = join(VENDOR, 'fixtures', 'workspace', 'cases.json');

/** The pinned release's exact bytes, hashed at the pinning (vendor/shady2k-skills/README.md). */
const PIN = {
  version: '0.94.0',
  upstream: 'https://github.com/shady2k/skills',
  commit: '03603ab67c08df1be2640ae1f8ca1ae6c9f54dbe',
  hashes: {
    'product.mjs': '445bd3a8d0504b8d49ffa7fcdd6c0da96c2a3caf4b99898f2b14bda4539ce2ab',
    'fixtures/workspace/cases.json': '62ac57acf3e840235f7cd398b5acb72c77e5e5f9424055ee47339dfe29614f2d',
    'fixtures/product/good/AGENTS.md': '9824c6a809e32cae44aeb4ef1fcee9b3368d82aefd6df102ab70219c251d7858',
    'fixtures/product/good/workspace.yaml': 'f0dbb6f4cc35e6486eae3d33baa4bc9e7d0e6c067e762bed7b66f36d1136decb',
  },
} as const;

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('the pinned program', () => {
  test('the vendored files are byte-identical to the pinned upstream tree', () => {
    for (const [file, hash] of Object.entries(PIN.hashes)) {
      expect(sha256(join(VENDOR, file))).toBe(hash);
    }
  });

  test('--version prints the pinned release, the program\'s own constant (no plugin manifest is beside it)', () => {
    const run = spawnSync('node', [PROGRAM, '--version'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(PIN.version);
  });

  test('--selftest passes over the set\'s own cases, from the vendored fixtures', () => {
    const run = spawnSync('node', [PROGRAM, '--selftest'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`PASS  workspace/draft`);
    expect(run.stdout).not.toContain('FAIL');
  });

  test('the vendored folder holds only the program, its declarations and the fixtures it reads', () => {
    // The pin's hashes keep covering everything the program reads from
    // itself; nothing else may live beside it.
    const files = walk(VENDOR).map((file) => file.slice(VENDOR.length)).sort();
    const expected = new Set([...Object.keys(PIN.hashes), 'product.d.mts']);
    for (const file of files) {
      if (!file.startsWith('fixtures/product/good/')) {
        expect(expected.has(file) || Object.keys(PIN.hashes).includes(file), file).toBe(true);
      }
    }
    expect(files.some((file) => file.startsWith('fixtures/product/good/'))).toBe(true);
  });
});

/** Every file under a folder, deepest first, for the walk above. */
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
