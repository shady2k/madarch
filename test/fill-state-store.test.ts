import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFillStateDatabase } from './fill-fsm-pglite.js';
import {
  FILL_STATE_TABLES,
  advanceChain,
  advanceRun,
  advanceUnit,
  createFillStateSchema,
  createRun,
  createUnit,
  leaseUnit,
  openChain,
  readChain,
  readRun,
  readTransitions,
  readUnit,
  readUnitGenerations,
  replaceStaleGeneration,
} from '../src/fill/state-store.js';
import type { RunEvidence } from '../src/fill/fsm.js';

const NOW = 1_700_000_000_000;
const settled: RunEvidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true, pendingPublications: 0 };

let database: Awaited<ReturnType<typeof openFillStateDatabase>>;

beforeAll(async () => {
  database = await openFillStateDatabase();
  await createFillStateSchema(database);
});

afterAll(async () => {
  await database.close();
});

/** Drives one unit to a leased, running state under fence 1 and answers the record it reached. */
async function runningUnit(unitId: string) {
  await createUnit(database, { unitId, product: `product-of-${unitId}`, runId: `run-of-${unitId}`, stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });
  const admitted = await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1 } });
  expect(admitted.ok).toBe(true);
  const leased = await leaseUnit(database, { unitId, holder: 'worker-a', ttlMs: 60_000, at: NOW + 2 });
  expect(leased.ok).toBe(true);
  const started = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 3, fence: 1 } });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('the unit did not reach running');
  return started.record;
}

describe('the fill state schema', () => {
  test('creates its six tables and can run again on a database that has them', async () => {
    await createFillStateSchema(database);
    const { rows } = await database.transaction('snapshot', async (executor) => executor.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    ));
    const names = rows.map((row) => row.table_name);
    for (const table of FILL_STATE_TABLES) expect(names).toContain(table);
  });
});

