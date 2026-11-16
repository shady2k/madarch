import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStorePreparationOwner, requestStorePreparation } from '../src/product/store-preparation.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { generatedTableName } from '../src/graph/contract.js';

test('product preparation retains locked plugins before any fill starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-install-'));
  try {
    await withStorePreparationOwner(async () => {
      const store = join(root, 'graph');
      await requestStorePreparation(store, EMPTY_CONTRACT, [{ id: 'fixture-reader', version: '1.2.3' }]);
      const owner = await createDatabaseOwner({ store, connectOnly: true });
      try {
        const sources = await owner.transaction('snapshot', async (tx) => await tx.query<{ version: string; label: string }>(`SELECT p.version, p.label FROM "${generatedTableName('plugin', 'vertex')}" p WHERE p.state = 'open'`));
        expect(sources.rows).toEqual([{ version: '1.2.3', label: 'fixture-reader' }]);
      } finally { await owner.close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
