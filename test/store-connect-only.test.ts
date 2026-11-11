import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';

test('a connect-only client refuses an absent store without initializing a cluster', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-connect-only-'));
  const store = join(root, 'absent');
  try {
    await expect(createDatabaseOwner({ store, connectOnly: true })).rejects.toThrow(`store "${store}"`);
    await expect(createDatabaseOwner({ store, connectOnly: true })).rejects.toThrow('run madarch start');
    expect(existsSync(store)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
