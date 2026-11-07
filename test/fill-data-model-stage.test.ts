/**
 * The data-model stages on one small repository (madarch-8bdc.2.4): the records
 * the two stages publish for the fixture's own bytes — a database with two
 * migrations, an index, a foreign key and an added column, a seed's write, a
 * function's read, and the storage evidence of a manifest and an environment
 * file — read back from the graph, and a second run of the same commit that
 * plans no unit of either stage.
 *
 * The fixture is `test/fixtures/data-model/repository.ts`'s own: no outside
 * checkout, and every expectation is the bytes the fixture writes.
 */
import { afterAll, beforeAll, describe as bunDescribe, expect, test as bunTest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type PageOptions } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { DATA_MODEL_AGGREGATE_STAGE_ID, DATA_MODEL_STAGE_ID } from '../src/fill/stages/data-model.js';
import { FIRST_MIGRATION, MANIFEST, REPOSITORY, SEED, SECOND_MIGRATION, STORE, UNIT, writeProduct } from './fixtures/data-model/repository.js';
import { skippedBecauseOutOfWorkflow } from './fill-skip-list.js';

// The cases read a stage out of this step's list: they come back with that stage's step (test/fill-skip-list.ts).
const skippedSuite = skippedBecauseOutOfWorkflow(import.meta.path);
const describe = bunDescribe.skipIf(skippedSuite !== undefined);
const test = bunTest.skipIf(skippedSuite !== undefined);

const PRODUCERS = [`fill.${DATA_MODEL_STAGE_ID}`, `fill.${DATA_MODEL_AGGREGATE_STAGE_ID}`];

let root = '';
let owner: DatabaseOwner | undefined;
let service: ReturnType<typeof createFillOrchestratorService> | undefined;
let fill: StagesFill | undefined;
let store: GraphStore | undefined;
let first: FillRunResult | undefined;
let second: FillRunResult | undefined;

/** The node properties a read answered, as a record. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every node of one kind the graph holds for the repository, one page after another. */
async function nodesOfKind(kind: string): Promise<readonly { readonly nodeId: string; readonly producer: string; readonly properties: unknown }[]> {
  const rows: { nodeId: string; producer: string; properties: unknown }[] = [];
  await store!.readAll(async (page: PageOptions) => {
    const answer = await store!.byProperty(kind, 'repository', REPOSITORY, page);
    rows.push(...answer.rows.map((row) => ({ nodeId: row.nodeId, producer: row.producer, properties: row.properties })));
    return answer;
  });
  return rows;
}

/** Every edge of one relation the graph holds for the repository, one page after another. */
async function edgesOfRelation(relation: string): Promise<readonly EdgeEntry[]> {
  const rows: EdgeEntry[] = [];
  await store!.readAll(async (page: PageOptions) => {
    const answer = await store!.edgesByProperty(relation, 'repository', REPOSITORY, page);
    rows.push(...answer.rows);
    return answer;
  });
  return rows;
}

/** One edge's properties, with the graph's own bookkeeping left out. */
function EDGE_PROPERTIES(entry: EdgeEntry): Record<string, unknown> {
  const held = entry.edge.properties !== null && typeof entry.edge.properties === 'object' ? entry.edge.properties as Record<string, unknown> : {};
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(held).sort()) if (!['factKind', 'repository'].includes(key)) kept[key] = held[key];
  return kept;
}

/** A record's key, refused by name where it carries none. */
function keyOf(node: { readonly nodeId: string; readonly properties: unknown }): string {
  const held = propertiesOf(node)['recordKey'];
  if (typeof held !== 'string' || held === '') throw new Error(`the graph's node ${node.nodeId} carries no recordKey`);
  return held;
}

beforeAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  root = mkdtempSync(join(tmpdir(), 'madarch-data-model-stage-'));
  const { product } = writeProduct(root);
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const run = await service.run({ product: fill.product, runId: 'data-model-one' });
  if (!run.ok) throw new Error(`the first fill was refused: ${run.code}: ${run.reason}`);
  first = run;
}, 900_000);

