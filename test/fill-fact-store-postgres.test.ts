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
import { factStoreChecks } from './fill-fact-store-expectations.js';
import { runFactStoreScenario, scenarioFacts, type FactStoreScenarioReport } from './fill-fact-store-scenario.js';

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

test.skipIf(connectionString === undefined)(`the store's tables answer from the owner's own database (${SKIP})`, async () => {
  // What the tables hold is judged by the checks above; this says only that they answer from the server's
  // own database, where a `pg` pool ran the same publication PGlite ran.
  const rows = await owner!.run(async (transaction) => (await transaction.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact')).rows);
  expect(rows[0]?.count).toBeGreaterThan(0);
}, 60_000);
