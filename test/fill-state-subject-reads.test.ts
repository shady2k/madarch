
/**
 * The fill service state reads by subject (madarch-64o5.74, T3/D): a store whose
 * only difference is what lies beside the run reads the same rows. Rows are
 * counted by `pg_stat_xact_user_tables` (`seq_tup_read + idx_tup_fetch`) inside
 * the read's own transaction, with `SET LOCAL enable_seqscan = off`, so the count
 * measures the path the read takes and not the planner's choice on a small store.
 *
 * Store E holds product P's run of 5 units. Store F is the same graph plus two
 * earlier runs of 50 units each, of another product's chain, with `unit-parent`
 * edges and their operations: a read of P's run must not grow with them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { ensureVertex, publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { newUid } from '../src/graph/uid.js';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import {
  readRunConfiguration, readRunPlans, readRunPublicationCount, readRunPublicationStages, readSealedChildren, readSplitParents, readUnitPlan,
} from '../src/graph/fill-orchestration.js';
import { hasSuccessfulFill, readLatestRun } from '../src/graph/fill-state.js';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { successfulPluginSnapshot } from '../src/graph/plugin-turns.js';

const NOW = 1_760_000_000_000;

interface Written { readonly uid: string; readonly nodeId: string }

async function writeVertex(tx: SqlExecutor, kind: string, values: Readonly<Record<string, unknown>>): Promise<Written> {
  const made = await ensureVertex(tx, EMPTY_CONTRACT, { kind, key: {}, uid: newUid() });
  for (const [property, value] of Object.entries({ $exists: true, ...values })) {
    await writeAssertion(tx, EMPTY_CONTRACT, { sort: 'vertex', kind, subjectId: made.nodeId, property, operation: 'assert', value });
  }
  return made;
}

async function writeRun(tx: SqlExecutor, product: string, runId: string, at: number): Promise<Written> {
  return await writeVertex(tx, 'system.run', {
    run_name: runId, product_name: product, state: 'succeeded', planning_epoch: 1, planning_closed: true,
    has_selection: false, created_at: at, updated_at: at,
  });
}

async function writeChain(tx: SqlExecutor, product: string, at: number, runs: readonly Written[]): Promise<Written> {
  const chain = await writeVertex(tx, 'system.chain', { product_name: product, state: 'quiescent', updated_at: at });
  await publishGraphDrafts(tx, EMPTY_CONTRACT, {
    vertices: [], removals: [],
    edges: runs.map((run) => ({ kind: 'system.chain-run', from: { kind: 'system.chain', key: {}, uid: chain.uid }, to: { kind: 'system.run', key: {}, uid: run.uid }, discriminator: run.uid, producer: 'fixture', producerVersion: '1' })),
  });
  return chain;
}

interface UnitSpec {
  readonly unitId: string;
  readonly stage: string;
  readonly scope: string;
  readonly generation?: number;
  readonly state: 'planned' | 'published';
  readonly planned: number;
  readonly outcome?: Readonly<Record<string, unknown>>;
}

async function writeUnit(tx: SqlExecutor, run: Written, spec: UnitSpec): Promise<Written> {
  const planned = spec.planned;
  const unit = await writeVertex(tx, 'system.unit', {
    unit_name: spec.unitId, product_name: 'fixture', stage_name: spec.stage, scope: spec.scope,
    generation: spec.generation ?? 1, state: spec.state, inputs_digest: `digest-${spec.unitId}`, fence: 0, attempt: 0,
    retries_left: 3, published_at: spec.state === 'published' ? planned + 1 : null, updated_at: planned + 1,
    plan_stage_name: spec.stage, plan_stage_unit_name: spec.unitId, plan_scope: spec.scope,
    plan_stage_position: 0, plan_position: 0, planned_at: planned,
    ...(spec.outcome ?? {}),
  });
  await publishGraphDrafts(tx, EMPTY_CONTRACT, {
    vertices: [], removals: [],
    edges: [{ kind: 'system.unit-run', from: { kind: 'system.unit', key: {}, uid: unit.uid }, to: { kind: 'system.run', key: {}, uid: run.uid }, producer: 'fixture', producerVersion: '1' }],
  });
  return unit;
}

/** One completed publication per unit, as `readPublicationIn` reads it: an operation keyed `complete`. */
async function writePublications(tx: SqlExecutor, units: readonly Written[]): Promise<void> {
  const operations = await Promise.all(units.map(async () => await writeVertex(tx, 'system.operation', { key: 'complete', digest: `sha-${newUid()}`, words: 'complete' })));
  await publishGraphDrafts(tx, EMPTY_CONTRACT, {
    vertices: [], removals: [],
    edges: operations.map((operation, index) => ({ kind: 'system.operation-unit', from: { kind: 'system.operation', key: {}, uid: operation.uid }, to: { kind: 'system.unit', key: {}, uid: units[index]!.uid }, producer: 'fixture', producerVersion: '1' })),
  });
}

