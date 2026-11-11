import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import type { GraphContract } from '../src/graph/contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { publishStoreOwner, requestHistoryPreparation, requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';

test('owner prepares pinned contracts and new source databases for attach-only roles', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-ipc-'));
  try {
    await withStorePreparationOwner(async () => {
      const store = join(folder, 'graph');
      await requestStorePreparation(store, GIT_CONTRACT);
      const unpublish = publishStoreOwner(folder);
      try {
        const env = { ...process.env };
        delete env.MADARCH_STORE_OWNER_URL;
        delete env.MADARCH_STORE_OWNER_TOKEN;
        const module = new URL('../src/product/store-preparation.ts', import.meta.url).pathname;
        const script = `import { withDaemonStorePreparation, requestStorePreparation } from ${JSON.stringify(module)}; await withDaemonStorePreparation(${JSON.stringify(folder)}, async () => await requestStorePreparation(${JSON.stringify(store)}));`;
        const invocation = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
        const stderr = await new Response(invocation.stderr).text();
        expect(await invocation.exited, stderr).toBe(0);
      } finally { unpublish(); }
      const previous = process.env.MADARCH_ROLE;
      process.env.MADARCH_ROLE = 'api';
      try {
        await expect(withStorePreparationOwner(async () => undefined)).rejects.toThrow('cannot own schema preparation');
        const client = await createDatabaseOwner({ store, connectOnly: true });
        try { await createOneGraphSchema(client, withManifestContract(GIT_CONTRACT)); } finally { await client.close(); }
        const changed: GraphContract = { vertex: [{ name: 'owner_added', table: 'owner_added_opinions', capability: 'test', fields: [{ name: 'label', type: 'text' }], key: ['label'] }], edge: [], dictionary: [] };
        await requestStorePreparation(store, changed);
        const changedClient = await createDatabaseOwner({ store, connectOnly: true });
        try { await createOneGraphSchema(changedClient, withManifestContract(changed)); } finally { await changedClient.close(); }
        await requestHistoryPreparation(store, 'h_added_source');
        const history = await createDatabaseOwner({ store, database: 'h_added_source', connectOnly: true });
        try {
          const held = await history.run(async (tx) => await tx.query("SELECT to_regclass('source_commits') AS relation"));
          expect(held.rows[0]?.relation).not.toBeNull();
        } finally { await history.close(); }
      } finally {
        if (previous === undefined) delete process.env.MADARCH_ROLE; else process.env.MADARCH_ROLE = previous;
      }
    });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 60_000);
