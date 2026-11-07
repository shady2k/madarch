/**
 * The graph's statistics (madarch-8bdc.2.5, item 2): `statistics.ts` keeps
 * `pg_statistic` current for the two version tables while a fill publishes.
 *
 * These cases state the rule and its facts: a publication counts the versions it
 * wrote and, when the store owns the transaction, refreshes the statistics the
 * publication made stale; a table that holds rows and was never analyzed is due
 * whatever the count (the state a resumed store opens in); else a refresh is due
 * once the versions written since the last one reach the bound; and a read
 * answers the same rows — the same recorded membership — before, during and
 * after a refresh.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { ANALYZE_STATISTICS_SQL, STATISTICS_ROWS, STATISTICS_TABLES } from '../src/graph/statistics.js';
import { readMembership } from '../src/fill/orchestrator-store.js';
import { ensureGraphSchema, staticUnitPublicationOf } from '../src/fill/stages/static-graph.js';

const REPOSITORY = 'shop';
const FILE = 'src/stats.ts';

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

/** One unit's publication: `nodes` nodes and the first `edges` of them joined from the first. */
async function publish(target: GraphStore, nodes: number, edges: number, file = FILE): Promise<void> {
  const items = Array.from({ length: nodes }, (_, index) => ({
    key: `code.callable:${REPOSITORY}:${file}@${String(index)}:${String(index + 1)}:identifier`,
    kind: 'code.callable',
    label: 'callable',
    properties: { recordKey: `code.callable:${REPOSITORY}:${file}@${String(index)}:${String(index + 1)}:identifier`, factKind: 'callable', repository: REPOSITORY, file },
  }));
  await target.publishUnit(staticUnitPublicationOf({
    unitId: `file:${REPOSITORY}:${file}`,
    stageId: 'code-facts',
    digest: 'e'.repeat(64),
    writes: [
      ...items.map((item) => ({ kind: 'node' as const, evidence: `file:${REPOSITORY}:${file}`, value: item })),
      ...items.slice(1, edges + 1).map((item) => ({ kind: 'edge' as const, evidence: `file:${REPOSITORY}:${file}`, value: { relation: 'code.references', from: { key: items[0]!.key }, to: { key: item.key }, properties: { factKind: 'reference', repository: REPOSITORY } } })),
    ],
  }));
}

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await ensureGraphSchema(store);
}, 300_000);

afterAll(async () => {
  await owner?.close();
}, 300_000);

describe('the rule the fill keeps the statistics by', () => {
  test('a publication counts the versions it wrote, and a store that owns the transaction refreshes for a never-analyzed table', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const created = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const fresh = createGraphStore(created);
      await ensureGraphSchema(fresh);
      // A table that holds rows and was never analyzed is due at once, whatever was written since.
      expect(fresh.statistics.written).toBe(0);
      const never = await fresh.refreshStatistics();
      expect(never).not.toBeNull();
      expect(never!.neverAnalyzed).toBe(true);
      expect(never!.written).toBe(0);
      expect(never!.tables).toEqual([...STATISTICS_TABLES]);
      expect(String(STATISTICS_TABLES)).toBe('edge_version,node_version');
      // A store that owns the publication's transaction refreshes it there: nothing is due afterwards.
      await publish(fresh, 3, 2);
      expect(fresh.statistics.written).toBe(5);
      expect(await fresh.refreshStatistics()).toBeNull();
    } finally {
      await created.close();
    }
  }, 600_000);

  test('the versions written since the last refresh reaching the bound make one due', async () => {
    if (store === undefined || owner === undefined) throw new Error('the store was not opened');
    // This store's tables were never analyzed, so the first refresh is due whatever the count; that case is
    // the one above, and here the bound alone decides. The publication that gives the tables rows is the one
    // whose statistics the statement then writes.
    await publish(store, 3, 2, 'src/stats-bound.ts');
    // The publication analyzed the never-analyzed tables itself: nothing is due straight after it.
    expect(await store.refreshStatistics()).toBeNull();
    store.statistics.note(STATISTICS_ROWS - 1);
    expect(await store.refreshStatistics()).toBeNull();
    store.statistics.note(1);
    const due = await store.refreshStatistics();
    expect(due).not.toBeNull();
    expect(due!.written).toBe(STATISTICS_ROWS);
    expect(due!.neverAnalyzed).toBe(false);
    expect(due!.ms).toBeGreaterThanOrEqual(0);
    // The statement is the one `ANALYZE_STATISTICS_SQL` names, and it wrote the tables' statistics.
    expect(ANALYZE_STATISTICS_SQL).toBe(`ANALYZE ${STATISTICS_TABLES.join(', ')}`);
    const counted = await owner.run((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_statistic WHERE starelid = 'node_version'::regclass"));
    expect(Number(counted.rows[0]!.n)).toBeGreaterThan(0);
  }, 300_000);

  test('a read answers the same rows and the same membership before, during and after a refresh', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    await publish(store, 3, 2);
    store.statistics.note(STATISTICS_ROWS);
    const read = async () => await store!.byProperty('code.callable', 'file', FILE);
    const before = await read();
    const membership = readMembership(before.rows);
    expect(before.rows.length).toBe(3);
    // A refresh and a read at once: the ANALYZE changes no row of the graph, so both answers are the same.
    const [refreshed, during] = await Promise.all([store.refreshStatistics(), read()]);
    expect(refreshed).not.toBeNull();
    expect(readMembership(during.rows)).toBe(membership);
    const after = await read();
    expect(readMembership(after.rows)).toBe(membership);
    expect(after.rows.map((row) => row.nodeId)).toEqual(before.rows.map((row) => row.nodeId));
  }, 300_000);
});