afterAll(async () => {
  // The store the cases read is filled by stages out of this step's list: no fixture is made or closed.
  if (skippedSuite !== undefined) return;
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

describe('the data model of one small repository', () => {
  test('the fill finishes with every stage\'s units settled', async () => {
    const failures = await owner!.transaction('snapshot', async (executor) => {
      const rows = await executor.query<{ summary: string }>("SELECT summary FROM fill_event WHERE kind = 'unit-failed' ORDER BY seq");
      return rows.rows.map((row) => row.summary);
    });
    expect({ state: first?.state, settled: first?.settled, failed: (first?.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId), failures })
      .toEqual({ state: 'succeeded', settled: true, failed: [], failures: [] });
  }, 900_000);

  test('one migration per file, in the order the series applies them', async () => {
    const migrations = (await nodesOfKind('code.migration')).filter((node) => PRODUCERS.includes(node.producer));
    const read = migrations.map((node): Record<string, unknown> => ({ ...propertiesOf(node), key: keyOf(node) }))
      .map((held) => `${String(held['key'])} ${String(held['ordinal'])} ${String(held['path'])} ${String(held['prisma'])}`)
      .sort();
    expect(read).toEqual([
      `code.migration:${UNIT}/0001_init.sql 1 ${FIRST_MIGRATION} false`,
      `code.migration:${UNIT}/0002_add_status.sql 2 ${SECOND_MIGRATION} false`,
    ]);
  }, 60_000);

  test('the tables, columns and index of the two migrations, and the column the alter adds', async () => {
    const tables = (await nodesOfKind('code.table')).filter((node) => PRODUCERS.includes(node.producer)).map(keyOf).sort();
    expect(tables).toEqual(['code.table:orders/public.customers', 'code.table:orders/public.orders']);
    const columns = (await nodesOfKind('code.column')).filter((node) => PRODUCERS.includes(node.producer))
      .map((node): Record<string, unknown> => ({ ...propertiesOf(node), key: keyOf(node) }));
    const status = columns.find((column) => column['key'] === 'code.table:orders/public.orders/status');
    expect(status === undefined ? undefined : { type: status['type'], nullable: status['nullable'], default: status['default'], table: status['table'] })
      .toEqual({ type: 'TEXT', nullable: false, default: "'new'", table: 'orders' });
    const id = columns.find((column) => column['key'] === 'code.table:orders/public.customers/id');
    expect(id?.['primaryKey']).toBe(true);
    const indexes = (await nodesOfKind('code.index')).filter((node) => PRODUCERS.includes(node.producer))
      .map((node): Record<string, unknown> => ({ ...propertiesOf(node), key: keyOf(node) }))
      .map((index) => [String(index['key']), index['columns'], index['unique'], index['where'] ?? null])
      .sort();
    expect(indexes).toEqual([
      ['code.index:orders/public.orders/orders_customer_idx', ['customer_id'], false, null],
      ['code.index:orders/public.orders/orders_status_idx', ['status'], true, "status <> ''"],
    ]);
    // The index stands where the first migration writes it, and both the table and the file hold it.
    const orderIndex = (await nodesOfKind('code.index')).filter((node) => PRODUCERS.includes(node.producer))
      .map((node): Record<string, unknown> => ({ ...propertiesOf(node), key: keyOf(node) }))
      .find((index) => index['key'] === 'code.index:orders/public.orders/orders_customer_idx');
    const indexProvenance = orderIndex?.['provenance'] as Record<string, unknown> | undefined;
    const indexPlace = indexProvenance?.['place'] as Record<string, unknown> | undefined;
    const indexRange = indexPlace?.['range'] as Record<string, unknown> | undefined;
    expect(`${String(indexPlace?.['file'])}:${String(indexRange?.['startLine'])}-${String(indexRange?.['endLine'])}`).toBe(`${FIRST_MIGRATION}:13-13`);
    const contains = (await edgesOfRelation('code.contains')).filter((entry) => PRODUCERS.includes(entry.edge.producer))
      .map((entry) => `${String(propertiesOf(entry.src)['path'] ?? keyOf(entry.src))} -> ${keyOf(entry.dst)}`);
    expect(contains.filter((edge) => edge.endsWith('code.index:orders/public.orders/orders_customer_idx')).sort()).toEqual([
      `${FIRST_MIGRATION} -> code.index:orders/public.orders/orders_customer_idx`,
      'code.table:orders/public.orders -> code.index:orders/public.orders/orders_customer_idx',
    ].sort());
    const customersEmail = columns.find((column) => column['key'] === 'code.table:orders/public.customers/email');
    expect(customersEmail === undefined ? undefined : { type: customersEmail['type'], nullable: customersEmail['nullable'], unique: customersEmail['unique'], default: customersEmail['default'] ?? null })
      .toEqual({ type: 'TEXT', nullable: false, unique: true, default: null });
    const total = columns.find((column) => column['key'] === 'code.table:orders/public.orders/total_cents');
    expect(total?.['check']).toBe('total_cents >= 0');
    // The column that is one end of the foreign key says so (the aggregate's logical-reference
    // rule skips it), and the one that is not carries no such key.
    const orderId = columns.find((column) => column['key'] === 'code.table:orders/public.orders/id');
    expect([columns.find((column) => column['key'] === 'code.table:orders/public.orders/customer_id')?.['foreignKey'] ?? null, orderId?.['foreignKey'] ?? null])
      .toEqual([true, null]);
    // The added column stands where the second migration writes it.
    expect([status?.['provenance'], orderId?.['provenance']].map((provenance) => {
      const place = (provenance as Record<string, unknown>)['place'] as Record<string, unknown>;
      const range = place['range'] as Record<string, unknown>;
      return `${String(place['file'])}:${String(range['startLine'])}-${String(range['endLine'])}`;
    })).toEqual([`${SECOND_MIGRATION}:1-1`, `${FIRST_MIGRATION}:8-8`]);
  }, 60_000);

  test('the foreign key, the seed\'s write and the function\'s read name the tables they reach', async () => {
    const foreign = (await edgesOfRelation('code.foreign-key')).filter((entry) => PRODUCERS.includes(entry.edge.producer))
      .map((entry): Record<string, unknown> => ({ ...EDGE_PROPERTIES(entry), src: keyOf(entry.src), dst: keyOf(entry.dst), discriminator: entry.edge.discriminator }));
    expect(foreign).toEqual([{
      src: 'code.table:orders/public.orders',
      dst: 'code.table:orders/public.customers',
      discriminator: 'orders_customer_fk',
      column: 'customer_id',
      targetColumn: 'id',
      constraint: 'orders_customer_fk',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      cardinality: 'many-to-one',
    }]);
    const writes = (await edgesOfRelation('code.writes-table')).filter((entry) => PRODUCERS.includes(entry.edge.producer))
      .map((entry) => `${String(propertiesOf(entry.src)['path'])} -> ${keyOf(entry.dst)} ${String((entry.edge.properties as Record<string, unknown>)['via'])}`);
    expect(writes).toEqual([`${SEED} -> code.table:orders/public.orders sql`]);
    const covers = (await edgesOfRelation('code.covers')).filter((entry) => PRODUCERS.includes(entry.edge.producer))
      .map((entry) => `${keyOf(entry.src)} -> ${keyOf(entry.dst)}`).sort();
    expect(covers).toEqual([
      'code.index:orders/public.orders/orders_customer_idx -> code.table:orders/public.orders/customer_id',
      'code.index:orders/public.orders/orders_status_idx -> code.table:orders/public.orders/status',
    ]);
    const reads = (await edgesOfRelation('code.reads-table')).filter((entry) => PRODUCERS.includes(entry.edge.producer))
      .map((entry) => `${String(propertiesOf(entry.src)['qualifiedName'])} -> ${keyOf(entry.dst)} ${String((entry.edge.properties as Record<string, unknown>)['via'])}`);
    expect(reads).toEqual(['findOrder -> code.table:orders/public.orders sql']);
  }, 60_000);

  test('the database stands where its first migration does, with the evidence the manifest and the environment give', async () => {
    const databases = (await nodesOfKind('code.database')).filter((node) => PRODUCERS.includes(node.producer));
    expect(databases.length).toBe(1);
    const held = propertiesOf(databases[0]!);
    expect({ service: held['service'], path: held['path'], evidenceKind: held['evidenceKind'], evidence: held['evidence'] }).toEqual({
      service: UNIT,
      path: FIRST_MIGRATION,
      evidenceKind: 'schema',
      evidence: [
        { kind: 'connection-setting', path: '.env.example', line: 1 },
        { kind: 'driver', path: MANIFEST, line: 4 },
      ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    });
    const holds = (await edgesOfRelation('code.holds')).filter((entry) => PRODUCERS.includes(entry.edge.producer)).map((entry) => keyOf(entry.dst)).sort();
    expect(holds).toEqual(['code.table:orders/public.customers', 'code.table:orders/public.orders']);
  }, 60_000);

  test('a second run of one commit plans no unit of either stage', async () => {
    const again = await service!.run({ product: fill!.product, runId: 'data-model-two' });
    if (!again.ok) throw new Error(`the second fill was refused: ${again.code}: ${again.reason}`);
    second = again;
    const planned = (second.units ?? []).map((unit) => unit.unitId).filter((unitId) => /^(data-model|data-model-aggregate)\//.test(unitId));
    expect(planned).toEqual([]);
    expect(second?.state).toBe('succeeded');
  }, 300_000);
});
