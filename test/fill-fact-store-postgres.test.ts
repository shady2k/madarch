/**
 * The fill's fact store on PostgreSQL (madarch-tzte.20.2): the same scenario and
 * the same expectations the PGlite suite runs, against the engine a server uses
 * — a `pg` pool instead of PGlite's one connection, in the schema this file
 * drops before and after so a shared server does not accumulate runs.
 *
 * The server is the one `MADARCH_TEST_POSTGRES_URL` names, which CI's checks job
 * sets for the service it starts; without it every test here is skipped, and the
 * skip names that variable as its reason.
 *
 * What differs on a server is where the statement runs, not what the store
 * promises: `test/fill-fact-store-expectations.ts` is one list of expected
 * values, so this file adds no expectations of its own beyond the engine the
 * tables answer from.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { FACT_APPLICATION, createFactStoreSchema, readFact, readUnitFacts } from '../src/fill/fact-store.js';
import { makeNodeFact, repositoryPath, type Fact } from '../src/fill/facts.js';
import { createOrchestratorSchema, type UnitPlanRecord } from '../src/fill/orchestrator-store.js';
import { createFillStateSchema, type UnitRecord } from '../src/fill/state-store.js';
import type { SqlExecutor } from '../src/query/sql-driver.js';
import { factStoreChecks } from './fill-fact-store-expectations.js';
import { runFactStoreScenario, scenarioFacts, writeOf, type FactStoreScenarioReport } from './fill-fact-store-scenario.js';

const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];
const SKIP = 'skipped: MADARCH_TEST_POSTGRES_URL names no PostgreSQL server in this environment';

let owner: DatabaseOwner | undefined;
let report: FactStoreScenarioReport | undefined;

beforeAll(async () => {
  if (connectionString === undefined) return;
  owner = await createPostgresDatabaseOwner({ connectionString });
  // A run that was killed leaves its tables behind: the store creates its own again, and nothing of the
  // old run is read. The fill's tables are named so only they go.
  await owner.run(async (transaction) => {
    await transaction.query('DROP TABLE IF EXISTS fill_fact_holding, fill_fact, fill_unit_lease, fill_unit_read, fill_unit_draft, fill_unit_split, fill_publication, fill_unit_generation, fill_unit, fill_run, fill_chain, fill_transition, fill_event, fill_unit_plan, fill_run_configuration CASCADE');
  });
  report = await runFactStoreScenario(owner);
}, 120_000);

afterAll(async () => {
  if (owner === undefined) return;
  await owner.run(async (transaction) => {
    await transaction.query('DROP TABLE IF EXISTS fill_fact_holding, fill_fact, fill_unit_lease, fill_unit_read, fill_unit_draft, fill_unit_split, fill_publication, fill_unit_generation, fill_unit, fill_run, fill_chain, fill_transition, fill_event, fill_unit_plan, fill_run_configuration CASCADE');
  });
  await owner.close();
}, 120_000);

for (const { name, check } of factStoreChecks(scenarioFacts())) {
  test.skipIf(connectionString === undefined)(`${name} (${SKIP})`, () => {
    check(report!);
  });
}

/** One unit generation, as the store reads the caller's own records: only the fields a publication names. */
function sweepUnit(unitId: string): UnitRecord {
  return {
    unitId,
    product: 'fixture-product',
    runId: 'run-sweep',
    stageId: 'modules',
    scopeKey: unitId,
    generation: 1,
    state: 'validating',
    inputsDigest: `${unitId}-inputs`,
    context: { generation: 1, attempt: 1, fence: 1, retriesLeft: 0, retryAt: null, replacedBy: null },
    publishedAt: null,
    staleAt: null,
    updatedAt: 1_700_000_000_000,
    lease: null,
  };
}

/** The unit's place in a plan, as the publication names it. */
function sweepPlan(unitId: string): UnitPlanRecord {
  return { unitId, generation: 1, runId: 'run-sweep', stageId: 'modules', stageUnitId: unitId, scope: unitId, stagePosition: 0, planPosition: 0, plannedAt: 1_700_000_000_000 };
}

/**
 * Waits for one transaction to be waiting on a lock, which is how a sweep that meets a publisher beside
 * it is seen: the wait is the behaviour under test, and a sweep that never waits removes a fact its
 * publisher counted. The loop waits for that state to be observable, bounded, and never for a duration:
 * with the sweep in place it returns on the first look.
 */
async function waitForALockedSweep(owner: DatabaseOwner): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await owner.run(async (transaction) => (
      await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()")
    ).rows[0]?.count ?? 0);
    if (waiting > 0) return;
  }
  throw new Error('no publication waited on the fact row: the sweep of one unit removed a fact another unit was publishing');
}

test.skipIf(connectionString === undefined)(`a fact another unit is publishing is not swept away (${SKIP})`, async () => {
  const facts = scenarioFacts();
  // Two facts of this test's own: the scenario's units hold their own, and a publication beside another
  // one is what this test is about.
  const shared = makeNodeFact({ kind: 'module', value: { repository: 'acme-shop', name: 'sweep-shared', seed: 'package' }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) }, place: { file: repositoryPath('src/sweep-shared.ts'), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 4 } } }, layer: 'extracted' });
  const own = makeNodeFact({ kind: 'module', value: { repository: 'acme-shop', name: 'sweep-own', seed: 'package' }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: 'acme-shop', commit: 'a'.repeat(40) }, place: { file: repositoryPath('src/sweep-own.ts'), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 4 } } }, layer: 'extracted' });
  /** One publication's request, as the orchestrator builds it: the transaction, the unit, its plan and its draft set. */
  const request = (unitId: string, fact: Fact, executor: SqlExecutor) => ({
    executor, unit: sweepUnit(unitId), plan: sweepPlan(unitId), digest: `publication-${unitId}`, writes: [writeOf('fact', fact)],
  });
  const second = await createPostgresDatabaseOwner({ connectionString: connectionString! });
  try {
    await createFactStoreSchema(second);
    // The fact is published and committed before anything runs beside it.
    await second.transaction('write', async (executor) => {
      await FACT_APPLICATION.apply(request('sweep-seed', shared, executor));
    });
    // One publication holds the fact, uncommitted, and waits there.
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => { holding = resolve; });
    let releasing!: () => void;
    const release = new Promise<void>((resolve) => { releasing = resolve; });
    const publishes = second.transaction('write', async (executor) => {
      await FACT_APPLICATION.apply(request('sweep-a', shared, executor));
      holding();
      await release;
    });
    await holds;
    // A second unit publishes a fact of its own: its sweep drops nothing, and must not remove what the
    // first publication is putting back.
    const beside = second.transaction('write', async (executor) => {
      await FACT_APPLICATION.apply(request('sweep-b', own, executor));
    });
    await waitForALockedSweep(second);
    releasing();
    await publishes;
    await beside;
    const stored = await readFact(second, shared.id);
    expect(stored?.publishers.map((publisher) => publisher.unitId)).toEqual(['sweep-a', 'sweep-seed']);
    expect((await readUnitFacts(second, 'sweep-b')).map((entry) => entry.fact.id)).toEqual([own.id]);
  } finally {
    await second.close();
  }
}, 60_000);

test.skipIf(connectionString === undefined)(`the store's tables answer from the owner's own database (${SKIP})`, async () => {
  // What the tables hold is judged by the checks above; this says only that they answer from the server's
  // own database, where a `pg` pool ran the same publication PGlite ran.
  const rows = await owner!.run(async (transaction) => (await transaction.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact')).rows);
  expect(rows[0]?.count).toBeGreaterThan(0);
}, 60_000);
