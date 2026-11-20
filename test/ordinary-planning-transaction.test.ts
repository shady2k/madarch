import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { fixtureOperations } from './fill-operation-fixture.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createOrchestratorSchema, readProgress } from '../src/graph/fill-orchestration.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';
import { admitUnits, createOrchestrator, planRun, startRun, stopHeartbeat, workOnce } from '../src/fill/orchestrator.js';

import { readUnit, readUnitIn } from '../src/graph/fill-state.js';
import { readUnitPlan } from '../src/graph/fill-orchestration.js';
import { unitIdFor } from '../src/fill/orchestrator.js';

test('ordinary planning commits a new unit and its plan together', async () => {
  const owner=await createTestDatabaseOwner();
  let inspect=false,writeTransactions=0;
  const gaps:string[]=[];
  const counting=Object.create(owner) as TestDatabaseOwner;
  counting.transaction=async(kind,work)=>{
    const answer=await owner.transaction(kind,work);
    if(inspect&&kind==='write'){
      writeTransactions++;
      const unit=await readUnit(owner,unitIdFor('source','one'));
      if(unit!==null&&await readUnitPlan(owner,unit.unitId,unit.generation)===null)gaps.push(unit.unitId);
    }
    return answer;
  };
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
    inspect=true;
    expect((await planRun(orchestrator,{runId:'run'})).outcome).toBe('planned');
    inspect=false;
    console.log(JSON.stringify({planningWriteTransactions:writeTransactions,gaps}));
    expect(await readUnitPlan(owner,unitIdFor('source','one'),1)).not.toBeNull();
    expect(gaps).toEqual([]);
  } finally {stopHeartbeat(orchestrator);await queue.stop();await owner.close();}
},30_000);

test('attempt start rolls back its state and progress together, and sinks read committed state', async () => {
  const owner = await createTestDatabaseOwner();
  const unitId = unitIdFor('source', 'one');
  let rejectStart = false;
  const database = Object.create(owner) as TestDatabaseOwner;
  database.transaction = async (kind, work) => await owner.transaction(kind, async tx => {
    const result = await work(tx);
    if (kind === 'write' && rejectStart && (await readUnitIn(tx, unitId))?.state === 'running') {
      rejectStart = false;
      throw new Error('injected start rollback');
    }
    return result;
  });
  await createOrchestratorSchema(database);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const registry = new StageRegistry().register({
    id: 'source', version: 1, consumes: { required: [], optional: [] }, produces: [],
    configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'one', scope: 'one' }], coverage: 'planned' }),
    execute: () => ({ outcome: 'draft' }),
  });
  const observed: string[] = [];
  const orchestrator = createOrchestrator({
    database, registry, queue, queueName: 'fill-units', product: 'snapshot-product',
    configuration: () => undefined,
    snapshot: () => ({ repository: 'example.invalid/product', defaultBranch: 'main', commit: 'abc', registryHash: 'registry' }),
    graph: () => ({ query: async () => [] }), inputs: () => ({ input: 'same' }),
    operations: fixtureOperations(owner),
    sink: async event => {
      if (event.kind !== 'unit-started' && event.kind !== 'unit-planned') return;
      observed.push((await readUnit(owner, unitId))!.state);
      expect((await readProgress(owner, 'run')).some(stored => stored.seq === event.seq && stored.kind === event.kind)).toBe(true);
    },
  });
  try {
    expect((await startRun(orchestrator, { runId: 'run' })).ok).toBe(true);
    expect((await planRun(orchestrator, { runId: 'run' })).outcome).toBe('planned');
    expect((await admitUnits(orchestrator, { runId: 'run' })).admittedNow).toBe(1);
    rejectStart = true;
    await expect(workOnce(orchestrator, { worker: 'worker' })).rejects.toThrow('injected start rollback');
    expect((await readUnit(owner, unitId))!.state).toBe('ready');
    expect((await readProgress(owner, 'run')).filter(event => event.kind === 'unit-started')).toEqual([]);
    expect(observed).toEqual(['planned']);
  } finally { stopHeartbeat(orchestrator); await queue.stop(); await owner.close(); }
}, 30_000);