async function writeParents(tx: SqlExecutor, children: readonly Written[], parent: Written): Promise<void> {
  await publishGraphDrafts(tx, EMPTY_CONTRACT, {
    vertices: [], removals: [],
    edges: children.map((child) => ({ kind: 'system.unit-parent', from: { kind: 'system.unit', key: {}, uid: child.uid }, to: { kind: 'system.unit', key: {}, uid: parent.uid }, discriminator: child.uid, values: { sealed_at: NOW + 20 }, producer: 'fixture', producerVersion: '1' })),
  });
}

/** E's graph: product P's run of 5 units, its plans, two sealed children and its publications. */
async function buildRunOfFive(tx: SqlExecutor, product = 'P'): Promise<void> {
  const run = await writeRun(tx, product, 'P-run', NOW);
  await writeChain(tx, product, NOW, [run]);
  const units: Written[] = [];
  for (const index of [0, 1, 2, 3, 4]) {
    units.push(await writeUnit(tx, run, {
      unitId: `P-u${String(index)}`, stage: index === 0 ? 'stage-a' : 'stage-b', scope: `scope-${String(index)}`,
      state: 'published', planned: NOW + 10 + index,
      outcome: { produced_kind: 'code.file', producer: 'disk', outcome: 'completed', produced: index },
    }));
  }
  await writeParents(tx, [units[1]!, units[2]!], units[0]!);
  await writePublications(tx, units);
}

/** F's graph: E's, plus two earlier runs of 50 units each in product Q's chain. */
async function buildPriorRuns(tx: SqlExecutor): Promise<void> {
  for (const index of [0, 1]) {
    const run = await writeRun(tx, 'Q', `Q-run-${String(index)}`, NOW - 5_000 - index);
    await writeChain(tx, 'Q', NOW - 5_000 - index, [run]);
    const units: Written[] = [];
    for (let unit = 0; unit < 50; unit++) {
      units.push(await writeUnit(tx, run, {
        unitId: `Q${String(index)}-u${String(unit)}`, stage: 'q-stage', scope: `q-scope-${String(unit)}`,
        state: 'published', planned: NOW - 4_000 + unit,
        outcome: { produced_kind: 'code.file', producer: 'disk', outcome: 'completed', produced: unit },
      }));
    }
    await writeParents(tx, units.slice(1), units[0]!);
    await writePublications(tx, units);
  }
}

interface Counted { rows: number; statements: number }

const ROWS = 'SELECT coalesce(sum(seq_tup_read + idx_tup_fetch), 0)::bigint AS rows FROM pg_stat_xact_user_tables';

/** The read's database, counting the rows and the statements every transaction of it takes. */
function counted(owner: TestDatabaseOwner, counter: Counted): TestDatabaseOwner {
  return {
    ...owner,
    graphContract: owner.graphContract,
    transaction: (kind, work) => owner.transaction(kind, async (tx) => {
      // Rows are the path the read takes, not the planner's choice on a small store (plan section 2, "counter tests").
      await tx.query('SET LOCAL enable_seqscan = off');
      const start = Number((await tx.query<{ rows: string }>(ROWS)).rows[0]!.rows);
      const executor = {
        query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> => {
          counter.statements += 1;
          return await tx.query(sql, values) as { rows: Row[] };
        },
      };
      const result = await work(executor);
      const end = Number((await tx.query<{ rows: string }>(ROWS)).rows[0]!.rows);
      counter.rows += end - start;
      return result;
    }),
  } as TestDatabaseOwner;
}

async function measure<T>(owner: TestDatabaseOwner, read: (database: TestDatabaseOwner) => Promise<T>): Promise<{ rows: number; statements: number; result: T }> {
  const counter: Counted = { rows: 0, statements: 0 };
  const result = await read(counted(owner, counter));
  return { ...counter, result };
}

