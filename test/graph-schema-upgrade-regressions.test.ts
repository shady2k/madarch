import { expect, test } from 'bun:test';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { graphSchemaStamp, SCHEMA } from '../src/adapters/schemas/graph-definition.js';
import { assertionValueTableName } from '../src/graph/contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { createTestDatabaseOwner } from './test-database.js';

for (const shape of ['plain object', 'vertex getter', 'nested fields'] as const) {
  test(`a stamped ${shape} installs in-place additions`, async () => {
    const owner = await createTestDatabaseOwner({ authenticated: false });
    const fields: { name: string; type: 'text' }[] = [];
    const vertex = [{ name: 'fixture', table: 'unused', capability: 'fixture', key: [], fields }];
    const contract = shape === 'vertex getter'
      ? { get vertex() { return vertex; }, edge: [], dictionary: [] }
      : { vertex, edge: [], dictionary: [] };
    const added = { name: 'added', table: 'unused', capability: 'fixture', key: [], fields: [{ name: 'title', type: 'text' as const }] };
    try {
      await prepareGraphSchema(owner, contract);
      const before = graphSchemaStamp(contract);
      expect(() => {
        if (shape === 'nested fields') fields.push({ name: 'title', type: 'text' });
        else if (shape === 'vertex getter') vertex.push(added);
        else contract.vertex.push(added);
      }).not.toThrow();
      await prepareGraphSchema(owner, contract);
      const table = assertionValueTableName(shape === 'nested fields' ? 'fixture' : 'added', 'vertex', 'title');
      const held = await owner.run(tx => tx.query<{ held: string | null }>('SELECT to_regclass($1)::text AS held', [table]));
      expect(held.rows[0]?.held).toBe(table);
      expect(graphSchemaStamp(contract)).not.toBe(before);
      await expect(createOneGraphSchema(owner, contract)).resolves.toEqual({ reset: false });
    } finally { await owner.close(); }
  }, 60_000);
}

test('same-revision core statement changes are installed and preserve stored data', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const schema = SCHEMA as string[];
  const index = schema.findIndex(sql => sql.includes('FUNCTION graph_next_recorded_sequence()'));
  const original = schema[index]!;
  try {
    await prepareGraphSchema(owner);
    const before = await owner.run(async tx => await tx.query("SELECT * FROM context ORDER BY id"));
    schema[index] = original.replace('BEGIN', 'BEGIN /* core upgrade probe */');
    expect((await prepareGraphSchema(owner, { vertex: [], edge: [], dictionary: [] })).reset).toBe(false);
    const body = await owner.run(async tx => await tx.query<{ body: string }>("SELECT prosrc AS body FROM pg_proc WHERE oid='graph_next_recorded_sequence()'::regprocedure"));
    const installed = Number(body.rows[0]!.body.includes('core upgrade probe'));
    console.log('same-revision core changes installed', installed);
    expect(installed).toBe(1);
    const after = await owner.run(async tx => await tx.query("SELECT * FROM context ORDER BY id"));
    expect(after.rows).toEqual(before.rows);
  } finally { schema[index] = original; await owner.close(); }
}, 60_000);
