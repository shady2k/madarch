import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import type { FillStateDatabase } from '../src/fill/state-store.js';
import { FILL_STATE_TABLES, advanceChain, advanceRun, advanceUnit, createFillStateSchema, createRun, createUnit, leaseUnit, readRun, readUnit, replaceStaleGeneration } from '../src/fill/state-store.js';
import type { RunEvidence, UnitAdvanceEvent } from '../src/fill/fsm.js';
import { createTestDatabaseOwner } from './test-database.js';

const NOW = 1_700_000_000_000;
const settled: RunEvidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true, pendingPublications: 0 };

let database: DatabaseOwner;

beforeAll(async () => {
  // The process's one database owner, as the background server lends it: the store borrows the
  // owner's transactions and opens nothing of its own (madarch-tzte.19.1, madarch-tzte.19.5).
  database = await createTestDatabaseOwner();
  await createFillStateSchema(database);
});

afterAll(async () => {
  await database.close();
});

/** Drives one unit to a leased, running state under fence 1 and answers the record it reached. */
async function runningUnit(unitId: string) {
  await createUnit(database, { unitId, product: `product-of-${unitId}`, runId: `run-of-${unitId}`, stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });
  const admitted = await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } });
  expect(admitted.ok).toBe(true);
  const leased = await leaseUnit(database, { unitId, holder: 'worker-a', ttlMs: 60_000, at: NOW + 2 });
  expect(leased.ok).toBe(true);
  const started = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 3, generation: 1, fence: 1 } });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('the unit did not reach running');
  return started.record;
}

async function publishedUnit(unitId: string) {
  await runningUnit(unitId);
  await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 4, generation: 1, fence: 1 } });
  await advanceUnit(database, { unitId, event: { type: 'validate-draft', at: NOW + 5, generation: 1, fence: 1 } });
  const published = await advanceUnit(database, { unitId, event: { type: 'publish', at: NOW + 6, generation: 1, fence: 1, readsFresh: true } });
  expect(published.ok).toBe(true);
}

async function expectAsyncError(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to raise');
}

describe('the fill state schema', () => {
  test('creates exactly its six tables, and can run again on a database that has them', async () => {
    await createFillStateSchema(database);
    const { rows } = await database.transaction('snapshot', async (executor) => executor.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    ));
    const names = rows.map((row) => row.table_name);
    // Exactly `FILL_STATE_TABLES` and nothing else: a state-machine step that wrote a row anywhere else
    // — a page, a draft, a git object's bookkeeping — would show up here as a seventh table.
    expect(names).toEqual([...FILL_STATE_TABLES].sort());
  });
});

describe('the chain of runs', () => {
  
  
  test('an unopened chain cannot be advanced, and the error names the file, the line and the table', async () => {
    const caught = await expectAsyncError(() => advanceChain(database, { product: 'product-missing', event: { type: 'start', at: NOW, runId: 'run-a' } }));
    expect(caught.message).toContain('table fill_chain: no chain for product product-missing');
    expect(caught.message.startsWith(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url)))).toBe(true);
    expect(caught.message).toMatch(/src\/fill\/state-store\.ts:\d+:\d+:/);
  });
});

