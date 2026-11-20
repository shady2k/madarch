import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, advanceRun, readRun, readRunUnits } from '../src/graph/fill-state.js';
import { writeOrchestration, recordUnitPlanIn, readProgress } from '../src/graph/fill-orchestration.js';
import { createUnit } from './fill-unit-fixture.js';
import { readFillRunDetail } from '../src/knowledge/fill-runs.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createOrchestrator, planRun, schedulerPass, workOnce } from '../src/fill/orchestrator.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { fixtureOperations, writeFixtureFact } from './fill-operation-fixture.js';
let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>;
beforeAll(async () => { owner = await createTestDatabaseOwner(); });
afterAll(async () => { await owner?.close(); });
test('paused Stop after worker exit uses canonical cancellation without loading product files or plugins', async () => {
  await createRun(owner, { runId: 'paused-run', product: 'shop', at: 7000, selection: { selected: ['doc.term'], order: ['doc.term'], groups: [{ kind: 'doc.term', group: null, plugin: 'fixture', stageUnitId: 'fixture-stage' }] } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'plan', at: 7001, configuration: 'fixture' } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'start', at: 7002, stages: 1 } });
  await createUnit(owner, { unitId: 'paused-unfinished', product: 'shop', runId: 'paused-run', stageId: 'fixture-stage', scopeKey: 'fixture', inputsDigest: 'fixture', retries: 0, at: 7003 });
  await writeOrchestration(owner, tx => recordUnitPlanIn(tx, { runId: 'paused-run', unitId: 'paused-unfinished', generation: 1, stageId: 'fixture-stage', stageUnitId: 'fixture-stage', scope: 'fixture', stagePosition: 0, planPosition: 0, at: 7003 }));
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'pause', at: 7004 } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'drain', at: 7005, evidence: { runnable: 1, inFlight: 0, waiting: 0, coverageMet: true } } });
  expect((await readRun(owner, 'paused-run'))?.state).toBe('paused');
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, { listeners: new Set(), revision: 0, open: async () => owner, product: () => ({ name: 'shop' }) });
  let domainReads = 0;
  Object.assign(product, {
    fillDatabase: async () => { domainReads += 1; return owner; },
    manifestRead: async () => { throw new Error('paused Stop must not load product files'); },
  });
  expect(await product.controlFillRun('paused-run', 'stop')).toMatchObject({ ok: true, runId: 'paused-run' });
  expect(domainReads).toBe(1);
  expect((await readRun(owner, 'paused-run'))?.state).toBe('cancelled');
  expect((await readRunUnits(owner, 'paused-run'))[0]?.state).toBe('cancelled');
  const detail = await readFillRunDetail(owner, 'paused-run', { now: Date.now() });
  expect(detail?.events.map((event) => event.type)).toContain('run-cancelled');
  expect(detail?.remainingMs).toBeNull();
  expect(detail).toMatchObject({ phase: 'stopped', final: true, groups: [{ state: 'cancelled', phase: 'cancelled' }] });
});


test('a start refused after re-planning is journalled before the sink sees it', async () => {
  const queue = await createPgBossQueue({ owner, supervise: false });
  try {
    const registry = new StageRegistry();
    let cancelDuringPlanning = false;
    registry.register({
      id: 'producer', version: 1, consumes: { required: [], optional: [] },
      produces: [{ kind: 'facts', schemaVersion: 1, scope: 'repository' }],
      configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
      plan: () => ({ units: [{ id: 'one', scope: 'one' }], coverage: 'planned' }),
      execute: async (_unit, context) => {
        await writeFixtureFact(context, 'fact', { kind: 'facts' });
        return { outcome: 'draft' };
      },
    });
    registry.register({
      id: 'empty', version: 1, consumes: { required: [{ capability: 'facts', scope: 'repository' }], optional: [] }, produces: [],
      configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
      plan: async () => {
        if (cancelDuringPlanning) {
          expect((await advanceRun(owner, { runId: 'refused-start', event: { type: 'cancel', at: 20, cause: 'concurrent stop' } })).ok).toBe(true);
        }
        return { units: [], coverage: 'planned' };
      },
      execute: () => ({ outcome: 'draft' }),
    });
    await queue.declare({ name: 'fill-units', leaseSeconds: 60, heartbeatSeconds: 10, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
    const delivered: string[] = [];
    const orchestrator = createOrchestrator({
      database: owner, registry, queue, queueName: 'fill-units', product: 'shop',
      configuration: () => undefined,
      snapshot: () => ({ repository: 'example.com/shop', defaultBranch: 'main', commit: 'abc', registryHash: 'fixture' }),
      graph: () => ({ query: async () => [] }), inputs: () => ({}), operations: fixtureOperations(owner), clock: () => 10,
      sink: async event => {
        if (event.kind === 'run-refused') {
          const stored = await readProgress(owner, 'refused-start');
          expect(stored.some(row => row.seq === event.seq)).toBe(true);
          delivered.push(event.kind);
        }
      },
    });
    await createRun(owner, { runId: 'refused-start', product: 'shop', at: 1 });
    expect((await planRun(orchestrator, { runId: 'refused-start' })).outcome).toBe('planned');
    await schedulerPass(orchestrator, { runId: 'refused-start' });
    expect((await workOnce(orchestrator, { worker: 'fixture' })).claimed).toBe(true);
    cancelDuringPlanning = true;
    const result = await schedulerPass(orchestrator, { runId: 'refused-start' });
    expect(result.refused.length).toBeGreaterThan(0);
    expect((await readProgress(owner, 'refused-start')).filter(event => event.kind === 'run-refused')).toHaveLength(1);
    expect(delivered).toEqual(['run-refused']);
  } finally {
    await queue.stop();
  }
});
