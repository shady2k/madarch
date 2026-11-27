import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { assertionReadSql } from '../src/graph/assertion-read.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
const graph: GraphContract = { vertex: [{ name: 'plan-item', table: generatedTableName('plan-item', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' }], edge: [], dictionary: [] };
import { createTestDatabaseOwner } from './test-database.js';

type Plan = { 'Node Type': string; 'Alias'?: string; 'Rows Removed by Join Filter'?: number; Plans?: Plan[] };
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
for (const size of [100, 1000]) {
  test(`selection plan is linear and never loops over the raw CTE at ${size} raw rows`, async () => {
    const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
    try {
      await owner.transaction('write', async tx => {
        await bindTestWriteCapability(tx, graph);
        await publishGraphDrafts(tx, graph, { vertices: Array.from({ length: size }, (_, index) => ({ kind: 'plan-item', key: { name: `item-${index}` }, values: {}, producer: 'fixture', producerVersion: '1' })), removals: [] });
        const query = await assertionReadSql([{ sort: 'vertex', kind: 'plan-item', properties: ['$exists'] }], { validAt: '2027-01-01', recordedAt: '2027-01-01' });
        const count = await tx.query(`SELECT count(*)::integer AS count FROM (${query.sql}) counted`, query.parameters);
        expect(count.rows[0]!['count']).toBe(size);
        const result = await tx.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, query.parameters);
        const plan = result.rows[0]!['QUERY PLAN'];
        if (process.env['ALX831_PLAN_DIR']) {
          await mkdir(process.env['ALX831_PLAN_DIR'], { recursive: true });
          await writeFile(`${process.env['ALX831_PLAN_DIR']}/${process.env['ALX831_PLAN_LABEL'] ?? 'plan'}-${size}.json`, JSON.stringify(plan, null, 2));
        }
        const all = nodes(plan[0]!.Plan);
        const removed = all.reduce((sum, node) => sum + (node['Rows Removed by Join Filter'] ?? 0), 0);
        // A narrowed row is finished once, by index lookups keyed by its own assertion id (lineage, values and
        // repository targets after selection). What must never happen is a loop over the raw rows themselves:
        // that is the shape that grows with the history instead of with the answer (madarch-64o5.176).
        const loops = all.filter(node => node['Node Type'] === 'Nested Loop' && node.Plans?.some(child => child['Node Type'] === 'CTE Scan' && child['Alias'] === 'r')).length;
        console.log(JSON.stringify({ size, removed, nestedLoopsWithRawCteChild: loops }));
        expect({ removedWithinRawCount: removed <= size, nestedLoopsWithRawCteChild: loops }).toEqual({ removedWithinRawCount: true, nestedLoopsWithRawCteChild: 0 });
      });
    } finally { await owner.close(); }
  }, 60_000);
}
