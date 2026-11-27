import { expect, test } from 'bun:test';
import { assertionValueTableName } from '../src/graph/contract.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { contract, edge, vertex } from './graph-relations-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

const tables = ['node', 'edge', 'entity', 'context', 'assertion', 'assertion_vertex_subject', 'assertion_edge_subject',
  ...contract.vertex.flatMap(kind => ['$exists', ...kind.fields.map(field => field.name)].map(property => assertionValueTableName(kind.name, 'vertex', property))),
  ...contract.edge.flatMap(kind => ['$exists', ...kind.fields.map(field => field.name)].map(property => assertionValueTableName(kind.name, 'edge', property)))];
type TableReads = Record<string, number>;
async function rowsRead(tx: SqlExecutor): Promise<TableReads> {
  const result = await tx.query<{ table: string; reads: string }>(`SELECT relname AS table,
    (seq_tup_read + idx_tup_fetch)::text AS reads FROM pg_stat_xact_user_tables
    WHERE schemaname='public' AND (relname=ANY($1::text[]) OR left(relname,2)='a_') ORDER BY relname COLLATE "C"`, [tables]);
  return Object.fromEntries(result.rows.map(row => [row.table, Number(row.reads)]));
}
async function measuredCheck(size: number, future: boolean, analyzed: boolean): Promise<TableReads> {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: Array.from({ length: size / 2 }, (_, n) => [vertex('parent', String(n)), vertex('child', String(n))]).flat(),
      edges: Array.from({ length: size / 2 }, (_, n) => edge(String(n))), removals: [],
    }));
    if (analyzed) await owner.exec('ANALYZE');
    return await owner.transaction('write', async tx => {
      await tx.query('SET LOCAL enable_seqscan=off');
      await tx.query('DISCARD PLANS');
      const interval = future ? { validTo: new Date(Date.now() + 60_000).toISOString() } : { validFrom: '0001-01-01T00:00:00.000Z' };
      const subject = await tx.query<{ id: string }>("SELECT n.id::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='delta-parent' AND n.key=' {\"name\":\"0\"}'::jsonb");
      await writeAssertion(tx, contract, { sort: 'vertex', kind: 'delta-parent', subjectId: subject.rows[0]!.id,
        property: '$exists', operation: 'assert', value: true, ...interval });
      const before = await rowsRead(tx);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      const after = await rowsRead(tx);
      return Object.fromEntries(Object.entries(after).map(([table, reads]) => [table, reads - before[table]!]));
    });
  } finally { await owner.close(); }
}
for (const analyzed of [false, true]) for (const future of [false, true]) {
  test(`delta relation check reads equal rows per table in S50 and S500 analyzed=${analyzed} future=${future}`, async () => {
    const [small, large] = await Promise.all([measuredCheck(50, future, analyzed), measuredCheck(500, future, analyzed)]);
    expect(Object.values(small).reduce((sum, reads) => sum + reads, 0)).toBeGreaterThan(0);
    expect(large).toEqual(small);
  }, 120_000);
}
