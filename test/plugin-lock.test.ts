/**
 * The plugin lock (decision 0035, item 20): the exact version and closure hash a product runs, read from
 * `madarch/plugins.lock`; a lock that cannot be read is refused with the file and the line, never treated as no lock.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginLock } from '../src/plugin/lock.js';

const made: string[] = [];
afterAll(() => { for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** A product folder holding the lock text given; a test writes one lock, or none. */
function product(lock?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-plugin-lock-'));
  made.push(folder);
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  if (lock !== undefined) writeFileSync(join(folder, 'madarch', 'plugins.lock'), lock);
  return folder;
}

const HASH = 'a'.repeat(64);

describe('the plugin lock', () => {
  test('a product with no lock holds no plugin, which is not a refusal', () => {
    const read = readPluginLock(product());
    expect(read.ok).toBe(true);
    expect(read.ok && read.entries).toEqual([]);
    expect(read.ok && read.absent).toBe(true);
  });

  test('every plugin is read with its exact version, its closure and its folder', () => {
    const read = readPluginLock(product(`plugins:\n  - { id: zeta, version: 2.1.0, closure: ${HASH}, path: plugins/zeta }\n  - { id: alpha, version: 1.0.0, closure: ${'b'.repeat(64)}, path: plugins/alpha }\n`));
    expect(read.ok && read.entries.map((entry) => [entry.id, entry.version, entry.path])).toEqual([['alpha', '1.0.0', 'plugins/alpha'], ['zeta', '2.1.0', 'plugins/zeta']]);
    expect(read.ok && read.entries[0]?.line).toBe(3);
  });

  test('a version that is not semantic, a hash that is not a sha256, a folder that leaves the product and a plugin twice are each refused with the line', () => {
    const cases: [string, string][] = [
      ['plugins:\n  - { id: alpha, version: 1.0, closure: ' + HASH + ', path: plugins/alpha }\n', 'the exact semantic version'],
      ['plugins:\n  - { id: alpha, version: 1.0.0, closure: ABC, path: plugins/alpha }\n', "the closure's sha256"],
      ['plugins:\n  - { id: alpha, version: 1.0.0, closure: ' + HASH + ', path: ../alpha }\n', 'relative to the product repository'],
      ['plugins:\n  - { id: alpha, version: 1.0.0, closure: ' + HASH + ', path: plugins/alpha }\n  - { id: alpha, version: 1.0.0, closure: ' + HASH + ', path: plugins/alpha }\n', 'stands twice'],
      ['plugins:\n  - { id: alpha, version: 1.0.0, closure: ' + HASH + ', path: plugins/alpha, mood: yes }\n', 'is not a field of a plugin lock entry'],
      ['plugins: 7\n', 'is a list of'],
      ['something: 1\n', 'holds "plugins" and nothing else'],
    ];
    for (const [lock, message] of cases) {
      const read = readPluginLock(product(lock));
      expect(read.ok, message).toBe(false);
      if (!read.ok) {
        expect(read.file).toBe('madarch/plugins.lock');
        expect(read.line).toBeGreaterThan(0);
        expect(read.message).toContain(message);
      }
    }
  });
});
