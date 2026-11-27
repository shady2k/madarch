import { expect, test } from 'bun:test';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

const graph: GraphContract = {
  vertex: ['relation-from', 'relation-to'].map(name => ({ name, table: generatedTableName(name, 'vertex'),
    key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' })),
  edge: ['required-link', 'other-link'].map(name => ({ name, from: ['relation-from'], to: ['relation-to'],
    fields: [], repeats: false, capability: 'fixture', cardinality: { from: 'many', to: name === 'required-link' ? 'one' : 'many' },
    labels: { en: { out: 'target', in: 'source' }, ru: { out: 'target', in: 'source' } } })), dictionary: [],
};
const from = { kind: 'relation-from', key: { name: 'from' } };
const to = { kind: 'relation-to', key: { name: 'to' } };
const vertices = [from, to].map(ref => ({ ...ref, producer: 'fixture', producerVersion: '1' }));
const link = (kind: string) => ({ kind, from, to, producer: 'fixture', producerVersion: '1' });

test('relation checks compute each checked subject and instant active set only once', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, graph, { vertices, edges: [link('required-link'), link('other-link')], removals: [] });
      const wrapped = [
        { sort: 'vertex', suffix: '_batch', subjectType: 'bigint[]' },
        { sort: 'edge', suffix: '_batch', subjectType: 'bigint[]' },
        { sort: 'edge', suffix: '', subjectType: 'bigint' },
      ] as const;
      for (const { sort, suffix, subjectType } of wrapped) {
        await tx.query(`ALTER FUNCTION graph_${sort}_active_ids${suffix}(text,bigint,${subjectType},timestamptz,bigint) RENAME TO graph_${sort}_active_ids${suffix}_uncounted`);
        await tx.query(`CREATE FUNCTION graph_${sort}_active_ids${suffix}(kind text,ctx bigint,wanted_subject ${subjectType} DEFAULT NULL,instant timestamptz DEFAULT transaction_timestamp(),source_kind_id bigint DEFAULT NULL)
          RETURNS SETOF bigint LANGUAGE plpgsql AS $$ DECLARE calls jsonb; call_key text; BEGIN
          calls := coalesce(nullif(current_setting('madarch.relation_active_calls',true),'')::jsonb,'{}'::jsonb);
          call_key := '${sort}' || ':' || kind || ':' || ctx || ':' || wanted_subject::text || ':' || instant;
          PERFORM set_config('madarch.relation_active_calls',
            (calls || jsonb_build_object(call_key,coalesce((calls->>call_key)::integer,0)+1))::text,true);
          RETURN QUERY SELECT * FROM graph_${sort}_active_ids${suffix}_uncounted(kind,ctx,wanted_subject,instant,source_kind_id);
          END $$`);
      }
      await tx.query(`SELECT set_config('madarch.checked_graph_revision','',true)`);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      const calls = await tx.query<{ calls: Record<string, number> }>(`SELECT current_setting('madarch.relation_active_calls')::jsonb AS calls`);
      expect(Object.values(calls.rows[0]!.calls).every(count => count === 1)).toBe(true);
      for (const [sort, kind] of [['edge', 'other-link'], ['edge', 'required-link'],
        ['vertex', 'relation-from'], ['vertex', 'relation-to']]) {
        expect(Object.keys(calls.rows[0]!.calls).some(key => key.startsWith(`${sort}:${kind}:1:`))).toBe(true);
      }
    });
  } finally { await owner.close(); }
}, 60_000);

test('another relation cannot satisfy required cardinality or inflate its count on shared endpoints', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph });
  try {
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, graph, {
      vertices, removals: [],
    }))).rejects.toThrow('CARDINALITY_INVALID for required-link');
    await expect(owner.transaction('write', tx => publishGraphDrafts(tx, graph, {
      vertices, edges: [link('other-link')], removals: [],
    }))).rejects.toThrow('CARDINALITY_INVALID for required-link');
    await owner.transaction('write', tx => publishGraphDrafts(tx, graph, {
      vertices, edges: [link('required-link'), link('other-link')], removals: [],
    }));
  } finally { await owner.close(); }
}, 60_000);

const temporalGraph: GraphContract = {
  ...graph,
  edge: graph.edge.map(kind => ({ ...kind, cardinality: { from: 'many', to: 'many' } })),
};

