import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import type { FillStateDatabase } from '../src/fill/state-store.js';
import {
  FILL_STATE_TABLES,
  FILL_STORE_STEPS,
  advanceChain,
  advanceRun,
  advanceUnit,
  advanceUnitIn,
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
import type { RunEvidence, UnitAdvanceEvent } from '../src/fill/fsm.js';

const NOW = 1_700_000_000_000;
const settled: RunEvidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true, pendingPublications: 0 };

let database: DatabaseOwner;

beforeAll(async () => {
  // The process's one database owner, as the background server lends it: the store borrows the
  // owner's transactions and opens nothing of its own (madarch-tzte.19.1, madarch-tzte.19.5).
  database = createPGliteDatabaseOwner();
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

  test('a plan that resolves no stage is recorded as blocked with its starvation path', async () => {
    await createRun(database, { runId: 'run-starved', product: 'product-run', at: NOW });
    await advanceRun(database, { runId: 'run-starved', event: { type: 'plan', at: NOW + 1, configuration: 'sha256:configuration' } });
    const rejected = await advanceRun(database, { runId: 'run-starved', event: { type: 'start', at: NOW + 2, stages: 0 } });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.refusal.guard).toBe('stage-graph-resolved');
    const blocked = await advanceRun(database, { runId: 'run-starved', event: { type: 'block', at: NOW + 3, starvationPath: 'synthesis → claims → inventory (disabled)' } });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.record.state).toBe('blocked');
    expect(blocked.effects).toEqual(['record-starvation', 'emit-progress']);
    expect((await readTransitions(database, { kind: 'run', id: 'run-starved' })).map((entry) => entry.transitionId))
      .toEqual(['run/created--plan-->planning', 'run/planning--block-->blocked']);
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
    expect(created.runId).toBe('run-unit');
    expect(created.context).toEqual({ generation: 1, attempt: 0, fence: 0, retriesLeft: 2, retryAt: null, replacedBy: null });
    expect(created.lease).toBeNull();

    expect((await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } })).ok).toBe(true);
    const leased = await leaseUnit(database, { unitId, holder: 'worker-a', ttlMs: 60_000, at: NOW + 2 });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    expect(leased.record.lease).toEqual({ attempt: 1, fence: 1, holder: 'worker-a', issuedAt: NOW + 2, expiresAt: NOW + 2 + 60_000, revokedAt: null });
    const started = await advanceUnit(database, { unitId, event: { type: 'start', at: NOW + 3, generation: 1, fence: 1 } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await readUnit(database, unitId)).toEqual(started.record);
    expect(started.record.context.fence).toBe(1);
    expect(started.record.context.attempt).toBe(1);

    const draft = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 4, generation: 1, fence: 1 } });
    expect(draft.ok).toBe(true);
    const validating = await advanceUnit(database, { unitId, event: { type: 'validate-draft', at: NOW + 5, generation: 1, fence: 1 } });
    expect(validating.ok).toBe(true);
    const published = await advanceUnit(database, { unitId, event: { type: 'publish', at: NOW + 6, generation: 1, fence: 1, readsFresh: true } });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.record.state).toBe('published');
    expect(published.record.publishedAt).toBe(NOW + 6);
    expect(published.effects).toEqual(['record-publication', 'emit-progress']);

    const journal = await readTransitions(database, { kind: 'unit', id: unitId });
    expect(journal.map((entry) => entry.transitionId)).toEqual([
      FILL_STORE_STEPS.createUnit,
      'unit/planned--admit-->ready',
      'unit/ready--lease-->leased',
      'unit/leased--start-->running',
      'unit/running--submit-draft-->draft',
      'unit/draft--validate-draft-->validating',
      'unit/validating--publish-->published',
    ]);
    expect(journal.map((entry) => entry.fence)).toEqual([0, 0, 1, 1, 1, 1, 1]);
    expect(journal.map((entry) => entry.generation)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(journal.every((entry) => entry.subjectKind === 'unit' && entry.subjectId === unitId)).toBe(true);
    expect(journal[0]!.from).toBe('(none)');
    expect(journal[0]!.to).toBe('planned');
  });

  test('refuses a late worker holding an older fencing token and writes nothing', async () => {
    const unitId = 'unit-late';
    const running = await runningUnit(unitId);
    const before = await readTransitions(database, { kind: 'unit', id: unitId });

    const late = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 10, generation: 1, fence: 0 } });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.refusal.code).toBe('fill-unit/guard-refused');
    expect(late.refusal.guard).toBe('fence-current');
    expect(late.refusal.reason).toContain('guard "fence-current"');
    expect(late.record.state).toBe('running');
    expect(await readUnit(database, unitId)).toEqual(running);
    expect(await readTransitions(database, { kind: 'unit', id: unitId })).toEqual(before);

    const current = await advanceUnit(database, { unitId, event: { type: 'submit-draft', at: NOW + 11, generation: 1, fence: 1 } });
    expect(current.ok).toBe(true);
  });

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

    const retried = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 6, generation: 1, cause: 'lease-expired', retryAt: NOW + 60_000 } });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.state).toBe('retry_wait');
    expect(retried.record.context.retriesLeft).toBe(1);
    expect(retried.effects).toEqual(['revoke-lease', 'revoke-lease', 'retract-draft', 'schedule-retry', 'emit-progress'].filter((name, index, all) => all.indexOf(name) === index));
    // The revocation is a storage write: the lease in force carries the moment it was revoked.
    expect(retried.record.lease?.revokedAt).toBe(NOW + 6);

    const ready = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 70_000, generation: 1, cause: 'lease-expired', retryAt: NOW + 60_000 } });
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

  test('marks a published generation stale, links its replacement, and opens the next generation above the old token', async () => {
    const unitId = 'unit-stale';
    await publishedUnit(unitId);

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

    const replaced = await replaceStaleGeneration(database, { unitId, runId: 'run-of-unit-stale-2', inputsDigest: 'digest-2', retries: 2, at: NOW + 9 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.transition).toBe(FILL_STORE_STEPS.openGeneration);
    expect(replaced.record.generation).toBe(2);
    expect(replaced.record.state).toBe('planned');
    expect(replaced.record.runId).toBe('run-of-unit-stale-2');
    expect(replaced.record.inputsDigest).toBe('digest-2');
    // The fencing floor is the token the stale generation reached, so no token is reused.
    expect(replaced.record.context).toEqual({ generation: 2, attempt: 0, fence: 1, retriesLeft: 2, retryAt: null, replacedBy: null });

    const generations = await readUnitGenerations(database, unitId);
    expect(generations.map((generation) => [generation.generation, generation.state])).toEqual([[1, 'stale'], [2, 'planned']]);
    expect(generations[0]!.context.replacedBy).toBe(2);
    expect(generations[1]!.runId).toBe('run-of-unit-stale-2');
    expect((await readUnit(database, unitId))?.generation).toBe(2);
    expect((await readTransitions(database, { kind: 'unit', id: unitId })).at(-1)?.transitionId).toBe(FILL_STORE_STEPS.openGeneration);

    const again = await replaceStaleGeneration(database, { unitId, runId: 'run-3', inputsDigest: 'digest-3', retries: 2, at: NOW + 10 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal.code).toBe('fill-store/unit-not-replaceable');
    expect(again.refusal.reason).toContain('is planned');
  });

  test('an unpublished generation whose inputs changed goes stale, and its replacement opens above the token it reached', async () => {
    const unitId = 'unit-planned-stale';
    await createUnit(database, { unitId, product: 'product-planned', runId: 'run-planned', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });

    const stale = await advanceUnit(database, { unitId, event: { type: 'invalidate', at: NOW + 1, replacement: 2, cause: 'the input digest changed before admission' } });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.record.state).toBe('stale');
    expect(stale.record.staleAt).toBe(NOW + 1);
    expect(stale.record.publishedAt).toBeNull();
    expect(stale.record.lease).toBeNull();
    expect(stale.record.context.replacedBy).toBe(2);

    const replaced = await replaceStaleGeneration(database, { unitId, runId: 'run-planned-2', inputsDigest: 'digest-2', retries: 2, at: NOW + 2 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.record.generation).toBe(2);
    expect(replaced.record.state).toBe('planned');
    expect(replaced.record.context.fence).toBe(0);

    expect((await advanceUnit(database, { unitId, event: { type: 'admit', at: NOW + 3, generation: 2 } })).ok).toBe(true);
    const leased = await leaseUnit(database, { unitId, holder: 'worker-a', ttlMs: 60_000, at: NOW + 4 });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    expect(leased.record.lease?.fence).toBe(1);

    const generations = await readUnitGenerations(database, unitId);
    expect(generations.map((generation) => [generation.generation, generation.state, generation.inputsDigest]))
      .toEqual([[1, 'stale', 'digest-1'], [2, 'leased', 'digest-2']]);
    expect((await readTransitions(database, { kind: 'unit', id: unitId })).map((entry) => entry.transitionId)).toEqual([
      FILL_STORE_STEPS.createUnit,
      'unit/planned--invalidate-->stale',
      FILL_STORE_STEPS.openGeneration,
      'unit/planned--admit-->ready',
      'unit/ready--lease-->leased',
    ]);
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

  test('a token of an attempt the unit left cannot fail it while it waits in ready', async () => {
    const unitId = 'unit-ready-fence';
    await runningUnit(unitId);
    await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 5, generation: 1, cause: 'lease-expired', retryAt: NOW + 6 } });
    const ready = await advanceUnit(database, { unitId, event: { type: 'retry', at: NOW + 7, generation: 1, cause: 'lease-expired', retryAt: NOW + 6 } });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.record.state).toBe('ready');
    const before = await readTransitions(database, { kind: 'unit', id: unitId });

    const late = await advanceUnit(database, { unitId, event: { type: 'fail', at: NOW + 8, generation: 1, fence: 0, cause: 'budget-exhausted' } });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.refusal.guard).toBe('fence-current');
    expect((await readUnit(database, unitId))?.state).toBe('ready');
    expect(await readTransitions(database, { kind: 'unit', id: unitId })).toEqual(before);
    // The token in force is the last one the unit issued, so the message that names it goes through.
    const current = await advanceUnit(database, { unitId, event: { type: 'fail', at: NOW + 9, generation: 1, fence: ready.record.context.fence, cause: 'budget-exhausted' } });
    expect(current.ok).toBe(true);
  });

  test('answers a unit its identity already has, instead of raising on the unique key', async () => {
    const identity = { product: 'product-resume', stageId: 'inventory', scopeKey: 'src' };
    const first = await createUnit(database, { unitId: 'unit-resume-a', ...identity, runId: 'run-resume-1', inputsDigest: 'digest-1', retries: 2, at: NOW });
    await advanceUnit(database, { unitId: first.unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } });
    const again = await createUnit(database, { unitId: 'unit-resume-b', ...identity, runId: 'run-resume-2', inputsDigest: 'digest-2', retries: 2, at: NOW + 2 });
    expect(again.unitId).toBe('unit-resume-a');
    expect(again.state).toBe('ready');
    expect(again.inputsDigest).toBe('digest-1');
    expect(again.generation).toBe(1);
    // No second generation and no second creation in the journal: a resume continues the unit it finds.
    expect(await readUnitGenerations(database, 'unit-resume-a')).toHaveLength(1);
    expect((await readTransitions(database, { kind: 'unit', id: 'unit-resume-a' })).map((entry) => entry.transitionId))
      .toEqual([FILL_STORE_STEPS.createUnit, 'unit/planned--admit-->ready']);
    expect(await readUnit(database, 'unit-resume-b')).toBeNull();
  });

  test('a step taken in the caller\'s own transaction rolls back with it', async () => {
    const unitId = 'unit-joined-transaction';
    await createUnit(database, { unitId, product: 'product-joined', runId: 'run-joined', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 1, at: NOW });

    const caught = await expectAsyncError(() => database.transaction('write', async (executor) => {
      const step = await advanceUnitIn(executor, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } });
      expect(step.ok).toBe(true);
      throw new Error('the caller\'s own later step failed');
    }));
    expect(caught.message).toContain('the caller\'s own later step failed');
    // The step joined the caller's transaction: its commit is the caller's, so its failure undid the step.
    expect((await readUnit(database, unitId))?.state).toBe('planned');
    expect(await readTransitions(database, { kind: 'unit', id: unitId })).toHaveLength(1);

    // The same step alone, in the store's own transaction, commits.
    const committed = await database.transaction('write', (executor) => advanceUnitIn(executor, { unitId, event: { type: 'admit', at: NOW + 2, generation: 1 } }));
    expect(committed.ok).toBe(true);
    expect((await readUnit(database, unitId))?.state).toBe('ready');
  });

  test('refuses a step on a unit that does not exist, naming the table and the unit', async () => {
    const caught = await expectAsyncError(() => advanceUnit(database, { unitId: 'unit-missing', event: { type: 'admit', at: NOW, generation: 1 } }));
    expect(caught.message).toContain('table fill_unit: no unit unit-missing');
    expect(caught.message).toMatch(/src\/fill\/state-store\.ts:\d+:\d+:/);
    expect(await readUnit(database, 'unit-missing')).toBeNull();
    expect(await readUnitGenerations(database, 'unit-missing')).toEqual([]);
  });
});

