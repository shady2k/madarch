import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { fixtureOperations } from './fill-operation-fixture.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createOrchestratorSchema } from '../src/graph/fill-orchestration.js';
import { advanceUnit, readRunUnits } from '../src/graph/fill-state.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';
import { createOrchestrator, planRun, schedulerPass, startRun, stopHeartbeat } from '../src/fill/orchestrator.js';

async function fixture() {
  const owner = await createTestDatabaseOwner();
  let membershipReads = 0;
  const counting = Object.create(owner) as TestDatabaseOwner;
  counting.transaction = async (kind, work) => await owner.transaction(kind, async tx => {
    let runMembership = false;
    return await work({
      query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (values?.[0] === 'system.unit-run' && sql.includes('e.to_node=ANY')) runMembership = true;
        if (sql.includes('SELECT DISTINCT n.id')) runMembership = false;
        if (kind === 'snapshot' && runMembership && values?.[0] === 'system.unit-replacement') membershipReads += 1;
        return await tx.query<Row>(sql, values);
      },
    });
  });
  await createOrchestratorSchema(counting);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const registry = new StageRegistry().register({
    id: 'source', version: 1, consumes: { required: [], optional: [] }, produces: [],
    configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'one', scope: 'one' }], coverage: 'planned' }),
    execute: () => ({ outcome: 'draft' }),
  });
  const orchestrator = createOrchestrator({
    database: counting, registry, queue, queueName: 'fill-units', product: 'snapshot-product',
    configuration: () => undefined,
    snapshot: () => ({ repository: 'example.invalid/product', defaultBranch: 'main', commit: 'abc', registryHash: 'registry' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({ input: 'same' }),
    operations: fixtureOperations(owner),
  });
  expect((await startRun(orchestrator, { runId: 'run' })).ok).toBe(true);
  expect((await planRun(orchestrator, { runId: 'run' })).outcome).toBe('planned');
  await schedulerPass(orchestrator, { runId: 'run' });
  stopHeartbeat(orchestrator);
  return { owner, orchestrator, queue, reads: () => membershipReads, reset: () => { membershipReads = 0; },
    close: async () => { stopHeartbeat(orchestrator); await queue.stop(); await owner.close(); } };
}

test('an unchanged busy pass materializes run units once, with no cache across passes', async () => {
  const opened = await fixture();
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      opened.reset();
      const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
      expect(result.settlement.outcome).toBe('waiting');
      expect(result.units).toBe(1);
      expect(opened.reads()).toBe(1);
    }
  } finally { await opened.close(); }
}, 30_000);

test('a worker write during a pass is visible at the next checkpoint', async () => {
  const opened = await fixture();
  try {
    let changed = false;
    const enqueue = opened.queue.enqueue.bind(opened.queue);
    opened.queue.enqueue = async request => {
      const answer = await enqueue(request);
      if (!changed) {
        changed = true;
        expect((await advanceUnit(opened.owner, { unitId: 'source/one', event: { type: 'cancel', at: Date.now(), cause: 'external worker' } })).ok).toBe(true);
      }
      return answer;
    };
    opened.reset();
    const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
    expect(changed).toBe(true);
    expect(result.settlement.evidence.runnable).toBe(0);
    expect(result.run.state).toBe('failed');
    expect((await readRunUnits(opened.owner, 'run'))[0]?.state).toBe('cancelled');
  } finally { await opened.close(); }
}, 30_000);
