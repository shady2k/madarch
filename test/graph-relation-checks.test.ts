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
      for (const sort of ['vertex', 'edge']) {
        await tx.query(`ALTER FUNCTION graph_${sort}_active_ids(text,bigint,bigint,timestamptz,bigint) RENAME TO graph_${sort}_active_ids_uncounted`);
        await tx.query(`CREATE FUNCTION graph_${sort}_active_ids(kind text,ctx bigint,wanted_subject bigint DEFAULT NULL,instant timestamptz DEFAULT transaction_timestamp(),source_kind_id bigint DEFAULT NULL)
          RETURNS SETOF bigint LANGUAGE plpgsql AS $$ DECLARE calls jsonb; call_key text; BEGIN
          calls := coalesce(nullif(current_setting('madarch.relation_active_calls',true),'')::jsonb,'{}'::jsonb);
          call_key := '${sort}' || ':' || kind || ':' || ctx || ':' || wanted_subject || ':' || instant;
          PERFORM set_config('madarch.relation_active_calls',
            (calls || jsonb_build_object(call_key,coalesce((calls->>call_key)::integer,0)+1))::text,true);
          RETURN QUERY SELECT * FROM graph_${sort}_active_ids_uncounted(kind,ctx,wanted_subject,instant,source_kind_id);
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
