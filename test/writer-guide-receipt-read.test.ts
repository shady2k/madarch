import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuideReceipts } from '../src/writer/guides/receipt-read.js';

describe('durable guide receipt input', () => {
  test('keeps strict JSON fields and actual parser locations without granting trust', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guide-receipt-read-'));
    try {
      const folder = join(root, 'docs', 'guide-walks', 'administrator-guide'); mkdirSync(folder, { recursive: true });
      const file = join(folder, 'one.json');
      writeFileSync(file, `{
  "observed": "ready",
  "actualStatus": 0
}
`);
      const result = await readGuideReceipts(root, 'administrator-guide');
      expect(result.diagnostics).toEqual([]);
      expect(result.receipts).toEqual([{ observed: 'ready', actualStatus: 0 }]);
      expect(result.locations[0]?.file).toBe(file);
      expect(result.locations[0]?.lineAt(['actualStatus'])).toBe(3);
      writeFileSync(file, `{
 "observed": "a",
 "observed": "b"
}
`);
      const duplicate = await readGuideReceipts(root, 'administrator-guide');
      expect(duplicate.receipts).toEqual([]);
      expect(duplicate.diagnostics[0]?.line).toBe(3);
      expect(duplicate.diagnostics[0]?.message).toContain(file);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('never shortens a bad set or follows a linked receipt folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guide-receipt-bound-'));
    try {
      const folder = join(root, 'docs', 'guide-walks', 'user-guide'); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'valid.json'), '{}\n');
      writeFileSync(join(folder, 'bad.txt'), 'not a receipt');
      const result = await readGuideReceipts(root, 'user-guide');
      expect(result.receipts).toEqual([]);
      expect(result.diagnostics.map((d) => d.code)).toContain('receipt-format');
      rmSync(folder, { recursive: true });
      const outside = join(root, 'outside'); mkdirSync(outside);
      symlinkSync(outside, folder);
      const linked = await readGuideReceipts(root, 'user-guide');
      expect(linked.receipts).toEqual([]);
      expect(linked.diagnostics.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
