import { expect, test } from 'bun:test';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { SCHEMA } from '../src/adapters/schemas/graph-definition.js';
import type { GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner } from './test-database.js';

test('a stamped contract refuses a new kind instead of certifying missing storage', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  const vertex = [{ name: 'fixture', table: 'unused', capability: 'fixture', key: [], fields: [] }];
  const contract: GraphContract = { vertex, edge: [], dictionary: [] };
  try {
    await prepareGraphSchema(owner, contract);
    let refused = 0;
    try { vertex.push({ name: 'added', table: 'unused', capability: 'fixture', key: [], fields: [] }); }
    catch (error) { if (!(error instanceof TypeError)) throw error; refused++; }
    await prepareGraphSchema(owner, contract);
    console.log('obsolete stamp mutation refusals', refused);
    expect(refused).toBe(1);
  } finally { await owner.close(); }
}, 60_000);

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
