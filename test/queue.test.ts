/**
 * The queue on the process's PGlite owner (madarch-tzte.19.2, decision 0027
 * "Queue"): the shared behaviour `test/queue-expectations.ts` holds, run against
 * one run of `test/queue-scenario.ts`, and the three things only an owner can
 * show — the queue's tables living in the owner's own database under the schema
 * it was given, a declaration judged by its own fields, and an enqueue or a
 * settlement committing or rolling back with the caller's transaction beside the
 * fact log.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPGliteDatabaseOwner,
  createPGliteHistory,
  type Clock,
  type CompiledElement,
  type CompiledModel,
} from '../src/index.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { QUEUE_SCENARIO_CHECKS } from './queue-expectations.js';
import { runQueueScenario, SCENARIO_QUEUES } from './queue-scenario.js';

const DAY = (day: number) => Date.UTC(2026, 9, day); // October 2026

/** A clock a test moves by hand, never the real one. */
function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return {
    now: () => current,
    set(t: number) {
      current = t;
    },
  };
}

function model(elements: string[]): CompiledModel {
  return {
    schemaVersion: 1,
    elements: elements.map((id): CompiledElement => ({ id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] })),
    interfaces: [],
    relations: [],
    categories: [],
    entities: [],
    scenarios: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

const folder = mkdtempSync(join(tmpdir(), 'madarch-queue-'));
/** The schema the scenario's queue declares its tables in: not pg-boss's default, so the option is read. */
const SCHEMA = 'madarch_queue';
const owner = createPGliteDatabaseOwner({ path: join(folder, 'queue.pglite') });
/** One run of the scenario for every judgement below: the waits it makes are worth sharing. */
const scenario = runQueueScenario(owner, SCHEMA);

afterAll(async () => {
  await scenario.catch(() => undefined);
  await owner.close();
  rmSync(folder, { recursive: true, force: true });
});

for (const { name, check } of QUEUE_SCENARIO_CHECKS) {
  test(name, async () => {
    check(await scenario);
  }, 60_000);
}

test('the queue holds its tables in the owner’s one database, in the schema it was given', async () => {
  await scenario;
  const jobs = await owner.run(async (transaction) => (await transaction.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${SCHEMA}.job`)).rows);
  // The scenario's jobs answer from the owner's own connection, which is what
  // "one database" means: a second database would answer nothing here.
  expect(jobs[0]?.count).toBeGreaterThan(0);
  // The places the enqueues took live in the schema the queue was given too.
  const stamps = await owner.run(async (transaction) => (await transaction.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${SCHEMA}.madarch_enqueue_stamp`)).rows);
  expect(stamps[0]?.count).toBeGreaterThan(0);
  const schemas = await owner.run(async (transaction) => (await transaction.query<{ nspname: string }>('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows.map((row) => row.nspname));
  expect(schemas).toContain(SCHEMA);
  // pg-boss's own default schema was never created: the queue went where it was told.
  expect(schemas).not.toContain('pgboss');
}, 60_000);

test('a declaration is judged by its own fields, and a queue declared again runs with the settings it now has', async () => {
  const queue = await createPgBossQueue({ owner, schema: SCHEMA, supervise: false });
  try {
    await expect(queue.declare({ name: 'short-lease', leaseSeconds: 0, retries: 0, retryDelaySeconds: 0, retryBackoff: false })).rejects.toThrow(
      'the queue "short-lease" was declared with the lease of 0 seconds: a lease is a whole number of seconds, at least 1',
    );
    await expect(queue.declare({ name: 'bad heartbeat', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false })).rejects.toThrow(
      'the queue "bad heartbeat" is not a stored object\'s name',
    );
    await expect(queue.declare({ name: 'self-dead', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, deadLetter: 'self-dead' })).rejects.toThrow(
      'the queue "self-dead" names itself as its own dead letter queue',
    );
    await expect(queue.declare({ name: 'unknown-dead', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, deadLetter: 'never-declared' })).rejects.toThrow(
      'the queue "unknown-dead" names the dead letter queue "never-declared", which is not declared',
    );
    await queue.declare({ name: 'restated', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: 'restated', leaseSeconds: 30, retries: 1, retryDelaySeconds: 2, retryBackoff: true });
    const claimed = await queue.enqueue({ queue: 'restated', data: { unit: 'restated' } });
    expect(claimed.created).toBe(true);
    const jobs = await queue.claim({ queue: 'restated' });
    // The restated lease is the one the claim reports: 30, not the 60 of the
    // first declaration.
    expect(jobs.map((job) => job.leaseSeconds)).toEqual([30]);
    // The one field a later declaration cannot change is the singleton rule: the
    // queue's own index over its unfinished keys is built when it is created.
    await expect(queue.declare({ name: 'restated', leaseSeconds: 30, retries: 1, retryDelaySeconds: 2, retryBackoff: true, singletons: true })).rejects.toThrow(
      'the queue "restated" was already created holding no singletons, and a queue\'s singleton rule cannot change after it is created',
    );
  } finally {
    await queue.stop();
  }
}, 60_000);

test('an enqueue inside the caller’s transaction commits with the fact log, and a rollback leaves neither', async () => {
  const clock = fakeClock(DAY(1));
  const sharedOwner = createPGliteDatabaseOwner({ vector: true });
  const history = createPGliteHistory({ clock, owner: sharedOwner });
  const queue = await createPgBossQueue({ owner: sharedOwner, schema: 'shared_tx', supervise: false });
  try {
    await queue.declare({ name: 'publication', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });

    await sharedOwner.transaction('write', async (transaction) => {
      const stored = await history.store({ source: 'github.com/acme/shop', commit: 'c1', committedAt: DAY(1), model: model(['shop']) }, undefined, transaction);
      expect(stored.errors).toEqual([]);
      const answer = await queue.enqueue({ queue: 'publication', data: { unit: 'shop' }, transaction });
      expect(answer.created).toBe(true);
    });
    expect(await history.commits('github.com/acme/shop')).toHaveLength(1);
    const claimed = await queue.claim<{ unit: string }>({ queue: 'publication' });
    expect(claimed.map((job) => job.data.unit)).toEqual(['shop']);

    await expect(sharedOwner.transaction('write', async (transaction) => {
      await history.store({ source: 'github.com/acme/cart', commit: 'c2', committedAt: DAY(1), model: model(['cart']) }, undefined, transaction);
      await queue.enqueue({ queue: 'publication', data: { unit: 'cart' }, transaction });
      throw new Error('the caller gave up on the unit');
    })).rejects.toThrow('the caller gave up on the unit');
    expect(await history.commits('github.com/acme/cart')).toEqual([]);
    expect((await queue.claim({ queue: 'publication' })).length).toBe(0);

    // A settlement given the caller's transaction rolls back with it too: the
    // attempt is still the one in force and settles afterwards.
    await expect(sharedOwner.transaction('write', async (transaction) => {
      expect(await queue.complete('publication', claimed[0]!, undefined, transaction)).toBe(true);
      throw new Error('the caller gave up on the settlement');
    })).rejects.toThrow('the caller gave up on the settlement');
    expect(await queue.complete('publication', claimed[0]!)).toBe(true);
  } finally {
    await queue.stop();
    await history.close();
    await sharedOwner.close();
  }
}, 60_000);

test('every queue the scenario names was declared, and the one it never declares was not', async () => {
  await scenario;
  const names = await owner.run(async (transaction) => (await transaction.query<{ name: string }>(`SELECT name FROM ${SCHEMA}.queue`)).rows.map((row) => row.name));
  // Each queue the scenario uses, dead letter queues included, is a row of the
  // owner's own queue table; the one it only refuses against is not. The rows of
  // another test in this file (the declaration one) are beside them, which is why
  // this asks for these by name rather than for the whole table.
  expect(names).toEqual(expect.arrayContaining([...Object.values(SCENARIO_QUEUES)].filter((name) => name !== SCENARIO_QUEUES.undeclared)));
  expect(names).not.toContain(SCENARIO_QUEUES.undeclared);
}, 60_000);

test('a service left to itself recovers a lapsed claim without anyone asking', async () => {
  // The adapter's own passes are what make a killed worker recoverable while a
  // process lives; this shows the pass really runs on its own timer, over a
  // one-second lease with a pass every second.
  const alone = createPGliteDatabaseOwner();
  const queue = await createPgBossQueue({ owner: alone, schema: 'supervised', supervise: true, superviseIntervalSeconds: 1 });
  try {
    await queue.declare({ name: 'supervised', leaseSeconds: 1, retries: 2, retryDelaySeconds: 0, retryBackoff: false });
    await queue.enqueue({ queue: 'supervised', data: { unit: 'abandoned' } });
    const claimed = (await queue.claim<{ unit: string }>({ queue: 'supervised' }))[0]!;
    expect(claimed.attempt).toBe(0);
    const deadline = Date.now() + 15_000;
    let again = (await queue.claim<{ unit: string }>({ queue: 'supervised' }))[0];
    while (again === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      again = (await queue.claim<{ unit: string }>({ queue: 'supervised' }))[0];
    }
    // The claim that abandoned it is not the one the queue hands out any more.
    expect(again?.attempt).toBe(1);
    expect(await queue.complete('supervised', claimed)).toBe(false);
  } finally {
    await queue.stop();
    await alone.close();
  }
}, 60_000);
