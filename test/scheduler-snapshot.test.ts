import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { fixtureOperations } from './fill-operation-fixture.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { writeOrchestration, createOrchestratorSchema } from '../src/graph/fill-orchestration.js';
import { advanceUnitIn, createRun, fillEdge, putFillVertexIn, readRunGraphUidIn, readRunStateSnapshot, readRunUnits, readUnitGraphUidIn } from '../src/graph/fill-state.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS } from '../src/fill/stage.js';
import { createOrchestrator, planRun, runEvidence, schedulerPass, startRun, stopHeartbeat } from '../src/fill/orchestrator.js';
import { assertionValueTableName } from '../src/graph/contract.js';

async function fixture(count = 1) {
  const owner = await createTestDatabaseOwner();
  let statements = 0;
  // What the pass resolves by name, and what it reads of the engine's own vertices. A name lookup is
  // the value-table walk to a subject; a service read is the assertion selection of one of those kinds.
  let nameLookups = 0;
  let unitReads = 0;
  let runReads = 0;
  const unitStateTable = assertionValueTableName('system.unit', 'vertex', 'state');
  const runStateTable = assertionValueTableName('system.run', 'vertex', 'state');
  let membershipReads = 0;
  let snapshotTransactions = 0;
  let settlementStampReads = 0;
  let settlementEvidenceReads = 0;
  const counting = Object.create(owner) as TestDatabaseOwner;
  let afterSettlementSnapshot: (() => Promise<void>) | undefined;
  let beforeNextSnapshot: (() => Promise<void>) | undefined;
  counting.transaction = async (kind, work) => {
    // A worker's write lands between the pass's own transactions: it commits before
    // the next checkpoint snapshot opens, as an external writer's does.
    if (kind === 'snapshot' && beforeNextSnapshot !== undefined) {
      const write = beforeNextSnapshot;
      beforeNextSnapshot = undefined;
      await write();
    }
    const settlement = kind === 'snapshot' && new Error().stack?.includes('settleRun');
    const answer = await owner.transaction(kind, async tx => {
      let runMembership = false;
      if (kind === 'snapshot') snapshotTransactions += 1;
      return await work({
        query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          statements += 1;
          if (sql.startsWith('SELECT DISTINCT n.id::text AS id,n.uid::text AS uid,n.key FROM "')) nameLookups += 1;
          if (sql.includes(`"${unitStateTable}"`) && !sql.includes('INSERT INTO')) unitReads += 1;
          if (sql.includes(`"${runStateTable}"`) && !sql.includes('INSERT INTO')) runReads += 1;
          const stack = new Error().stack ?? '';
          if (stack.includes('settleRun') && sql.includes('max(recorded_sequence)')) settlementStampReads += 1;
          if (stack.includes('controlEvidenceIn')) settlementEvidenceReads += 1;
          if (values?.[0] === 'system.unit-run' && sql.includes('e.to_node=ANY')) runMembership = true;
          if (sql.includes('SELECT DISTINCT n.id')) runMembership = false;
          if (kind === 'snapshot' && runMembership && values?.[0] === 'system.unit-replacement') membershipReads += 1;
          return await tx.query<Row>(sql, values);
        },
      });
    });
    if (settlement && afterSettlementSnapshot) {
      const publish = afterSettlementSnapshot;
      afterSettlementSnapshot = undefined;
      await publish();
    }
    return answer;
  };
  await createOrchestratorSchema(counting);
  const queue = await createPgBossQueue({ owner, supervise: false });
  await queue.declare({ name: 'fill-units', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
  const registry = new StageRegistry().register({
    id: 'source', version: 1, consumes: { required: [], optional: [] }, produces: [],
    configSchema: Type.Object({}), defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: Array.from({ length: count }, (_, index) => ({ id: index === 0 ? 'one' : `unit-${index}`, scope: `scope-${index}` })), coverage: 'planned' }),
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
  return { owner, orchestrator, queue, settlementStampReads: () => settlementStampReads, settlementEvidenceReads: () => settlementEvidenceReads, afterSettlementSnapshot: (work: () => Promise<void>) => { afterSettlementSnapshot = work; }, beforeNextSnapshot: (work: () => Promise<void>) => { beforeNextSnapshot = work; }, statements: () => statements, reads: () => membershipReads, snapshots: () => snapshotTransactions, reset: () => { settlementStampReads = 0; settlementEvidenceReads = 0; statements = 0; membershipReads = 0; snapshotTransactions = 0; nameLookups = 0; unitReads = 0; runReads = 0; },
    nameLookups: () => nameLookups, unitReads: () => unitReads, runReads: () => runReads,
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
        opened.beforeNextSnapshot(async () => {
          expect((await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'source/one', event: { type: 'cancel', at: Date.now(), cause: 'external worker' } }))).ok).toBe(true);
        });
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