describe('a fill run', () => {
  test('walks created → planning → running → succeeded with what it observed and what it recorded', async () => {
    const created = await createRun(database, { runId: 'run-completed', product: 'product-run', at: NOW });
    expect(created.state).toBe('created');
    expect(created.context).toEqual({ planningEpoch: 0, planningClosed: false });

    const planned = await advanceRun(database, { runId: 'run-completed', event: { type: 'plan', at: NOW + 1, configuration: 'sha256:configuration' } });
    expect(planned.ok).toBe(true);
    const started = await advanceRun(database, { runId: 'run-completed', event: { type: 'start', at: NOW + 2, stages: 3 } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.state).toBe('running');
    expect(started.record.context).toEqual({ planningEpoch: 1, planningClosed: true });

    const completed = await advanceRun(database, { runId: 'run-completed', event: { type: 'complete', at: NOW + 3, evidence: settled } });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.record.state).toBe('succeeded');
    expect(completed.effects).toEqual(['record-completion', 'emit-progress']);
    expect(await readRun(database, 'run-completed')).toEqual(completed.record);
  });

  test('refuses completion while a unit is still runnable, naming the guard', async () => {
    await createRun(database, { runId: 'run-refused', product: 'product-run', at: NOW });
    await advanceRun(database, { runId: 'run-refused', event: { type: 'plan', at: NOW + 1, configuration: 'sha256:configuration' } });
    await advanceRun(database, { runId: 'run-refused', event: { type: 'start', at: NOW + 2, stages: 1 } });
    const refused = await advanceRun(database, { runId: 'run-refused', event: { type: 'complete', at: NOW + 3, evidence: { ...settled, runnable: 2 } } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe('fill-run/guard-refused');
    expect(refused.refusal.guard).toBe('nothing-runnable-in-flight-or-waiting');
    expect((await readRun(database, 'run-refused'))?.state).toBe('running');
  });

  
  test('cancels through cancelling, and a run that ended stays ended', async () => {
    await createRun(database, { runId: 'run-cancelled', product: 'product-run', at: NOW });
    await advanceRun(database, { runId: 'run-cancelled', event: { type: 'plan', at: NOW + 1, configuration: 'sha256:configuration' } });
    await advanceRun(database, { runId: 'run-cancelled', event: { type: 'start', at: NOW + 2, stages: 1 } });
    const cancelling = await advanceRun(database, { runId: 'run-cancelled', event: { type: 'cancel', at: NOW + 3, cause: 'the person stopped the run' } });
    expect(cancelling.ok).toBe(true);
    if (!cancelling.ok) return;
    expect(cancelling.record.state).toBe('cancelling');
    expect(cancelling.effects).toEqual(['revoke-run-authority', 'record-cancel-intent', 'emit-progress']);
    const cancelled = await advanceRun(database, { runId: 'run-cancelled', event: { type: 'drained', at: NOW + 4, evidence: settled } });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.record.state).toBe('cancelled');

    const tooLate = await advanceRun(database, { runId: 'run-cancelled', event: { type: 'cancel', at: NOW + 5, cause: 'again' } });
    expect(tooLate.ok).toBe(false);
    if (tooLate.ok) return;
    expect(tooLate.refusal.code).toBe('fill-run/no-transition');
    expect(tooLate.refusal.reason).toContain('event "cancel"');
    expect(await readRun(database, 'run-cancelled')).toEqual(cancelled.record);
    expect(await readRun(database, 'run-never-created')).toBeNull();
  });
});

describe('a unit generation', () => {
  
  
  test('refuses a lease event handed to advanceUnit, so no lease hides outside the lease row', async () => {
    const unitId = 'unit-lease-bypass';
    await createUnit(database, { unitId, product: 'product-unit', runId: 'run-unit', stageId: 'inventory', scopeKey: `src/${unitId}`, inputsDigest: 'digest-1', retries: 1, at: NOW });
    await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } });
    // Typed out of `advanceUnit`'s events on purpose: a JavaScript caller can still send it.
    const refused = await advanceUnit(database, { unitId, event: { type: 'lease', at: NOW + 2, fence: 7, attempt: 9 } as unknown as UnitAdvanceEvent });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe('fill-store/lease-not-advanced');
    expect(refused.refusal.reason).toContain('leaseUnit takes it');
    const record = await readUnit(database, unitId);
    expect(record?.state).toBe('ready');
    expect(record?.context.fence).toBe(0);
    expect(record?.lease).toBeNull();
  });

  test('refuses a second lease while the first stands, and issues a greater token after a retry', async () => {
    const unitId = 'unit-released';
    await runningUnit(unitId);
    const second = await leaseUnit(database, { unitId, holder: 'worker-b', ttlMs: 60_000, at: NOW + 5 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.code).toBe('fill-unit/no-transition');
    expect(second.refusal.reason).toContain('state "running"');

    const retried = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 6, generation: 1, cause: 'lease-expired', retryAt: NOW + 60_000, fence: null } });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.state).toBe('retry_wait');
    expect(retried.record.context.retriesLeft).toBe(1);
    expect(retried.effects).toEqual(['revoke-lease', 'revoke-lease', 'retract-draft', 'schedule-retry', 'emit-progress'].filter((name, index, all) => all.indexOf(name) === index));
    // The revocation is a storage write: the lease in force carries the moment it was revoked.
    expect(retried.record.lease?.revokedAt).toBe(NOW + 6);

    const ready = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 70_000, generation: 1, cause: 'lease-expired', retryAt: NOW + 60_000, fence: null } });
    expect(ready.ok).toBe(true);
    const released = await leaseUnit(database, { unitId, holder: 'worker-b', ttlMs: 60_000, at: NOW + 80_000 });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.record.context.fence).toBe(2);
    expect(released.record.context.attempt).toBe(2);
    expect(released.record.lease?.fence).toBe(2);
    expect(released.record.lease?.revokedAt).toBeNull();

    const oldWorker = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 81_000, generation: 1, fence: 1 } });
    expect(oldWorker.ok).toBe(false);
    if (oldWorker.ok) return;
    expect(oldWorker.refusal.guard).toBe('fence-current');
    const newWorker = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 81_000, generation: 1, fence: 2 } });
    expect(newWorker.ok).toBe(true);
  });

  
  
  test('a token of the replaced generation cannot start, block or fail the generation that replaced it', async () => {
    const unitId = 'unit-replaced-fence';
    await publishedUnit(unitId);
    await advanceUnit(database, { unitId, event: { type: 'invalidate', at: NOW + 7, replacement: 2, cause: 'inputs changed' } });
    const replaced = await replaceStaleGeneration(database, { unitId, runId: 'run-2', inputsDigest: 'digest-2', retries: 2, at: NOW + 8 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const admitted = await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 9, generation: 2 } });
    expect(admitted.ok).toBe(true);
    const leased = await leaseUnit(database, { unitId, holder: 'worker-new', ttlMs: 60_000, at: NOW + 10 });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const newFence = leased.record.context.fence;
    expect(newFence).toBe(2);

    for (const event of [
      { type: 'start', at: NOW + 11, generation: 2, fence: 1 },
      { type: 'block', at: NOW + 12, generation: 2, fence: 1, reason: 'late' },
      { type: 'fail', at: NOW + 13, generation: 2, fence: 1, cause: 'budget-exhausted' },
    ] as const) {
      const refused = await advanceUnit(database, { unitId, event });
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.guard).toBe('fence-current');
    }
    // A message for the replaced generation is refused too, whatever token it names.
    const oldGeneration = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 14, generation: 1, fence: newFence } });
    expect(oldGeneration.ok).toBe(false);
    if (oldGeneration.ok) return;
    expect(oldGeneration.refusal.guard).toBe('generation-current');
    expect((await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 15, generation: 2, fence: newFence } })).ok).toBe(true);
  });

  
  
  
  });