describe('the chain of runs', () => {
  test('opens at idle, walks to active and quiescent, and reads back what it wrote', async () => {
    const opened = await openChain(database, { product: 'product-chain', at: NOW });
    expect(opened.state).toBe('idle');
    expect(opened.context.activeRunId).toBeNull();

    const active = await advanceChain(database, { product: 'product-chain', event: { type: 'start', at: NOW + 1, runId: 'run-a' } });
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.transition).toBe('chain/idle--start-->active');
    expect(active.record.context.activeRunId).toBe('run-a');
    expect(active.effects).toEqual(['emit-progress']);

    const settledChain = await advanceChain(database, { product: 'product-chain', event: { type: 'settle', at: NOW + 2, evidence: { runnable: 0, inFlight: 0, waiting: 0, pendingPublications: 0 } } });
    expect(settledChain.ok).toBe(true);
    if (!settledChain.ok) return;
    expect(settledChain.record.state).toBe('quiescent');
    expect(settledChain.record.context.activeRunId).toBeNull();

    expect(await readChain(database, 'product-chain')).toEqual(settledChain.record);
    expect(await readChain(database, 'product-never-opened')).toBeNull();
    expect((await readTransitions(database, { kind: 'chain', id: 'product-chain' })).map((entry) => entry.transitionId))
      .toEqual(['chain/idle--start-->active', 'chain/active--settle-->quiescent']);
  });

  test('refuses a settle while work is outstanding and writes nothing', async () => {
    await openChain(database, { product: 'product-busy', at: NOW });
    await advanceChain(database, { product: 'product-busy', event: { type: 'start', at: NOW + 1, runId: 'run-a' } });
    const refused = await advanceChain(database, { product: 'product-busy', event: { type: 'settle', at: NOW + 2, evidence: { runnable: 0, inFlight: 0, waiting: 0, pendingPublications: 1 } } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe('fill-chain/guard-refused');
    expect(refused.refusal.guard).toBe('nothing-outstanding');
    expect((await readChain(database, 'product-busy'))?.state).toBe('active');
    expect(await readTransitions(database, { kind: 'chain', id: 'product-busy' })).toHaveLength(1);
  });

  test('an unopened chain cannot be advanced, and the error names the file, the line and the table', async () => {
    let caught: Error | undefined;
    try {
      await advanceChain(database, { product: 'product-missing', event: { type: 'start', at: NOW, runId: 'run-a' } });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('table fill_chain: no chain for product product-missing');
    expect(caught!.message.startsWith(fileURLToPath(new URL('../src/fill/state-store.ts', import.meta.url)))).toBe(true);
    expect(caught!.message).toMatch(/src\/fill\/state-store\.ts:\d+:\d+:/);
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
  test('walks planned → ready → leased → running → draft → validating → published and records each step', async () => {
    const unitId = 'unit-published';
    const created = await createUnit(database, { unitId, product: 'product-unit', runId: 'run-unit', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });
    expect(created.state).toBe('planned');
    expect(created.context).toEqual({ generation: 1, attempt: 0, fence: 0, retriesLeft: 2, retryAt: null, replacedBy: null });
    expect(created.lease).toBeNull();

    expect((await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1 } })).ok).toBe(true);
    const leased = await leaseUnit(database, { unitId, holder: 'worker-a', ttlMs: 60_000, at: NOW + 2 });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    expect(leased.record.lease).toEqual({ attempt: 1, fence: 1, holder: 'worker-a', issuedAt: NOW + 2, expiresAt: NOW + 2 + 60_000, revokedAt: null });
    const started = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 3, fence: 1 } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const running = await readUnit(database, unitId);
    expect(running).toEqual(started.record);
    expect(running?.context.fence).toBe(1);
    expect(running?.context.attempt).toBe(1);

    const draft = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 4, fence: 1, generation: 1 } });
    expect(draft.ok).toBe(true);
    const validating = await advanceUnit(database, { unitId, event: { type: 'validate-draft', at: NOW + 5, fence: 1, generation: 1 } });
    expect(validating.ok).toBe(true);
    const published = await advanceUnit(database, { unitId, event: { type: 'publish', at: NOW + 6, fence: 1, generation: 1, readsFresh: true } });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.record.state).toBe('published');
    expect(published.record.publishedAt).toBe(NOW + 6);
    expect(published.effects).toEqual(['record-publication', 'emit-progress']);

    const journal = await readTransitions(database, { kind: 'unit', id: unitId });
    expect(journal.map((entry) => entry.transitionId)).toEqual([
      'unit/planned--admit-->ready',
      'unit/ready--lease-->leased',
      'unit/leased--start-->running',
      'unit/running--submit-draft-->draft',
      'unit/draft--validate-draft-->validating',
      'unit/validating--publish-->published',
    ]);
    expect(journal.map((entry) => entry.fence)).toEqual([0, 1, 1, 1, 1, 1]);
    expect(journal.map((entry) => entry.generation)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(journal.every((entry) => entry.subjectKind === 'unit' && entry.subjectId === unitId)).toBe(true);
  });

  test('refuses a late worker holding an older fencing token and writes nothing', async () => {
    const unitId = 'unit-late';
    const running = await runningUnit(unitId);
    const before = await readTransitions(database, { kind: 'unit', id: unitId });

    const late = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 10, fence: 0, generation: 1 } });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.refusal.code).toBe('fill-unit/guard-refused');
    expect(late.refusal.guard).toBe('fence-current');
    expect(late.refusal.reason).toContain('guard "fence-current"');
    expect(late.record.state).toBe('running');
    expect(await readUnit(database, unitId)).toEqual(running);
    expect(await readTransitions(database, { kind: 'unit', id: unitId })).toEqual(before);

    const current = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 11, fence: 1, generation: 1 } });
    expect(current.ok).toBe(true);
  });

  test('refuses a second lease while the first stands, and issues a greater token after a retry', async () => {
    const unitId = 'unit-released';
    await runningUnit(unitId);
    const second = await leaseUnit(database, { unitId, holder: 'worker-b', ttlMs: 60_000, at: NOW + 5 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.code).toBe('fill-unit/no-transition');
    expect(second.refusal.reason).toContain('state "running"');

    const retried = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 6, cause: 'lease-expired', retryAt: NOW + 60_000 } });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.state).toBe('retry_wait');
    expect(retried.record.context.retriesLeft).toBe(1);
    expect(retried.effects).toEqual(['revoke-lease', 'schedule-retry', 'emit-progress']);

    const ready = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 70_000, cause: 'lease-expired', retryAt: NOW + 60_000 } });
    expect(ready.ok).toBe(true);
    const released = await leaseUnit(database, { unitId, holder: 'worker-b', ttlMs: 60_000, at: NOW + 80_000 });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.record.context.fence).toBe(2);
    expect(released.record.context.attempt).toBe(2);
    expect(released.record.lease?.fence).toBe(2);

    const oldWorker = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 81_000, fence: 1 } });
    expect(oldWorker.ok).toBe(false);
    if (oldWorker.ok) return;
    expect(oldWorker.refusal.guard).toBe('fence-current');
    const newWorker = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 81_000, fence: 2 } });
    expect(newWorker.ok).toBe(true);
  });

  test('marks a published generation stale, links its replacement and opens the next generation', async () => {
    const unitId = 'unit-stale';
    await runningUnit(unitId);
    await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 4, fence: 1, generation: 1 } });
    await advanceUnit(database, { unitId, event: { type: 'validate-draft', at: NOW + 5, fence: 1, generation: 1 } });
    await advanceUnit(database, { unitId, event: { type: 'publish', at: NOW + 6, fence: 1, generation: 1, readsFresh: true } });

    const cancel = await advanceUnit(database, { unitId, event: { type: 'cancel', at: NOW + 7, cause: 'stop' } });
    expect(cancel.ok).toBe(false);
    if (cancel.ok) return;
    expect(cancel.refusal.code).toBe('fill-unit/no-transition');
    expect(cancel.refusal.reason).toContain('invalidate→stale');

    const stale = await advanceUnit(database, { unitId, event: { type: 'invalidate', at: NOW + 8, replacement: 2, cause: 'the input digest changed' } });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.record.state).toBe('stale');
    expect(stale.record.staleAt).toBe(NOW + 8);
    expect(stale.record.publishedAt).toBe(NOW + 6);
    expect(stale.record.context.replacedBy).toBe(2);

    const replaced = await replaceStaleGeneration(database, { unitId, inputsDigest: 'digest-2', retries: 2, at: NOW + 9 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.transition).toBe('unit/generation--open-->planned');
    expect(replaced.record.generation).toBe(2);
    expect(replaced.record.state).toBe('planned');
    expect(replaced.record.inputsDigest).toBe('digest-2');
    expect(replaced.record.context).toEqual({ generation: 2, attempt: 0, fence: 0, retriesLeft: 2, retryAt: null, replacedBy: null });

    const generations = await readUnitGenerations(database, unitId);
    expect(generations.map((generation) => [generation.generation, generation.state])).toEqual([[1, 'stale'], [2, 'planned']]);
    expect(generations[0]!.context.replacedBy).toBe(2);
    expect((await readUnit(database, unitId))?.generation).toBe(2);

    const again = await replaceStaleGeneration(database, { unitId, inputsDigest: 'digest-3', retries: 2, at: NOW + 10 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal.code).toBe('fill-state/unit-not-replaceable');
    expect(again.refusal.reason).toContain('is planned');
  });

  test('refuses a step on a unit that does not exist, naming the table and the unit', async () => {
    let caught: Error | undefined;
    try {
      await advanceUnit(database, { unitId: 'unit-missing', event: { type: 'admit', at: NOW } });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('table fill_unit: no unit unit-missing');
    expect(caught!.message).toMatch(/src\/fill\/state-store\.ts:\d+:\d+:/);
    expect(await readUnit(database, 'unit-missing')).toBeNull();
    expect(await readUnitGenerations(database, 'unit-missing')).toEqual([]);
  });
});

