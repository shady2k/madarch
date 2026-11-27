import { expect, test } from 'bun:test';
import type { GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { contract, producer, ref, vertex, edge, pair } from './graph-relations-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

async function graphRowsRead(tx: SqlExecutor): Promise<number> {
  const { rows } = await tx.query<{ reads: number }>(`SELECT coalesce(sum(seq_tup_read + idx_tup_fetch),0)::integer AS reads
    FROM pg_stat_xact_user_tables WHERE schemaname='public'`);
  return rows[0]!.reads;
}

test('one changed edge reads the same rows and instants as its unbounded hub grows', async () => {
  const declared: GraphContract = {
    ...contract,
    edge: [...contract.edge, {
      ...contract.edge[0]!, name: 'delta-peer-link', cardinality: { from: 'many', to: 'many' },
    }],
  };
  const measured = [];
  for (const peers of [1, 25]) {
    const owner = await createTestDatabaseOwner({ graphContract: declared });
    try {
      const standing = pair('0', { validFrom: '1999-01-01T00:00:00Z' });
      // Each sibling adds a boundary inside the interval checked below.
      const siblings = Array.from({ length: peers }, (_, i) => {
        const name = `peer-${i}`;
        const interval = { validFrom: `20${String(i + 1).padStart(2, '0')}-01-01T00:00:00Z` };
        return { child: vertex('child', name, interval), link: { ...edge(name, interval), to: ref('parent') } };
      });
      await owner.transaction('write', tx => publishGraphDrafts(tx, declared, {
        vertices: [...standing.vertices, ...siblings.map(sibling => sibling.child)],
        edges: [...standing.edges, ...siblings.flatMap(({ link }) => [link, { ...link, kind: 'delta-peer-link' }])],
        removals: [],
      }));
      measured.push(await owner.transaction('write', async tx => {
        await tx.query('SET LOCAL enable_seqscan=off');
        await tx.query('DISCARD PLANS');
        await tx.query("SET LOCAL track_functions='pl'");
        const subject = await tx.query<{ id: string }>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id
          JOIN node n ON n.id=e.from_node WHERE k.name='delta-parent-link' AND n.key='{"name":"0"}'::jsonb`);
        await writeAssertion(tx, declared, { sort: 'edge', kind: 'delta-parent-link', subjectId: subject.rows[0]!.id,
          property: '$exists', operation: 'assert', value: true,
          validFrom: '2000-01-01T00:00:00Z', validTo: '2026-01-01T00:00:00Z' });
        const before = await graphRowsRead(tx);
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        const after = await graphRowsRead(tx);
        const { rows } = await tx.query<{ instants: number }>(`SELECT coalesce(sum(calls),0)::integer AS instants
          FROM pg_stat_xact_user_functions WHERE funcname='graph_relation_violation'`);
        return { instants: rows[0]!.instants, reads: after - before };
      }));
    } finally { await owner.close(); }
  }
  console.log('HUB_CHECK', JSON.stringify(measured));
  expect(measured[0]!.instants).toBeGreaterThan(0);
  expect(measured[0]!.reads).toBeGreaterThan(0);
  expect(measured[1]).toEqual(measured[0]!);
}, 30_000);

test('delta refuses overlapping edges at bounded from and to vertices', async () => {
  const sides = ['from', 'to'] as const;
  const declared: GraphContract = {
    ...contract,
    edge: sides.map(side => ({
      ...contract.edge[0]!, name: `delta-${side}-link`,
      cardinality: side === 'from' ? { from: 'many', to: 'optional' } : { from: 'optional', to: 'many' },
    })),
  };
  const owner = await createTestDatabaseOwner({ graphContract: declared });
  try {
    const first = edge('0', { validFrom: '2000-01-01T00:00:00Z', validTo: '2002-01-01T00:00:00Z' });
    await owner.transaction('write', tx => publishGraphDrafts(tx, declared, {
      vertices: [ref('parent'), ref('parent', '1'), ref('child'), ref('child', '1')].map(subject => ({
        ...subject, ...producer, validFrom: '1999-01-01T00:00:00Z',
      })),
      edges: declared.edge.map(({ name }) => ({ ...first, kind: name })), removals: [],
    }));
    for (const side of sides) {
      const kind = `delta-${side}-link`;
      const add = (validFrom: string) => owner.transaction('write', tx => publishGraphDrafts(tx, declared, {
        vertices: [], edges: [{
          ...first, kind, from: ref('child', side === 'from' ? '0' : '1'), to: ref('parent', side === 'to' ? '0' : '1'),
          validFrom, validTo: '2003-01-01T00:00:00Z',
        }], removals: [],
      }));
      await expect(add('2001-01-01T00:00:00Z')).rejects.toThrow(`CARDINALITY_INVALID for ${kind}`);
      await add('2002-01-01T00:00:00Z');
    }
  } finally { await owner.close(); }
}, 30_000);
