import { expect, test } from 'bun:test';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import { contract, ref, vertex, edge, pair } from './graph-relations-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

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
    const result = await owner.run(tx => tx.query<{ body: string }>(`SELECT string_agg(prosrc,E'\n') AS body FROM pg_proc WHERE oid IN (
      'graph_checks_pass()'::regprocedure,
      'graph_relation_violation(bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],text[],text[],bigint,boolean,timestamptz,jsonb)'::regprocedure)`));
    const calls = [...result.rows[0]!.body.matchAll(/graph_(?:vertex|edge)_active_ids(?:_batch)?\(([^()]*)\)/g)];
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
        bool_and(a.valid_from=date_trunc('milliseconds',transaction_timestamp())) AS transaction_start FROM assertion a
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
