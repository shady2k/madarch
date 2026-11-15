import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillStateSchema } from '../src/adapters/schemas/fill-state.js';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import type { FillStateDatabase } from '../src/fill/state-store.js';
import { FILL_STATE_TABLES, readStoreStamp, hasSuccessfulFill, advanceChain, advanceRun, advanceUnit, createFillStateSchema, createRun, createUnit, readRun, readUnit, replaceStaleGeneration } from '../src/fill/state-store.js';
import type { RunEvidence } from '../src/fill/fsm.js';
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

/** One run of one unit, in `running`: a unit belongs to a run, and a unit write refuses a run that ended. */
async function runOf(unitId: string, runId = `run-of-${unitId}`): Promise<string> {
  await createRun(database, { runId, product: `product-of-${unitId}`, at: NOW - 2 });
  await advanceRun(database, { runId, event: { type: 'plan', at: NOW - 1, configuration: 'fixture' } });
  await advanceRun(database, { runId, event: { type: 'start', at: NOW, stages: 1 } });
  return runId;
}

/** Drives one unit into its first running attempt, as the queue's claim hands it out, and answers the record. */
async function runningUnit(unitId: string) {
  await runOf(unitId);
  await createUnit(database, { unitId, product: `product-of-${unitId}`, runId: `run-of-${unitId}`, stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', at: NOW });
  const admitted = await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } });
  expect(admitted.ok).toBe(true);
  const started = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 3, generation: 1, attempt: 1 } });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('the unit did not reach running');
  return started.record;
}

async function publishedUnit(unitId: string) {
  await runningUnit(unitId);
  const published = await advanceUnit(database, { unitId, event: { type: 'publish', at: NOW + 6, generation: 1, outcome: { plugin: 'fixture', kind: 'src', outcome: 'empty', produced: 0 } } });
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
  test('creates exactly its five tables, and can run again on a database that has them', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-state-schema-'));
    const owner = await createDatabaseOwner({ store: folder });
    try {
      await fillStateSchema.prepare(owner);
      await fillStateSchema.prepare(owner);
      const { rows } = await owner.transaction('snapshot', async (executor) => executor.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      ));
      const names = rows.map((row) => row.table_name);
      // A dedicated unprepared store tests this schema alone, not all schemas the shared fixture prepares.
      expect(names).toEqual([...FILL_STATE_TABLES].sort());
    } finally {
      await owner.close();
      rmSync(folder, { recursive: true, force: true });
    }
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
  test('records the attempt the queue hands it out as, and refuses an attempt the generation already passed', async () => {
    const unitId = 'unit-attempts';
    const running = await runningUnit(unitId);
    expect(running.state).toBe('running');
    expect(running.context.attempt).toBe(1);
    // A duplicate delivery of the attempt in force is no second step of it.
    const duplicate = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 4, generation: 1, attempt: 1 } });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.refusal.guard).toBe('attempt-advances');
    // A claim the queue hands out again is the generation's next attempt.
    const again = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 5, generation: 1, attempt: 2 } });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.context.attempt).toBe(2);
    expect((await readUnit(database, unitId))?.context.attempt).toBe(2);
  });

  test('a retry sends the generation to its retry wait, and the queue\'s next attempt starts it again', async () => {
    const unitId = 'unit-retried';
    await runningUnit(unitId);
    const retried = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 6, generation: 1, cause: 'transient-failure', retryAt: NOW + 60_000 } });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.state).toBe('retry_wait');
    expect(retried.record.context.retryAt).toBe(NOW + 60_000);
    expect(retried.effects).toEqual(['schedule-retry', 'emit-progress']);
    const again = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 70_000, generation: 1, attempt: 2 } });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.state).toBe('running');
    expect(again.record.context.attempt).toBe(2);
    expect(again.record.context.retryAt).toBeNull();
  });

  test('a message for the replaced generation is refused, whatever attempt it names', async () => {
    const unitId = 'unit-replaced';
    await publishedUnit(unitId);
    await advanceUnit(database, { unitId, event: { type: 'invalidate', at: NOW + 7, replacement: 2, cause: 'inputs changed' } });
    const replaced = await replaceStaleGeneration(database, { unitId, runId: 'run-2', inputsDigest: 'digest-2', at: NOW + 8 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const admitted = await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 9, generation: 2 } });
    expect(admitted.ok).toBe(true);
    // A message for the replaced generation is refused, whatever attempt it names.
    const oldGeneration = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 14, generation: 1, attempt: 2 } });
    expect(oldGeneration.ok).toBe(false);
    if (oldGeneration.ok) return;
    expect(oldGeneration.refusal.guard).toBe('generation-current');
    expect((await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 15, generation: 2, attempt: 1 } })).ok).toBe(true);
  });

  test('a failure keeps what the generation wrote: nothing is retracted when a generation fails', async () => {
    const unitId = 'unit-failed-keeps';
    await runningUnit(unitId);
    const failed = await advanceUnit(database, { unitId, event: { type: 'fail', at: NOW + 7, generation: 1, cause: 'retries-exhausted' } });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    // The machine's only effects on a failure are the authority's revocation and the progress event.
    expect(failed.effects).toEqual(['revoke-authority', 'emit-progress']);
  });
});

describe('the store keeps its state on disk', () => {
  });

describe('a stored record that does not hold the shape its guards read', () => {
  test('is refused, naming the table and the row, instead of stepping on undefined numbers', async () => {
    const unitId = 'unit-corrupt';
    await runOf(unitId, 'run-corrupt');
    await createUnit(database, { unitId, product: 'product-corrupt', runId: 'run-corrupt', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-corrupt', at: NOW });
    await database.transaction('write', async (executor) => {
      await executor.query("UPDATE fill_unit_generation SET context = '{\"attempt\": \"one\"}'::jsonb WHERE unit_id = $1", [unitId]);
      await executor.query("UPDATE fill_run SET context = '{\"planningEpoch\": 1}'::jsonb WHERE run_id = $1", ['run-corrupt']);
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
    expect(caught.message).toContain('advanceUnit(unit-a, admit) failed on fill_unit, fill_unit_generation, fill_transition: boom: connection closed');
    expect(caught.message.startsWith(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url)))).toBe(true);
    // The line is the operation's own, not the shared wrapper's: it is where the operation
    // took its site, inside advanceUnit.
    const line = Number(/state-store\.ts:(\d+):\d+:/.exec(caught.message)![1]);
    const source = await Bun.file(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url))).text();
    expect(source.split('\n')[line - 1]).toContain('here()');
  });
});

test('a repository-free fill completion invalidates the store revision without another graph publication', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createFillStateSchema(owner);
    const before = await readStoreStamp(owner);
    await createRun(owner, { runId: 'repository-free', product: 'empty-product', at: NOW });
    expect(await readStoreStamp(owner)).toBe(before);
    expect(await hasSuccessfulFill(owner)).toBe(false);
    // A fill can finish after its final publication. No node, operation or publication changes here.
    await owner.run((tx) => tx.query("UPDATE fill_run SET state = 'succeeded' WHERE run_id = $1", ['repository-free']));
    expect(await hasSuccessfulFill(owner)).toBe(true);
    const after = await readStoreStamp(owner);
    expect(after).not.toBe(before);
    expect(await readStoreStamp(owner)).toBe(after);
  } finally { await owner.close(); }
});
