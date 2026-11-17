import { expect, test } from 'bun:test';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const contract: GraphContract = {
  vertex: ['delta-child', 'delta-parent', 'delta-note'].map(name => ({ name,
    table: generatedTableName(name, 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }], capability: 'fixture' })),
  edge: [{ name: 'delta-parent-link', from: ['delta-child'], to: ['delta-parent'],
    fields: [{ name: 'weight', type: 'integer' }], repeats: false, capability: 'fixture',
    cardinality: { from: 'many', to: 'one' },
    labels: { en: { out: 'parent', in: 'child' }, ru: { out: 'parent', in: 'child' } } }], dictionary: [],
};
const producer = { producer: 'fixture', producerVersion: '1' };
const ref = (kind: string, name = '0') => ({ kind: `delta-${kind}`, key: { name } });
const vertex = (kind: string, name = '0', interval: { validFrom?: string; validTo?: string } = {}) =>
  ({ ...ref(kind, name), ...producer, ...interval });
const edge = (name = '0', interval: { validFrom?: string; validTo?: string } = {}, weight = 1) =>
  ({ kind: 'delta-parent-link', from: ref('child', name), to: ref('parent', name), values: { weight }, ...producer, ...interval });
const pair = (name = '0', interval: { validFrom?: string; validTo?: string } = {}) =>
  ({ vertices: [vertex('parent', name, interval), vertex('child', name, interval)], edges: [edge(name, interval)], removals: [] });
const tables = ['node', 'edge', 'entity', 'context', 'assertion', 'assertion_vertex_subject', 'assertion_edge_subject',
  ...contract.vertex.flatMap(kind => ['$exists', ...kind.fields.map(field => field.name)].map(property => assertionValueTableName(kind.name, 'vertex', property))),
  ...contract.edge.flatMap(kind => ['$exists', ...kind.fields.map(field => field.name)].map(property => assertionValueTableName(kind.name, 'edge', property)))];
async function rowsRead(tx: SqlExecutor): Promise<number> {
  const result = await tx.query<{ reads: string }>(`SELECT coalesce(sum(seq_tup_read + idx_tup_fetch),0)::text AS reads
    FROM pg_stat_xact_user_tables WHERE schemaname='public' AND (relname=ANY($1::text[]) OR left(relname,2)='a_')`, [tables]);
  return Number(result.rows[0]!.reads);
}
async function measuredCheck(size: number, future: boolean): Promise<number> {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: Array.from({ length: size / 2 }, (_, n) => [vertex('parent', String(n)), vertex('child', String(n))]).flat(),
      edges: Array.from({ length: size / 2 }, (_, n) => edge(String(n))), removals: [],
    }));
    return await owner.transaction('write', async tx => {
      await tx.query('SET LOCAL enable_seqscan=off');
      const interval = future ? { validTo: new Date(Date.now() + 60_000).toISOString() } : {};
      await publishGraphDrafts(tx, contract, { vertices: [], edges: [edge('0', interval, 2)], removals: [] });
      const before = await rowsRead(tx);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      return (await rowsRead(tx)) - before;
    });
  } finally { await owner.close(); }
}
for (const future of [false, true]) {
  test(`delta relation check reads equal rows in S50 and S500${future ? ' with a future boundary' : ''}`, async () => {
    const small = await measuredCheck(50, future);
    const large = await measuredCheck(500, future);
    console.log(`DELTA_ROWS future=${future} S50=${small} S500=${large}`);
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  }, 120_000);
}

test('delta refuses a retired vertex with an active incident edge', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, pair()));
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [{ ...ref('parent'), producer: 'fixture', selectedFields: ['$exists'] }],
    }))).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('delta refuses retirement of the last required edge', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, pair()));
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [], edgeRemovals: [{ ...edge(), producer: 'fixture' }],
    }))).rejects.toThrow('CARDINALITY_INVALID');
  } finally { await owner.close(); }
}, 30_000);

test('delta refuses a new child without its required edge', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('child')], removals: [],
    }))).rejects.toThrow('CARDINALITY_INVALID');
  } finally { await owner.close(); }
}, 30_000);