describe('the store keeps its state on disk', () => {
  });

describe('a stored record that does not hold the shape its guards read', () => {
  test('is refused, naming the table and the row, instead of stepping on undefined numbers', async () => {
    const unitId = 'unit-corrupt';
    await createUnit(database, { unitId, product: 'product-corrupt', runId: 'run-corrupt', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-corrupt', retries: 1, at: NOW });
    await database.transaction('write', async (executor) => {
      await executor.query("UPDATE fill_unit_generation SET context = '{\"attempt\": \"one\"}'::jsonb WHERE unit_id = $1", [unitId]);
      await executor.query('INSERT INTO fill_run (run_id, product, state, context, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)',
        ['run-corrupt', 'product-corrupt', 'running', '{"planningEpoch": 1}', NOW]);
    });

    const unitFailure = await expectAsyncError(() => readUnit(database, unitId));
    expect(unitFailure.message).toContain(`table fill_unit_generation, row ${unitId}/1: attempt is not a whole number of attempts`);
    expect(unitFailure.message).toMatch(/src\/fill\/state-store\.ts:\d+:\d+:/);

    const runFailure = await expectAsyncError(() => readRun(database, 'run-corrupt'));
    expect(runFailure.message).toContain('table fill_run, row run-corrupt: planningClosed is not a boolean');
  });

});

describe('a failure of the borrowed database', () => {
  test('names the operation and the tables it touched, at the operation\'s own line', async () => {
    const failing: FillStateDatabase = {
      transaction: async () => {
        throw new Error('boom: connection closed');
      },
    };
    const caught = await expectAsyncError(() => advanceUnit(failing, { unitId: 'unit-a', event: { type: 'admit', at: NOW, generation: 1 } }));
    expect(caught.message).toContain('advanceUnit(unit-a, admit) failed on fill_unit, fill_unit_generation, fill_unit_lease, fill_transition: boom: connection closed');
    expect(caught.message.startsWith(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url)))).toBe(true);
    // The line is the operation's own, not the shared wrapper's: it is where the operation
    // took its site, inside advanceUnit.
    const line = Number(/state-store\.ts:(\d+):\d+:/.exec(caught.message)![1]);
    const source = await Bun.file(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url))).text();
    expect(source.split('\n')[line - 1]).toContain('here()');
  });
});
