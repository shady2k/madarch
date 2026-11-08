/**
 * The index set of the node table, stated by what uses it (madarch-8bdc.2.5, item 4).
 *
 * The store once declared two indexes with a duplicate definition:
 *
 * - `node_version_history`, a GiST index over `(node_id, valid times, recorded times, states)` whose
 *   definition was that of `node_version_no_overlap`, the exclusion constraint's own index. On the
 *   fill's 2 499 106-version store both were 488 MB, both were maintained on every insert, and only one
 *   could ever serve a read;
 * - `node_version_record_key`, a partial index on `((properties->>'recordKey'))` whose predicate is
 *   `recorded_to = 'infinity'`. No statement in the tree names that predicate: a read reaches the key
 *   through the lens (`recorded_from <= $ AND $ < recorded_to`), which does not imply it, so the planner
 *   could not use it (measured: with `node_version_record_key_all` dropped, the read by key plans a
 *   sequential scan while the partial index stands).
 *
 * This test states the two facts that decide the removal: the historical read of one node plans the
 * no-overlap constraint's index, and the read by key plans the one `recordKey` index; and neither removed
 * name is in the schema any more.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { ensureGraphSchema, staticUnitPublicationOf } from '../src/fill/stages/static-graph.js';

const REPOSITORY = 'shop';
const FILE = 'src/duplicates.ts';
const COUNT = 300;

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let key = '';

/** One statement's plan text, from `EXPLAIN (ANALYZE, BUFFERS)`. */
async function plan(sql: string, params: readonly unknown[]): Promise<string> {
  if (owner === undefined) throw new Error('the store was not opened');
  const answered = await owner.run((tx) => tx.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [...params]));
  return answered.rows.map((row) => String(Object.values(row)[0])).join('\n');
}

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await ensureGraphSchema(store);
  key = `code.callable:${REPOSITORY}:${FILE}@7:8:identifier`;
  const writes = Array.from({ length: COUNT }, (_, index) => {
    const recordKey = `code.callable:${REPOSITORY}:${FILE}@${String(index)}:${String(index + 1)}:identifier`;
    return { kind: 'node' as const, evidence: `file:${REPOSITORY}:${FILE}`, value: { key: recordKey, kind: 'code.callable', label: 'callable', properties: { recordKey, factKind: 'callable', repository: REPOSITORY, file: FILE } } };
  });
  await store.publishUnit(staticUnitPublicationOf({ unitId: `file:${REPOSITORY}:${FILE}`, stageId: 'code-facts', digest: 'd'.repeat(64), writes }));
  await store.refreshStatistics();
}, 300_000);

afterAll(async () => {
  await owner?.close();
}, 300_000);

describe('the node table\'s indexes, by what uses them', () => {
  test('the historical read of one node plans the no-overlap constraint\'s index', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const nodeId = (await store.byKey(key)).rows[0]!.nodeId;
    const at = new Date().toISOString();
    const text = await plan(
      `SELECT v.id FROM node_version v WHERE v.node_id = $1::bigint AND v.valid_from <= $2::timestamptz AND $2::timestamptz < v.valid_to AND v.recorded_from <= $2::timestamptz AND $2::timestamptz < v.recorded_to AND v.states @> $3::bigint`,
      [nodeId, at, '0'],
    );
    expect(text).toContain('node_version_no_overlap');
    expect(text).not.toContain('Seq Scan on node_version');
  }, 300_000);

  test('the read by key plans the one recordKey index, and no second one exists', async () => {
    if (store === undefined || owner === undefined) throw new Error('the store was not opened');
    const at = new Date().toISOString();
    const text = await plan(
      `SELECT v.id FROM node_version v WHERE v.properties->>'recordKey' = $1 AND v.valid_from <= $2::timestamptz AND $2::timestamptz < v.valid_to AND v.recorded_from <= $2::timestamptz AND $2::timestamptz < v.recorded_to AND v.states @> $3::bigint`,
      [key, at, '0'],
    );
    expect(text).toContain('node_version_record_key_all');
    const indexes = await owner.run((tx) => tx.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'node_version' AND indexname LIKE '%record_key%' ORDER BY 1"));
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['node_version_record_key_all']);
  }, 300_000);

  test('the two indexes the module no longer declares are gone, and the constraint that needs one still stands', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const named = await owner.run((tx) => tx.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname IN ('node_version_history', 'node_version_record_key')"));
    expect(named.rows).toEqual([]);
    const constraint = await owner.run((tx) => tx.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE contype = 'x' AND conrelid = 'node_version'::regclass AND conname = 'node_version_no_overlap'"));
    expect(constraint.rows.map((row) => row.conname)).toEqual(['node_version_no_overlap']);
  }, 300_000);
});