test('delta parent-layer change checks an unpinned descendant', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [vertex('parent')], removals: [] }));
    const child = await owner.transaction('write', async tx => {
      const result = await tx.query<{ id: string }>("INSERT INTO context(parent,ref) VALUES(1,'delta-descendant') RETURNING id::text");
      return Number(result.rows[0]!.id);
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, TEST_SOURCE_UID, child);
      await publishGraphDrafts(tx, contract, { vertices: [vertex('child')], edges: [edge()], removals: [] }, child);
    });
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [], removals: [{ ...ref('parent'), producer: 'fixture', selectedFields: ['$exists'] }],
    }))).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('ALX107 refuses a future endpoint expiry under an open required edge', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const boundary = new Date(Date.now() + 60_000).toISOString();
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('parent', '0', { validTo: boundary }), vertex('child')], edges: [edge()], removals: [],
    }))).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('ALX107 admits matched future vertex and edge ends and an unrelated write after expiry', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    let boundary = 0;
    await owner.transaction('write', async tx => {
      boundary = Date.now() + 200;
      await publishGraphDrafts(tx, contract, pair('0', { validTo: new Date(boundary).toISOString() }));
    });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, boundary - Date.now()) + 20));
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [vertex('note')], removals: [] }));
    const active = await owner.run(tx => tx.query<{ active: boolean }>("SELECT graph_edge_active(e.id,'delta-parent-link',1) AS active FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='delta-parent-link'"));
    expect(active.rows).toEqual([{ active: false }]);
  } finally { await owner.close(); }
}, 30_000);

test('ALX107 refuses a historical edge outside its endpoint interval', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const start = '2000-01-01T00:00:00.000Z';
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, pair('0', { validFrom: start })));
    await expect(owner.transaction('write', async tx => {
      const result = await tx.query<{ id: string }>("SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='delta-parent-link'");
      await writeAssertion(tx, contract, { sort: 'edge', kind: 'delta-parent-link', subjectId: result.rows[0]!.id,
        property: '$exists', operation: 'assert', value: true,
        validFrom: '1999-01-01T00:00:00.000Z', validTo: start });
    })).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('generated delta relation check never selects an entire active kind', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const result = await owner.run(tx => tx.query<{ body: string }>("SELECT prosrc AS body FROM pg_proc WHERE oid='graph_relations_check()'::regprocedure"));
    const calls = [...result.rows[0]!.body.matchAll(/graph_(?:vertex|edge)_active_ids\(([^()]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[1]!.split(',').length).toBeGreaterThanOrEqual(3);
  } finally { await owner.close(); }
}, 30_000);


test('delta checks new changes after an earlier immediate barrier in the same transaction', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await expect(owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, contract, pair());
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      await tx.query('SET CONSTRAINTS ALL DEFERRED');
      await publishGraphDrafts(tx, contract, { vertices: [],
        removals: [{ ...ref('parent'), producer: 'fixture', selectedFields: ['$exists'] }] });
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    })).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('ALX107 checks an endpoint boundary inside the changed edge interval', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('parent', '0', { validFrom: '2000-01-01T00:00:00.000Z', validTo: '2001-01-01T00:00:00.000Z' })], removals: [],
    }));
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('parent', '0', { validFrom: '2002-01-01T00:00:00.000Z' })], removals: [],
    }));
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [vertex('child', '0', { validFrom: '2000-01-01T00:00:00.000Z' })],
      edges: [edge('0', { validFrom: '2000-01-01T00:00:00.000Z' })], removals: [],
    }))).rejects.toThrow('TARGET_MISSING');
  } finally { await owner.close(); }
}, 30_000);

test('ALX107 default assertions of a create share the transaction acceptance instant', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, contract, pair());
      const result = await tx.query<{ starts: number; transaction_start: boolean }>(`SELECT count(DISTINCT a.valid_from)::integer AS starts,
        bool_and(a.valid_from=transaction_timestamp()) AS transaction_start FROM assertion a
        LEFT JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id
        LEFT JOIN edge attachment ON attachment.id=av.subject_edge_id
        LEFT JOIN node n ON n.id=attachment.to_node
        LEFT JOIN assertion_edge_subject ae ON ae.assertion_id=a.assertion_id
        LEFT JOIN edge e ON e.id=ae.edge_id
        JOIN entity k ON k.id=coalesce(n.entity_id,e.entity_id)
        WHERE k.name IN ('delta-child','delta-parent','delta-parent-link')`);
      expect(result.rows).toEqual([{ starts: 1, transaction_start: true }]);
    });
  } finally { await owner.close(); }
}, 30_000);
