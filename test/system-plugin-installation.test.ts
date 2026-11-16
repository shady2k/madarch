import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStorePreparationOwner, requestStorePreparation } from '../src/product/store-preparation.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { readKindAssertions } from '../src/graph/records.js';
import { installDisputeSelection } from '../src/graph/disputes.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';

test('product preparation retains locked plugins before any fill starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-install-'));
  try {
    await withStorePreparationOwner(async () => {
      const store = join(root, 'graph');
      await requestStorePreparation(store, EMPTY_CONTRACT, [{ id: 'fixture-reader', version: '1.2.3' }]);
      const owner = await createDatabaseOwner({ store, connectOnly: true });
      try {
        const sources = await owner.transaction('snapshot', async (tx) => {
          await installDisputeSelection(tx, withManifestContract(EMPTY_CONTRACT));
          const now = (await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
          return await readKindAssertions(tx, 'vertex', 'plugin', ['installation', 'version', 'label', 'scope'], { validAt: now, recordedAt: now });
        });
        const installation = createHash('sha256').update(JSON.stringify(['plugin', 'fixture-reader', owner.location])).digest('hex');
        const locked = sources.filter((source) => source.values['installation'] === installation);
        expect(locked).toHaveLength(1);
        expect(locked[0]!.values).toEqual({ installation, version: '1.2.3', label: 'fixture-reader', scope: owner.location });
        const startup = sources.filter((source) => source.values['installation'] === JSON.stringify(['system-engine', 'system-installation']));
        expect(startup).toHaveLength(1);
        expect(sources).toHaveLength(locked.length + startup.length);
        expect(startup[0]!.uid).not.toBe(locked[0]!.uid);
      } finally { await owner.close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
