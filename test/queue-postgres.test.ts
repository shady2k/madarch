/** The shared queue contract on the test run's real PostgreSQL server. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createTestDatabaseOwner } from './test-database.js';
import { QUEUE_SCENARIO_CHECKS } from './queue-expectations.js';
import { runQueueScenario } from './queue-scenario.js';

const SCHEMA = 'madarch_queue_test';
let owner: DatabaseOwner;
let scenario: ReturnType<typeof runQueueScenario>;

beforeAll(async () => {
  owner = await createTestDatabaseOwner();
  scenario = runQueueScenario(owner, SCHEMA);
}, 60_000);

afterAll(async () => {
  await scenario?.catch(() => undefined);
  await owner?.close();
}, 60_000);

for (const { name, check } of QUEUE_SCENARIO_CHECKS) {
  test(name, async () => {
    check(await scenario);
  }, 120_000);
}

test("the queue's tables answer from the owner's own database", async () => {
  const jobs = await owner.run(async (transaction) => (await transaction.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${SCHEMA}.job`)).rows);
  expect(jobs[0]?.count).toBeGreaterThan(0);
}, 60_000);
