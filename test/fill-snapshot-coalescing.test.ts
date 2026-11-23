import { expect, spyOn, test } from 'bun:test';
import { Type } from 'typebox';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createOrchestrator, admitUnits, planRun, schedulerPass, startRun, stopHeartbeat, sweepUnits } from '../src/fill/orchestrator.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import * as fillState from '../src/graph/fill-state.js';
import { createTestDatabaseOwner } from './test-database.js';
import { fixtureOperations } from './fill-operation-fixture.js';

async function openReadyRun() {
  const owner = await createTestDatabaseOwner();
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', singletons: true, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
  const stage: FillStage = {
    id: 'probe', version: 1, defaults: DEFAULT_STAGE_DEFAULTS, configSchema: Type.Object({}),
    consumes: { required: [], optional: [] }, produces: [],
    plan: async () => ({ units: [{ id: 'one', scope: 'one' }], coverage: 'planned' }),
    execute: async () => ({ outcome: 'draft' }),
  };
  const registry = new StageRegistry();
  registry.register(stage);
  const orchestrator = createOrchestrator({
    database: owner, queue, queueName: 'fill-units', product: 'snapshot-fixture', registry,
    configuration: () => undefined,
    snapshot: () => ({ repository: 'fixture', defaultBranch: 'main', commit: 'abc', registryHash: 'hash' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({}), operations: fixtureOperations(owner),
  });
  const options = { runId: 'snapshot-run' };
  await startRun(orchestrator, options);
  await planRun(orchestrator, options);
  await admitUnits(orchestrator, options);
  return { owner, queue, orchestrator, options, close: async () => {
    stopHeartbeat(orchestrator);
    await queue.stop();
    await owner.close();
  } };
}

test('sweep reads one snapshot for run and units and keeps ready jobs idempotent', async () => {
  const world = await openReadyRun();
  try {
    let reads = 0;
    const state = async () => {
      reads++;
      return await fillState.readRunStateSnapshot(world.owner, world.options.runId);
    };
    const result = await sweepUnits(world.orchestrator, world.options, state);
    expect(result).toEqual({ swept: [], refused: [] });
    const jobs = await world.queue.claim({ queue: 'fill-units', limit: 2 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ unitId: 'probe/one', generation: 1 });
    expect((await fillState.readRunUnits(world.owner, world.options.runId)).map(unit => unit.state)).toEqual(['ready']);
    expect(reads).toBe(1);
  } finally {
    await world.close();
  }
});

test('scheduler reuses its initial timing snapshot but refreshes for the sweep', async () => {
  const world = await openReadyRun();
  const snapshots = spyOn(fillState, 'readRunStateSnapshot');
  const enqueue = world.queue.enqueue.bind(world.queue);
  let readsAtSweepOffer: number | undefined;
  const offer = spyOn(world.queue, 'enqueue').mockImplementation(async request => {
    readsAtSweepOffer ??= snapshots.mock.calls.length;
    return await enqueue(request);
  });
  try {
    const result = await schedulerPass(world.orchestrator, world.options);
    expect(result.run.state).toBe('running');
    expect(result.units).toBe(1);
    expect(result.swept).toBe(0);
    expect(result.admitted).toBe(0);
    expect(result.refused).toEqual([]);
    expect((await fillState.readRunUnits(world.owner, world.options.runId)).map(unit => unit.state)).toEqual(['ready']);
    // Initial pass read, then a fresh sweep read; neither the timing count nor
    // the sweep's units need another snapshot before the queue offer.
    expect(readsAtSweepOffer).toBe(2);
  } finally {
    snapshots.mockRestore();
    offer.mockRestore();
    await world.close();
  }
});
