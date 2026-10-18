/**
 * The queue on PostgreSQL (madarch-tzte.19.2): the same scenario and the same
 * expectations the PGlite suite runs, against the owner a server needs — a `pg`
 * pool instead of PGlite's single connection, pg-boss's `postgres` backend
 * profile instead of `pglite`, and a schema this file drops before and after so
 * a shared server does not accumulate runs.
 *
 * The server is the one `MADARCH_TEST_POSTGRES_URL` names, which CI's checks job
 * sets for the service it starts; without it every test here is skipped, and the
 * skip names that variable as its reason.
 *
 * What differs on a server is where the statement runs, not what the queue
 * promises: `test/queue-expectations.ts` is one list of expected values, so this
 * file adds no expectations of its own beyond the database the tables answer
 * from.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { QUEUE_SCENARIO_CHECKS } from './queue-expectations.js';
import { runQueueScenario } from './queue-scenario.js';

const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];
const SKIP = 'skipped: MADARCH_TEST_POSTGRES_URL names no PostgreSQL server in this environment';
const SCHEMA = 'madarch_queue_test';

let owner: DatabaseOwner | undefined;
let scenario: ReturnType<typeof runQueueScenario> | undefined;

beforeAll(async () => {
  if (connectionString === undefined) return;
  owner = await createPostgresDatabaseOwner({ connectionString });
  // A run that was killed leaves its schema behind: the queue is created in it
  // again, and nothing of the old run is read.
  await owner.run(async (transaction) => {
    await transaction.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });
  scenario = runQueueScenario(owner, SCHEMA);
}, 60_000);

afterAll(async () => {
  await scenario?.catch(() => undefined);
  if (owner !== undefined) {
    await owner.run(async (transaction) => {
      await transaction.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    });
    await owner.close();
  }
}, 60_000);

for (const { name, check } of QUEUE_SCENARIO_CHECKS) {
  test.skipIf(connectionString === undefined)(`${name} (${SKIP})`, async () => {
    check(await scenario!);
  }, 120_000);
}

test.skipIf(connectionString === undefined)(`the queue's tables answer from the owner's own database (${SKIP})`, async () => {
  const jobs = await owner!.run(async (transaction) => (await transaction.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${SCHEMA}.job`)).rows);
  expect(jobs[0]?.count).toBeGreaterThan(0);
}, 60_000);
