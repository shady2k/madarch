/** A trusted temporary-base alias must not weaken the disposable graph's symlink boundary. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createBuildScratch } from '../scripts/build-binary.js';
import { extractorManifest, prepareExtractorStore } from '../src/knowledge/extractor-store.js';

const manifest = extractorManifest([{ name: 'fixture', version: 1 }]);
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

/** Hold both sides of every link in one fixture; no machine-specific path is trusted by the test. */
function scratchFixture(): { root: string; base: string; alias: string; stage: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madarch-build-paths-')));
  try {
    const base = join(root, 'temporary-base');
    const alias = join(root, 'temporary-alias');
    mkdirSync(base);
    symlinkSync(base, alias, directoryLink);
    return { root, base, alias, stage: createBuildScratch(alias) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('build scratch canonicalizes a linked temporary base before the graph store sees derived paths', () => {
  const { root, base, alias, stage } = scratchFixture();
  try {
    expect(dirname(stage)).toBe(base);
    expect(realpathSync(stage)).toBe(stage);
    const derived = join('home', 'products', '.madarch', 'knowledge', 'fixture', 'graph');
    // The spelling returned through the base alias reproduces the macOS /var -> /private/var refusal.
    expect(() => prepareExtractorStore(join(alias, basename(stage), derived), manifest)).toThrow('derived parent is a symbolic link');
    const graph = join(stage, derived);
    const prepared = prepareExtractorStore(graph, manifest);
    expect(prepared.rebuilt).toBe(true);
    writeFileSync(join(prepared.path, 'payload'), 'owned graph');
    prepared.commit();
    expect(readFileSync(join(graph, 'payload'), 'utf8')).toBe('owned graph');
    expect(prepareExtractorStore(graph, manifest).rebuilt).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['parent', 'graph', 'graph.rebuild', 'graph.previous'])(
  'canonical build scratch still refuses an attacker link at derived %s',
  (location) => {
    const { root, stage } = scratchFixture();
    try {
      const outside = join(root, 'attacker-target');
      mkdirSync(outside);
      const sentinel = join(outside, 'payload');
      writeFileSync(sentinel, 'must stay exact');
      const parent = join(stage, 'derived');
      if (location === 'parent') symlinkSync(outside, parent, directoryLink);
      else {
        mkdirSync(parent);
        symlinkSync(outside, join(parent, location), directoryLink);
      }
      expect(() => prepareExtractorStore(join(parent, 'graph'), manifest)).toThrow(
        location === 'parent' ? 'derived parent is a symbolic link' : 'derived path is a symbolic link',
      );
      expect(readFileSync(sentinel, 'utf8')).toBe('must stay exact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