for (const sort of ['vertex', 'edge'] as const) {
  const kind = sort === 'vertex' ? 'relation-from' : 'other-link';
  const table = sort === 'vertex' ? 'node' : 'edge';
  test(`ALX181 ${sort} scalar and whole-kind agree after expiry in a long transaction`, async () => {
    const owner = await createTestDatabaseOwner({ graphContract: temporalGraph });
    try {
      await owner.transaction('write', async tx => {
        const end = await tx.query<{ at: string }>("SELECT (clock_timestamp()+interval '2 seconds')::text AS at");
        await publishGraphDrafts(tx, temporalGraph, {
          vertices: vertices.map(vertex => ({ ...vertex, validTo: end.rows[0]!.at })),
          edges: [{ ...link('other-link'), validTo: end.rows[0]!.at }], removals: [],
        });
        const subject = await tx.query<{ id: string }>(`SELECT s.id::text FROM ${table} s JOIN entity k ON k.id=s.entity_id WHERE k.name=$1`, [kind]);
        const id = subject.rows[0]!.id;
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.query("SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)", [end.rows[0]!.at]);
        const result = await tx.query<{ scalar: boolean; whole: boolean }>(`SELECT
          graph_${sort}_active($1::bigint,$2,1) AS scalar,
          EXISTS(SELECT 1 FROM graph_${sort}_active_ids($2,1) id WHERE id=$1::bigint) AS whole`, [id, kind]);
        expect(result.rows).toEqual([{ scalar: false, whole: false }]);
      });
    } finally { await owner.close(); }
  }, 30_000);

  test(`ALX181 ${sort} bounded and whole-kind agree at a sub-millisecond valid_to`, async () => {
    const owner = await createTestDatabaseOwner({ graphContract: temporalGraph });
    try {
      await owner.transaction('write', tx => publishGraphDrafts(tx, temporalGraph, {
        vertices: vertices.map(vertex => ({ ...vertex, validFrom: '2000-01-01T00:00:00Z',
          ...(sort === 'vertex' ? { validTo: '2001-01-01T00:00:00.000500Z' } : {}) })),
        edges: sort === 'edge' ? [{ ...link('other-link'), validFrom: '2000-01-01T00:00:00Z', validTo: '2001-01-01T00:00:00.000500Z' }] : [], removals: [],
      }));
      const result = await owner.run(tx => tx.query<{ bounded: string[]; whole: string[] }>(`SELECT
        ARRAY(SELECT id::text FROM graph_${sort}_active_ids($1,1,s.id,'2001-01-01T00:00:00.000Z') id ORDER BY id) AS bounded,
        ARRAY(SELECT id::text FROM graph_${sort}_active_ids($1,1,NULL,'2001-01-01T00:00:00.000Z') id ORDER BY id) AS whole
        FROM ${table} s JOIN entity k ON k.id=s.entity_id WHERE k.name=$1`, [kind]));
      expect(result.rows).toEqual([{ bounded: [], whole: [] }]);
    } finally { await owner.close(); }
  }, 30_000);

  test(`ALX181 ${sort} active ids agree with omitted and explicit source kind`, async () => {
    const owner = await createTestDatabaseOwner({ graphContract: temporalGraph });
    try {
      await owner.transaction('write', tx => publishGraphDrafts(tx, temporalGraph, {
        vertices, edges: [link('other-link')], removals: [],
      }));
      const result = await owner.run(tx => tx.query<{ omitted: string[]; explicit: string[]; subject: string }>(`SELECT
        s.id::text AS subject,
        ARRAY(SELECT id::text FROM graph_${sort}_active_ids($1,1,s.id) id ORDER BY id) AS omitted,
        ARRAY(SELECT id::text FROM graph_${sort}_active_ids($1,1,s.id,clock_timestamp(),
          (SELECT id FROM entity WHERE name='system.assertion-source')) id ORDER BY id) AS explicit
        FROM ${table} s JOIN entity k ON k.id=s.entity_id WHERE k.name=$1`, [kind]));
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.omitted).toEqual([result.rows[0]!.subject]);
      expect(result.rows[0]!.explicit).toEqual(result.rows[0]!.omitted);
    } finally { await owner.close(); }
  }, 30_000);
}
