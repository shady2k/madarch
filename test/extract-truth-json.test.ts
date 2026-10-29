/**
 * The audit writes its JSON in chunks instead of building one enormous string.
 * The chunking must not change a byte: unsupported and missing array elements
 * become `null`, exactly as `JSON.stringify` writes them (madarch-alzf review,
 * RARE: the audit serializer and `[undefined, 1]`).
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile, writeJsonValue } from '../scripts/extract-truth-json.js';

const value = {
  missing: [undefined, 1],
  sparse: [, 2],
  unsupported: [() => 1, Symbol('s'), 3],
  nested: { keep: 4, drop: undefined, list: [{ fn: () => 1, keep: 5 }] },
};

describe('the audit JSON writer', () => {
  test('writes unsupported and missing array elements as null, byte for byte as JSON.stringify', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-audit-json-'));
    try {
      const pretty = join(folder, 'pretty.json');
      writeJsonFile(pretty, value);
      expect(readFileSync(pretty, 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`);

      const compact = join(folder, 'compact.json');
      const fd = openSync(compact, 'w');
      try {
        writeJsonValue(fd, value, false);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(compact, 'utf8')).toBe(JSON.stringify(value));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