/** The public reads, each by the name the plan lists it. */
const READS: readonly { readonly name: string; readonly read: (database: TestDatabaseOwner) => Promise<unknown> }[] = [
  { name: 'readRunPublicationCount', read: async (database) => await readRunPublicationCount(database, 'P-run') },
  { name: 'readRunPublicationStages', read: async (database) => await readRunPublicationStages(database, 'P-run') },
  { name: 'readRunPlans', read: async (database) => await readRunPlans(database, 'P-run') },
  { name: 'readUnitPlan', read: async (database) => await readUnitPlan(database, 'P-u1', 1) },
  { name: 'readSealedChildren', read: async (database) => await readSealedChildren(database, 'P-u0', 1) },
  { name: 'readSplitParents', read: async (database) => await readSplitParents(database, 'P-u2', 1) },
  { name: 'readProducerOutcomes', read: async (database) => await readProducerOutcomes(database, { runId: 'P-run' }) },
  // The uid is the store's own; what a read must answer is the one unit of that scope.
  { name: 'successfulPluginSnapshot', read: async (database) => (await successfulPluginSnapshot(database, 'P-run', 'scope-0')).unitUid === '' ? 'none' : 'a unit' },
  // The `/api/status` read of the run: the four store reads its handler makes (`src/knowledge/product.ts`).
  // The whole poll also reads the catalogue's kinds and the product's files, which this task leaves aside
  // (`prepare-store.ts:40`, `plugin-turns.ts` product reads); an HTTP poll cannot be attributed to one
  // transaction across pooled backends, so the run's own reads are measured here.
  {
    name: 'status run read',
    read: async (database) => {
      const latest = await readLatestRun(database, 'P');
      if (latest === null) return 'no run';
      const configuration = await readRunConfiguration(database, latest.runId);
      const outcomes = await readProducerOutcomes(database, { runId: latest.runId });
      const filled = await hasSuccessfulFill(database, 'P');
      return { runId: latest.runId, targets: configuration?.snapshot.targets ?? null, outcomes: outcomes.map((outcome) => [outcome.unitId, outcome.generation, outcome.outcome]), filled };
    },
  },
];

async function store(build: ((tx: SqlExecutor) => Promise<void>) | undefined): Promise<TestDatabaseOwner> {
  const owner = await createTestDatabaseOwner();
  if (build !== undefined) await owner.transaction('write', async (tx) => { await bindTestWriteCapability(tx, EMPTY_CONTRACT); await build(tx); });
  return owner;
}

describe('the fill service state reads by subject', () => {
  /**
   * Store E holds product P's run of 5 units; store F holds the same graph plus two earlier runs of 50 units.
   *
   * Rows are `seq_tup_read + idx_tup_fetch` of `pg_stat_xact_user_tables`, taken inside the read's own
   * transaction with `SET LOCAL enable_seqscan = off`. The grown store must never read more: the read's cost
   * follows its subject, not the store. The exact count can move a few percent because the shared assertion
   * reader's access path is the planner's choice on a bigger `edge` table (the report of madarch-64o5.74 names
   * the node, its two plans and the numbers); before this change the same reads grew elevenfold with the store
   * (8 992 rows in E, 103 863 in F for `readRunPublicationCount`).
   */
  test('no public read of a run reads more rows beside two runs of fifty units', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-subject-reads-'));
    const e = await store(buildRunOfFive);
    const f = await store(async (tx) => { await buildRunOfFive(tx); await buildPriorRuns(tx); });
    try {
      const counts: Record<string, [number, number]> = {};
      const failures: string[] = [];
      for (const read of READS) {
        try {
          const [small, large] = [await measure(e, read.read), await measure(f, read.read)];
          counts[read.name] = [small.rows, large.rows];
          if (JSON.stringify(small.result) !== JSON.stringify(large.result)) failures.push(`${read.name}: the answers differ`);
        } catch (error) {
          counts[read.name] = [-1, -1];
          failures.push(`${read.name}: ${(error as Error).message}`);
        }
      }
      const grown = Object.entries(counts).filter(([, [small, large]]) => large > small)
        .map(([name, [small, large]]) => `${name}: ${String(small)} rows in E, ${String(large)} rows in F`);
      expect({ grown, failures, counts }).toEqual({ grown: [], failures: [], counts });
    } finally { await e.close(); await f.close(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  test('a publication read makes as many statements for fifty units as for five', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-subject-statements-'));
    const e = await store(buildRunOfFive);
    const f = await store(async (tx) => {
      const run = await writeRun(tx, 'R', 'R-run', NOW);
      await writeChain(tx, 'R', NOW, [run]);
      const units: Written[] = [];
      for (let unit = 0; unit < 50; unit++) units.push(await writeUnit(tx, run, { unitId: `R-u${String(unit)}`, stage: 'r-stage', scope: `r-scope-${String(unit)}`, state: 'published', planned: NOW + unit }));
      await writePublications(tx, units);
    });
    try {
      const [five, fifty] = [await measure(e, async (database) => await readRunPublicationCount(database, 'P-run')), await measure(f, async (database) => await readRunPublicationCount(database, 'R-run'))];
      expect(fifty.result).toBe(50);
      expect({ five: five.statements, fifty: fifty.statements }).toEqual({ five: five.statements, fifty: fifty.statements });
    } finally { await e.close(); await f.close(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});
