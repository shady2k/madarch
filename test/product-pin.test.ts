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
  // Every file the pinned tree holds, product.d.mts (this repository's own
  // declarations, beside the pin but not of it) apart: one hash each, so a
  // drifted or replaced file anywhere in the tree is refused by name.
  hashes: {
    "product.mjs": "445bd3a8d0504b8d49ffa7fcdd6c0da96c2a3caf4b99898f2b14bda4539ce2ab",
    "fixtures/workspace/cases.json": "62ac57acf3e840235f7cd398b5acb72c77e5e5f9424055ee47339dfe29614f2d",
    "fixtures/product/good/AGENTS.md": "9824c6a809e32cae44aeb4ef1fcee9b3368d82aefd6df102ab70219c251d7858",
    "fixtures/product/good/workspace.yaml": "f0dbb6f4cc35e6486eae3d33baa4bc9e7d0e6c067e762bed7b66f36d1136decb",
    "fixtures/product/good/CLAUDE.md": "336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49",
    "fixtures/product/good/.gitignore": "c56a5fed03c9d4b83c95ea55298d3fe105fe3d073939780e845c16a756c5c52b",
    "fixtures/product/good/docs/vision.md": "d2ce80e408994df8fd76441d8054b58f7fd1585f73ccd9a8ef3fed6a4578bf9d",
    "fixtures/product/good/docs/hypotheses/H-001-owners-list-in-a-minute.md": "d5e4c854b4f774bf507648f07dc7b1eedb8a1b329353fc2ff4749949ddeeba3b",
    "fixtures/product/good/docs/prototypes/P-001-leftover-map.md": "76af449311f920ddd6b947a9a0e0b4c761256a5bb48c34b2ec014937a6bddd03",
    "fixtures/product/good/docs/questions/Q-001-who-collects-unclaimed.md": "b15cf4509d1cb0790a386f473291ecce255f533f6f88e72026b0aa47a3ffc85c",
    "fixtures/product/good/docs/questions/Q-002-delivery.md": "af5915ccc67d71129a74739a28c815080d098e5086068ad0b5fb86c0db7fee2c",
    "fixtures/product/good/docs/requirements/FR-001-list-in-a-minute.md": "3c7389706c1dba635b9f69352e11b64558873f47058bdbd4889a804f9658d2b5",
    "fixtures/product/good/docs/requirements/FR-002-listing-ends-at-closing.md": "2ffb8a5c69eab66494f53b7d1e19eb534b2de57720676244973233a610047194",
    "fixtures/product/good/docs/results/R-001-first-week.md": "e8bfd46e2ba275d5c3a30274f719b5d58c26e71920413edab02b47e18be03cf1",
    "fixtures/product/good/docs/sources/S-001-first-conversation.md": "06aed76de31c10dfc0e296dd830fec83207e96dedb41e72b1585d047bb52a744",
    "fixtures/product/good/docs/sources/S-002-market-report.md": "816ce8a6b6026a46f13a127c51f6ca6277e7bba10b8a7e1e1798acd177ee3f67",
    "fixtures/product/good/docs/stories/US-001-list-leftovers.md": "ff34e3bac7cc71b6b38f38db920220eabce83f8021edcb30f3c2b836d67242cf",
    "fixtures/product/good/docs/system/capabilities/listing.md": "dcc6dd5ce8ee215691971c5cd34b259652fe1982708079121519290a5348be92",
    "fixtures/product/good/docs/use-cases/UC-001-list-leftovers.md": "da5aced0618ea4fb752ec87cfd1f10411869fe8d551f4043086408978bbb886e",
    "fixtures/product/good/model/.gitkeep": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "fixtures/product/good/prototypes/leftover-map/index.html": "ccba02452b05a473d29b0fca05595666d94f4ebf448c2b9ab4bdee41cd7825a7",
    "fixtures/product/good/skills/.gitkeep": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
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

  test('the vendored folder holds exactly the pinned files and their hashes', () => {
    const files = walk(VENDOR).map((file) => file.slice(VENDOR.length)).sort();
    const expected = new Set([...Object.keys(PIN.hashes), 'product.d.mts']);
    expect([...files.filter((f) => !expected.has(f))]).toEqual([]);
    expect(Object.keys(PIN.hashes).filter((f) => !files.includes(f))).toEqual([]);
  });
});

/** Every file under a folder, deepest first, for the walk above. */
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
