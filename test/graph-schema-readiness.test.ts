import { expect, test } from 'bun:test';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { requireSchema } from '../src/adapters/store-readiness.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner } from './test-database.js';

const kind = { name: 'fixture', table: 'unused', capability: 'fixture', key: [] as string[], fields: [{ name: 'title', type: 'text' as const }] };
const contract: GraphContract = { vertex: [kind], edge: [], dictionary: [] };

for (const change of [
  { checks: ['length(title) > 0'] },
  { indexes: [{ name: 'fixture_title', columns: ['title'] }] },
]) {
  test(`preparation refuses changed ${'checks' in change ? 'checks' : 'indexes'} without publishing its stamp`, async () => {
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      const changed: GraphContract = { ...contract, vertex: [{ ...kind, ...change }] };
      await expect(prepareGraphSchema(owner, changed)).rejects.toThrow('require an explicit migration');
      await expect(createOneGraphSchema(owner, changed)).rejects.toThrow('has no prepared one-graph schema');
      await expect(createOneGraphSchema(owner, contract)).resolves.toEqual({ reset: false });
    } finally { await owner.close(); }
  });
}

test('a matching stamp cannot hide a missing graph table and the client does not repair it', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const table = generatedTableName(kind.name, 'vertex');
    await owner.exec(`DROP TABLE "${table}"`);
    await expect(createOneGraphSchema(owner, contract)).rejects.toThrow(`missing prepared graph tables ${table}`);
    const held = await owner.transaction('snapshot', (tx) => tx.query<{ held: string | null }>('SELECT to_regclass($1)::text AS held', [table]));
    expect(held.rows[0]?.held).toBeNull();
  } finally { await owner.close(); }
});

test('readiness refuses absent metadata and rereads changed stamps without repairing them', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const before = await owner.run((tx) => tx.query<{ stamp: string }>("SELECT stamp FROM madarch_meta.schema_stamp WHERE name = 'one-graph'"));
    const stamp = before.rows[0]!.stamp;
    await expect(requireSchema(owner, 'one-graph', stamp)).resolves.toBeUndefined();
    await owner.run((tx) => tx.query("UPDATE madarch_meta.schema_stamp SET stamp = 'changed' WHERE name = 'one-graph'"));
    await expect(requireSchema(owner, 'one-graph', stamp)).rejects.toThrow('has no prepared one-graph schema');
    await expect(requireSchema(owner, 'absent')).rejects.toThrow('has no prepared absent schema');
    await owner.exec('DROP TABLE madarch_meta.schema_stamp');
    await expect(requireSchema(owner, 'one-graph')).rejects.toThrow('has no prepared one-graph schema');
    const held = await owner.run((tx) => tx.query<{ held: string | null }>("SELECT to_regclass('madarch_meta.schema_stamp')::text AS held"));
    expect(held.rows[0]?.held).toBeNull();
  } finally { await owner.close(); }
});

test('readiness preserves a database failure other than missing metadata', async () => {
  const failure = Object.assign(new Error('database unavailable'), { code: '08006' });
  const owner = { transaction: async () => { throw failure; } };
  await expect(requireSchema(owner, 'one-graph')).rejects.toBe(failure);
});