describe('the store keeps its state on disk', () => {
  test('answers every generation and lease after the database is closed and opened again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'madarch-fill-fsm-'));
    const write = async (): Promise<{ unit: unknown; journal: unknown }> => {
      const first = createPGliteDatabaseOwner({ path: directory });
      try {
        await createFillStateSchema(first);
        await createUnit(first, { unitId: 'unit-disk', product: 'product-disk', runId: 'run-disk', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-disk', retries: 1, at: NOW });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'admit', at: NOW + 1, generation: 1 } });
        await leaseUnit(first, { unitId: 'unit-disk', holder: 'worker-disk', ttlMs: 60_000, at: NOW + 2 });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'start', at: NOW + 3, generation: 1, fence: 1 } });
        await advanceUnit(first, { unitId: 'unit-disk', event: { type: 'submit-draft', at: NOW + 4, generation: 1, fence: 1 } });
        await createRun(first, { runId: 'run-disk', product: 'product-disk', at: NOW });
        await openChain(first, { product: 'product-disk', at: NOW });
        return { unit: await readUnit(first, 'unit-disk'), journal: await readTransitions(first, { kind: 'unit', id: 'unit-disk' }) };
      } finally {
        await first.close();
      }
    };
    try {
      const written = await write();
      const second = createPGliteDatabaseOwner({ path: directory });
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