describe('the store keeps its state on disk', () => {
  test('answers every generation and lease after the database is closed and opened again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'madarch-fill-fsm-'));
    const write = async (): Promise<{ unit: unknown; journal: unknown }> => {
      const first = await openFillStateDatabase(directory);
      try {
        await createFillStateSchema(first);
        await createUnit(first, { unitId: 'unit-disk', product: 'product-disk', runId: 'run-disk', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-disk', retries: 1, at: NOW });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'admit', at: NOW + 1 } });
        await leaseUnit(first, { unitId: 'unit-disk', holder: 'worker-disk', ttlMs: 60_000, at: NOW + 2 });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'start', at: NOW + 3, fence: 1 } });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'submit-draft', at: NOW + 4, fence: 1, generation: 1 } });
        await createRun(first, { runId: 'run-disk', product: 'product-disk', at: NOW });
        await openChain(first, { product: 'product-disk', at: NOW });
        return { unit: await readUnit(first, 'unit-disk'), journal: await readTransitions(first, { kind: 'unit', id: 'unit-disk' }) };
      } finally {
        await first.close();
      }
    };
    try {
      const written = await write();
      const second = await openFillStateDatabase(directory);
      try {
        await createFillStateSchema(second);
        const reopened = await readUnit(second, 'unit-disk');
        expect(reopened).toEqual(written.unit as never);
        expect(reopened?.state).toBe('draft');
        expect(reopened?.context.fence).toBe(1);
        expect(reopened?.lease?.holder).toBe('worker-disk');
        expect(await readTransitions(second, { kind: 'unit', id: 'unit-disk' })).toEqual(written.journal as never);
        expect((await readChain(second, 'product-disk'))?.state).toBe('idle');
        expect((await readRun(second, 'run-disk'))?.state).toBe('created');
      } finally {
        await second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
