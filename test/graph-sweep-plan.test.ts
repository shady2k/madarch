/**
 * The plan of the sweep (madarch-8bdc.2.5, item 1): a complete publication ends
 * what it did not repeat by reading the current versions of its own producer and
 * scope (`SWEEP_NODES_SQL` and `SWEEP_EDGES_SQL`, `src/graph/publish.ts`). Those
 * two statements are what a publication pays on every unit, so their plan must
 * not grow with the graph: on a graph holding enough rows for a whole-table scan
 * to be the plan without the indexes of `schema.ts`, both statements use
 * `node_version_producer_scope` and `edge_version_producer_scope`, and their
 * index condition restricts the scan to the unit's own producer and scope, so
 * they read no heap page of another producer's rows.
 *
 * The graph here holds twenty units of rows and one unit whose sweep is read.
 * The whole-table scan's page count is measured in the same run, so the bound
 * the sweep must stay under is a number this test reads, not a constant.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { SWEEP_EDGES_SQL, SWEEP_NODES_SQL } from '../src/graph/publish.js';
import { ensureGraphSchema, staticUnitPublicationOf } from '../src/fill/stages/static-graph.js';

const REPOSITORY = 'shop';
/** Units beside the one under test: the graph these rows make is what a whole-table scan reads. */
const OTHER_UNITS = 20;
/** Rows each of those units publishes. */
const ROWS_PER_UNIT = 500;
/** Edges each of those units publishes, one per two of its rows. */
const EDGES_PER_UNIT = 250;
/** The unit whose sweep this test reads: its own rows are a fraction of the graph. */
const UNIT_ROWS = 200;
const UNIT_EDGES = 40;
const UNIT_INDEX = 7;

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let unitScope = '';

interface Scan {
  readonly plan: string;
  /** The buffer pages the whole statement touched (hit and read alike), its planning included. */
  readonly buffers: number;
  /** The buffer pages of the plan node whose line matches `node`, or -1 when no node does. */
  node(node: RegExp): number;
}

/** The pages one `Buffers:` line names, hit and read alike. */
function pagesOf(line: string): number {
  return [...line.matchAll(/Buffers: shared (?:hit=(\d+))?(?:[ ,]*read=(\d+))?/g)]
    .reduce((total, match) => total + Number(match[1] ?? 0) + Number(match[2] ?? 0), 0);
}

/**
 * One statement's plan, and the buffer pages it touched. A node's own line is followed by the lines of
 * its plans, so the first `Buffers:` line after a node's line is that node's own.
 */
async function scan(sql: string, params: readonly unknown[]): Promise<Scan> {
  if (owner === undefined) throw new Error('the store was not opened');
  const answered = await owner.run((tx) => tx.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [...params]));
  const plan = answered.rows.map((row) => String(Object.values(row)[0])).join('\n');
  const lines = plan.split('\n');
  return {
    plan,
    buffers: pagesOf(plan),
    node(node: RegExp): number {
      const at = lines.findIndex((line) => node.test(line));
      if (at < 0) return -1;
      const bufferLine = lines.slice(at + 1).find((line) => line.trimStart().startsWith('Buffers:'));
      return bufferLine === undefined ? -1 : pagesOf(bufferLine);
    },
  };
}

/** A unit's nodes, and the edges between its first node and the others. */
function unitWrites(unit: number): { readonly key: string; readonly kind: string; readonly label: string; readonly properties: Record<string, unknown> }[] {
  return Array.from({ length: ROWS_PER_UNIT }, (_, index) => ({
    key: `code.callable:${REPOSITORY}:src/f${String(unit)}.ts@${String(index)}:${String(index + 1)}:identifier`,
    kind: 'code.callable',
    label: 'callable',
    properties: { recordKey: `code.callable:${REPOSITORY}:src/f${String(unit)}.ts@${String(index)}:${String(index + 1)}:identifier`, factKind: 'callable', repository: REPOSITORY, file: `src/f${String(unit)}.ts` },
  }));
}

async function publishUnit(unit: number, rows: number, edges: number): Promise<void> {
  if (store === undefined) throw new Error('the store was not opened');
  const nodes = unitWrites(unit);
  const published = await store.publishUnit(staticUnitPublicationOf({
    unitId: `file:${REPOSITORY}:src/f${String(unit)}.ts`,
    stageId: 'code-facts',
    digest: `${String(unit).padStart(8, '0')}`.repeat(8),
    writes: [
      ...nodes.slice(0, rows).map((node) => ({ kind: 'node' as const, evidence: `file:${REPOSITORY}:src/f${String(unit)}.ts`, value: node })),
      ...nodes.slice(1, edges + 1).map((node) => ({ kind: 'edge' as const, evidence: `file:${REPOSITORY}:src/f${String(unit)}.ts`, value: { relation: 'code.references', from: { key: nodes[0]!.key }, to: { key: node.key }, properties: { factKind: 'reference', repository: REPOSITORY } } })),
    ],
  }));
  if (unit === UNIT_INDEX) unitScope = published.scope;
}

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await ensureGraphSchema(store);
  for (let unit = 0; unit < OTHER_UNITS + 1; unit += 1) {
    const under = unit === UNIT_INDEX;
    await publishUnit(unit, under ? UNIT_ROWS : ROWS_PER_UNIT, under ? UNIT_EDGES : EDGES_PER_UNIT);
  }
  // The statistics a fill keeps current (`statistics.ts`): the plan is stated against them.
  await store.refreshStatistics();
}, 600_000);

afterAll(async () => {
  await owner?.close();
}, 300_000);

describe('the sweep statements plan on an index, not on the graph', () => {
  test('the node sweep reads the unit\'s own rows through node_version_producer_scope', async () => {
    const at = new Date().toISOString();
    const whole = await scan('SELECT count(*) FROM node_version', []);
    expect(whole.plan).toContain('Seq Scan on node_version');
    const sweep = await scan(SWEEP_NODES_SQL, ['fill.code-facts', unitScope, at, 'engine:content']);
    expect(sweep.plan).toContain('node_version_producer_scope');
    expect(sweep.plan).not.toContain('Seq Scan on node_version');
    expect(sweep.plan).toContain('Index Cond: ((producer = \'fill.code-facts\'::text) AND (scope_id =');
    // The unit holds 1/50 of the rows, so its own heap pages are a fraction of a whole-table scan's: the
    // statement reads those pages and no page of another producer's rows.
    const own = sweep.node(/node_version_producer_scope/);
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(whole.buffers / 8);
    expect(sweep.plan).not.toContain('Heap Blocks: lossy');
  }, 300_000);

  test('the edge sweep reads the unit\'s own rows through edge_version_producer_scope', async () => {
    const at = new Date().toISOString();
    const whole = await scan('SELECT count(*) FROM edge_version', []);
    expect(whole.plan).toContain('Seq Scan on edge_version');
    const sweep = await scan(SWEEP_EDGES_SQL, ['fill.code-facts', unitScope, at]);
    expect(sweep.plan).toContain('edge_version_producer_scope');
    expect(sweep.plan).not.toContain('Seq Scan on edge_version');
    expect(sweep.plan).toContain('Index Cond: ((producer = \'fill.code-facts\'::text) AND (scope_id =');
    const own = sweep.node(/edge_version_producer_scope/);
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(whole.buffers / 8);
  }, 300_000);
});
