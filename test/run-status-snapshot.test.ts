import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { fixtureOperations } from './fill-operation-fixture.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createOrchestratorSchema } from '../src/graph/fill-orchestration.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';
import { createOrchestrator, planRun, runStatus, startRun, stopHeartbeat } from '../src/fill/orchestrator.js';

test('run status reads its evidence, units and chain in one snapshot', async () => {
  const owner=await createTestDatabaseOwner();
  let snapshots=0;
  const counting=Object.create(owner) as TestDatabaseOwner;
  counting.transaction=async(kind,work)=>{if(kind==='snapshot')snapshots++;return await owner.transaction(kind,work);};
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
  try {
    expect((await planRun(orchestrator,{runId:'run'})).outcome).toBe('planned');
    snapshots=0;
    const status=await runStatus(orchestrator,'run');
    expect(status?.run.runId).toBe('run');
    expect(status?.evidence).toEqual({runnable:1,inFlight:0,waiting:0,coverageMet:true});
    expect(status?.units).toEqual([{unitId:'source/one',stageId:'source',state:'planned',generation:1,attempts:0,retryAt:null}]);
    expect(status?.chain?.context.activeRunId).toBe('run');
    console.log(JSON.stringify({statusSnapshots:snapshots}));
    expect(snapshots).toBe(1);
    snapshots=0;
    expect(await runStatus(orchestrator,'missing')).toBeNull();
    expect(snapshots).toBe(1);
  } finally {stopHeartbeat(orchestrator);await queue.stop();await owner.close();}
},30_000);