test('run snapshots bind producer outcomes to their run and invalidate after an external write', async () => {
  const opened = await fixture();
  try {
    const first = await readRunStateSnapshot(opened.owner, 'run');
    expect(first.producerOutcomes).toEqual([]);
    expect(await readRunStateSnapshot(opened.owner, 'run', first)).toBe(first);
    await opened.owner.transaction('write', async tx => {
      const uid = await readUnitGraphUidIn(tx, 'source/one', 1);
      if (uid === undefined) throw new Error('fixture unit is missing');
      await putFillVertexIn(tx, 'system.unit', uid, { produced_kind: 'example', producer: 'external', outcome: 'failed', produced: 0 });
    });
    const changed = await readRunStateSnapshot(opened.owner, 'run', first);
    expect(changed.stamp).not.toBe(first.stamp);
    expect(changed.producerOutcomes).toEqual([{ runId: 'run', unitId: 'source/one', generation: 1, plugin: 'external', kind: 'example', outcome: 'failed', produced: 0 }]);
    opened.reset();
    const evidence = await runEvidence(opened.orchestrator, 'run', async () => changed);
    expect(evidence.coverageMet).toBe(false);
    expect(opened.snapshots()).toBe(0);
    await createRun(opened.owner, { runId: 'other', product: 'snapshot-product', at: Date.now() });
    const current = await readRunStateSnapshot(opened.owner, 'run', changed);
    const other = await readRunStateSnapshot(opened.owner, 'other', current);
    expect(other).not.toBe(current);
    expect(other.run?.runId).toBe('other');
    expect(other.units).toEqual([]);
    expect(other.producerOutcomes).toEqual([]);
    await opened.owner.transaction('write', async tx => {
      const unitUid = await readUnitGraphUidIn(tx, 'source/one', 1);
      const runUid = await readRunGraphUidIn(tx, 'other');
      if (unitUid === undefined || runUid === undefined) throw new Error('fixture lineage is missing');
      await putFillVertexIn(tx, 'system.unit', unitUid, { outcome: 'completed', produced: 1 }, [
        fillEdge('system.run-inherited-unit', 'system.run', runUid, 'system.unit', unitUid),
      ]);
    });
    const inherited = await readRunStateSnapshot(opened.owner, 'other', other);
    expect(inherited.units).toEqual([]);
    expect(inherited.producerOutcomes).toEqual([{ runId: 'other', unitId: 'source/one', generation: 1, plugin: 'external', kind: 'example', outcome: 'unchanged', produced: 1 }]);
  } finally { await opened.close(); }
}, 30_000);


test('a busy scheduler pass batches state and evidence within fifty statements', async () => {
  const opened = await fixture();
  try {
    await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'source/one', event: { type: 'start', at: Date.now(), generation: 1, fence: 1 } }));
    opened.reset();
    const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
    expect(result.settlement.outcome).toBe('waiting');
    expect(opened.statements()).toBeLessThanOrEqual(50);
  } finally { await opened.close(); }
}, 30_000);

test('the last publication after the settlement snapshot settles in the same pass', async () => {
  const opened = await fixture();
  try {
    await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'source/one', event: { type: 'start', at: Date.now(), generation: 1, fence: 1 } }));
    let published = false;
    opened.afterSettlementSnapshot(async () => {
      await writeOrchestration(opened.owner, async tx => {
        const uid = await readUnitGraphUidIn(tx, 'source/one', 1);
        if (!uid) throw new Error('fixture unit is missing');
        await putFillVertexIn(tx, 'system.unit', uid, { state: 'published' });
      });
      published = true;
    });
    const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
    expect(published).toBe(true);
    expect(opened.settlementEvidenceReads()).toBeGreaterThan(0);
    expect(result.settlement.outcome).toBe('succeeded');
    expect(result.run.state).toBe('succeeded');
  } finally { await opened.close(); }
}, 30_000);

test('matching settlement stamps wait without a full evidence recheck', async () => {
  const opened = await fixture();
  try {
    await writeOrchestration(opened.owner, tx => advanceUnitIn(tx, { unitId: 'source/one', event: { type: 'start', at: Date.now(), generation: 1, fence: 1 } }));
    opened.reset();
    const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
    expect(result.settlement.outcome).toBe('waiting');
    expect(opened.settlementStampReads()).toBeGreaterThan(0);
    expect(opened.settlementEvidenceReads()).toBe(0);
  } finally { await opened.close(); }
}, 30_000);

/**
 * A run's name, a chain's product and a unit generation name one vertex for the life of the store, so a
 * pass answers its own bookkeeping from what the process already resolved: it walks no value table to a
 * service vertex again, and what it reads of those vertices is the pass's own scope and not the run's
 * size (madarch-64o5.176, the N+1 the fill's trace measured at 774 `system.run` and 598 `system.unit`
 * reads for one run of fourteen units).
 */
test('a pass resolves no service vertex by name again, whatever the run holds', async () => {
  const measure = async (units: number) => {
    const opened = await fixture(units);
    try {
      const passes: { names: number; units: number; runs: number }[] = [];
      for (let pass = 0; pass < 3; pass += 1) {
        opened.reset();
        const result = await schedulerPass(opened.orchestrator, { runId: 'run' });
        expect(result.settlement.outcome).toBe('waiting');
        passes.push({ names: opened.nameLookups(), units: opened.unitReads(), runs: opened.runReads() });
      }
      return passes;
    } finally { await opened.close(); }
  };
  const one = await measure(1);
  const twelve = await measure(12);
  for (const passes of [one, twelve]) {
    // Nothing is resolved twice: every pass after the fixture's first finds the run, its units and its chain by identity.
    for (const pass of passes) expect(pass.names).toBe(0);
    // And a pass of one unit and a pass of twelve read the same service vertices: one unit record and the run.
    expect(new Set(passes.map(pass => `${String(pass.units)}/${String(pass.runs)}`)).size).toBe(1);
  }
  expect(twelve).toEqual(one);
}, 120_000);
