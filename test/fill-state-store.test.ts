import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { FillStateDatabase } from '../src/graph/fill-state.js';
import { readProductFillState, readStoreStamp, hasSuccessfulFill, advanceChainIn, advanceRun, advanceUnitIn, readUnitIn, createRun, readRun, readUnit, readUnitGeneration, readUnitGraphUidIn, putFillVertexIn, replaceStaleGenerationIn } from '../src/graph/fill-state.js';
import { writeOrchestration } from '../src/graph/fill-orchestration.js';
import { createUnit } from './fill-unit-fixture.js';
import type { RunEvidence } from '../src/fill/fsm.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { bindWriteCapability, requireWriteCapability } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';

const NOW = 1_700_000_000_000;
const settled: RunEvidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true };

let database: TestDatabaseOwner;

beforeAll(async () => {
  // The process's one database owner, as the background server lends it: the store borrows the
  // owner's transactions and opens nothing of its own (madarch-tzte.19.1, madarch-tzte.19.5).
  database = await createTestDatabaseOwner();

});

afterAll(async () => {
  await database.close();
});

/** Drives one unit to a leased, running state under fence 1 and answers the record it reached. */
async function runningUnit(unitId: string) {
  await createRun(database, {runId:`run-of-${unitId}`,product:`product-of-${unitId}`,at:NOW});
  await createUnit(database, { unitId, product: `product-of-${unitId}`, runId: `run-of-${unitId}`, stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });
  const admitted = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } }));
  expect(admitted.ok).toBe(true);
  const started = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'start', at: NOW + 3, generation: 1, fence: 1 } }));
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('the unit did not reach running');
  return started.record;
}

async function publishedUnit(unitId: string) {
  await runningUnit(unitId);
  const published = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'complete', at: NOW + 6, generation: 1, fence: 1 } }));
  if(!published.ok) throw new Error(JSON.stringify(published));
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


test('product fill state reads its stamp, chain and newest-first runs in one snapshot', async () => {
  await createRun(database, { runId: 'snapshot-old', product: 'snapshot-product', at: NOW });
  await createRun(database, { runId: 'snapshot-new', product: 'snapshot-product', at: NOW + 1 });
  const transactions: string[] = [];
  const snapshot = await readProductFillState({ transaction: (kind, work) => {
    transactions.push(kind);
    return database.transaction(kind, work);
  } }, 'snapshot-product');
  expect(transactions).toEqual(['snapshot']);
  expect(snapshot.stamp).toBe(await readStoreStamp(database));
  expect(snapshot.chain?.product).toBe('snapshot-product');
  expect(snapshot.runs.map(run => run.runId)).toEqual(['snapshot-new', 'snapshot-old']);
});

describe('the chain of runs', () => {
  
  
  test('an unopened chain cannot be advanced, and the error names the file and the line', async () => {
    const caught = await expectAsyncError(() => writeOrchestration(database, tx => advanceChainIn(tx, { product: 'product-missing', event: { type: 'start', at: NOW, runId: 'run-a' } })));
    expect(caught.message).toContain('graph system.chain: no chain for product-missing');
    expect(caught.message.startsWith(fileURLToPath(new URL('../src/graph/fill-state.ts', import.meta.url)))).toBe(true);
    expect(caught.message).toMatch(/src\/graph\/fill-state\.ts:\d+:\d+:/);
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
  }, 15_000);

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
  test('operation retries share the scheduler stream and read back their exact record', async () => {
    const unitId = 'unit-operation-retry-stream';
    await runningUnit(unitId);
    for (const attempt of [1, 2]) {
      const at = NOW + attempt * 10;
      const retried = await database.transaction('write', async tx => {
        const installed = await startupBinding(tx, database.graphContract, 'retry-operation-fixture');
        const unitUid = (await readUnitGraphUidIn(tx, unitId))!;
        const caller = { ...installed.binding, unitUid, permissions: [] };
        bindWriteCapability(tx, caller);
        const fillStateSource = (await readKindAssertions(tx, 'vertex', 'plugin', ['label'], {
          validAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
        })).find(record => record.values['label'] === 'fill-state')!.uid;
        const operationCount = async () => (await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.operation'",
        )).rows[0]!.count;
        const operationsBefore = await operationCount();
        const step = await advanceUnitIn(tx, { unitId, event: { type: 'retry', at, generation: 1,
          cause: 'transient-failure', retryAt: at + 1, fence: attempt } }, { contract: installed.contract, operationUid: installed.binding.operationUid, unitUid });
        expect(step.ok).toBe(true);
        if (!step.ok) throw new Error(JSON.stringify(step));
        // The returned FSM record must be the graph record, even on the second retry.
        expect(await readUnitIn(tx, unitId)).toEqual(step.record);
        expect(step.record.state).toBe('retry_wait');
        expect(step.record.context).toMatchObject({ attempt, retriesLeft: 2 - attempt, retryAt: at + 1 });
        expect(requireWriteCapability(tx)).toEqual(caller);
        expect(await operationCount()).toBe(operationsBefore);
        if (attempt === 2) {
          const records = await readKindAssertions(tx, 'vertex', 'system.unit', ['state'], {
            subjectUids: [unitUid], validAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
          });
          const selected = records[0]!.selectedAssertions.find(assertion => assertion.property === 'state')!;
          expect(selected.source).toBe(fillStateSource);
          const lineage = await tx.query<{relation:string;uid:string}>(`SELECT k.name AS relation,n.uid::text AS uid
            FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node n ON n.id=e.to_node
            WHERE e.from_node=(SELECT id FROM node WHERE uid=$1::uuid)
            AND k.name IN ('system.assertion-operation','system.assertion-unit','system.assertion-author')`, [selected.id]);
          expect(lineage.rows).toEqual(expect.arrayContaining([
            { relation: 'system.assertion-operation', uid: installed.binding.operationUid },
            { relation: 'system.assertion-unit', uid: unitUid },
            { relation: 'system.assertion-author', uid: fillStateSource },
          ]));
        }
        const transitions = await tx.query<{uid:string}>(`SELECT n.uid::text AS uid
          FROM node n JOIN entity k ON k.id=n.entity_id
          JOIN edge subject ON subject.from_node=n.id JOIN entity sk ON sk.id=subject.entity_id
          JOIN node unit ON unit.id=subject.to_node
          WHERE k.name='system.fill-transition' AND sk.name='system.fill-transition-subject' AND unit.uid=$1::uuid`, [unitUid]);
        const journal = await readKindAssertions(tx, 'vertex', 'system.fill-transition', ['to_state', 'at'], {
          subjectUids: transitions.rows.map(row => row.uid),
          validAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
        });
        const transition = journal.find(row => row.values['to_state'] === 'retry_wait' && Number(row.values['at']) === at)!;
        expect(transition).toBeDefined();
        expect(transition.selectedAssertions.length).toBeGreaterThan(0);
        for (const assertion of transition.selectedAssertions) {
          expect(assertion.source).toBe(fillStateSource);
          const lineage = await tx.query<{uid:string}>(`SELECT op.uid::text AS uid
            FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node op ON op.id=e.to_node
            WHERE e.from_node=(SELECT id FROM node WHERE uid=$1::uuid) AND k.name='system.assertion-operation'`, [assertion.id]);
          expect(lineage.rows).toEqual([{ uid: installed.binding.operationUid }]);
        }
        return step.record;
      });
      expect(await readUnit(database, unitId)).toEqual(retried);
      if (attempt === 1) {
        await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'retry', at: at + 1, generation: 1,
          cause: 'transient-failure', retryAt: at + 1, fence: 1 } }));
        const started = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'start', at: at + 2, generation: 1, fence: 2 } }));
        expect(started.ok).toBe(true);
        expect((await readUnit(database, unitId))?.state).toBe('running');
      }
    }
  });

  
  
  test('records queue attempt zero at start and the next externally supplied attempt after retry', async () => {
    const unitId = 'unit-queue-attempt';
    await createRun(database,{runId:'run-queue-attempt',product:'product-queue-attempt',at:NOW});
    await createUnit(database, { unitId, product: 'product-queue-attempt', runId: 'run-queue-attempt', stageId: 'inventory', scopeKey: 'src', inputsDigest: 'digest-1', retries: 2, at: NOW });
    await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'admit', at: NOW + 1, generation: 1 } }));
    const started = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'start', at: NOW + 2, generation: 1, fence: 0, attempt: 1 } }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.record.context.fence).toBe(0);
    expect(started.record.context.attempt).toBe(1);

    await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'retry', at: NOW + 3, generation: 1, cause: 'lease-expired', retryAt: NOW + 4, fence: null } }));
    await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'retry', at: NOW + 4, generation: 1, cause: 'lease-expired', retryAt: NOW + 4, fence: null } }));
    const restarted = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'start', at: NOW + 5, generation: 1, fence: 1, attempt: 2 } }));
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.record.context.fence).toBe(1);
    expect(restarted.record.context.attempt).toBe(2);
    const late = await writeOrchestration(database,tx => advanceUnitIn(tx,{unitId,event:{type:'complete',at:NOW+6,generation:1,fence:0}}));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.refusal.guard).toBe('fence-current');
  }, 15_000);

  test('a token of the replaced generation cannot start, block or fail the generation that replaced it', async () => {
    const unitId = 'unit-replaced-fence';
    await publishedUnit(unitId);
    await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'invalidate', at: NOW + 7, replacement: 2, cause: 'inputs changed' } }));
    await createRun(database,{runId:'run-2',product:`product-of-${unitId}`,at:NOW+7});
    const replaced = await writeOrchestration(database, tx => replaceStaleGenerationIn(tx, { unitId, runId: 'run-2', inputsDigest: 'digest-2', retries: 2, at: NOW + 8 }));
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const admitted = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'admit', at: NOW + 9, generation: 2 } }));
    expect(admitted.ok).toBe(true);
    const newFence = 0;
    const started = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'start', at: NOW + 10, generation: 2, fence: newFence } }));
    expect(started.ok).toBe(true);

    for (const event of [
      { type: 'block', at: NOW + 12, generation: 2, fence: 1, reason: 'late' },
      { type: 'fail', at: NOW + 13, generation: 2, fence: 1, cause: 'budget-exhausted' },
    ] as const) {
      const refused = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event }));
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.guard).toBe('fence-current');
    }
    // A message for the replaced generation is refused too, whatever token it names.
    const oldGeneration = await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'complete', at: NOW + 14, generation: 1, fence: newFence } }));
    expect(oldGeneration.ok).toBe(false);
    if (oldGeneration.ok) return;
    expect(oldGeneration.refusal.guard).toBe('generation-current');
    expect((await writeOrchestration(database, tx => advanceUnitIn(tx, { unitId, event: { type: 'complete', at: NOW + 15, generation: 2, fence: newFence } }))).ok).toBe(true);
  }, 15_000);

  
  
  
  });

describe('the store keeps its state on disk', () => {
  });

describe('a failure of the borrowed database', () => {
  test('names the orchestration transaction and the tables it touched, at the transaction\'s own line', async () => {
    const failing: FillStateDatabase = {
      graphContract: database.graphContract,
      transaction: async () => {
        throw new Error('boom: connection closed');
      },
    };
    const caught = await expectAsyncError(() => writeOrchestration(failing, tx => advanceUnitIn(tx, { unitId: 'unit-a', event: { type: 'admit', at: NOW, generation: 1 } })));
    expect(caught.message).toContain('orchestration metadata failed on node, edge, assertion: boom: connection closed');
    expect(caught.message.startsWith(fileURLToPath(new URL('../src/graph/fill-orchestration.ts', import.meta.url)))).toBe(true);
    const line = Number(/fill-orchestration\.ts:(\d+):\d+:/.exec(caught.message)![1]);
    const source = await Bun.file(fileURLToPath(new URL('../src/graph/fill-orchestration.ts', import.meta.url))).text();
    expect(source.split('\n')[line - 1]).toContain('here()');
  });
});

test('a repository-free fill completion invalidates the store revision without another graph publication', async () => {
  const owner = await createTestDatabaseOwner();
  try {

    await createRun(owner, { runId: 'repository-free', product: 'empty-product', at: NOW });
    const before = await readStoreStamp(owner);
    expect(await hasSuccessfulFill(owner, 'empty-product')).toBe(false);
    // A fill can finish after its final publication. No node, operation or publication changes here.
    await advanceRun(owner,{runId:'repository-free',event:{type:'plan',configuration:'digest',at:NOW+1}});
    await advanceRun(owner,{runId:'repository-free',event:{type:'start',stages:1,at:NOW+2}});
    await advanceRun(owner,{runId:'repository-free',event:{type:'complete',evidence:settled,at:NOW+3}});
    expect(await hasSuccessfulFill(owner, 'empty-product')).toBe(true);
    const after = await readStoreStamp(owner);
    expect(after).not.toBe(before);
    expect(await readStoreStamp(owner)).toBe(after);
  } finally { await owner.close(); }
}, 15_000);

test('generation identities and replacement links live in the ordinary graph', async () => {
  const current = await readUnit(database, 'unit-replaced-fence');
  expect(current?.generation).toBe(2);
  expect((await readUnitGeneration(database,'unit-replaced-fence',1))?.state).toBe('stale');
  await database.transaction('snapshot',async tx=>{
    const first=await readUnitGraphUidIn(tx,'unit-replaced-fence',1),second=await readUnitGraphUidIn(tx,'unit-replaced-fence',2);
    expect(first).not.toBe(second);expect(first?.[14]).toBe('7');expect(second?.[14]).toBe('7');
    const tables=await tx.query<{name:string}>("SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('fill_chain','fill_run','fill_unit','fill_unit_generation','fill_transition')");
    expect(tables.rows).toEqual([]);
    const links=await tx.query<{count:string}>("SELECT count(*)::text AS count FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node a ON a.id=e.from_node JOIN node b ON b.id=e.to_node WHERE k.name='system.unit-replacement' AND a.uid=$1::uuid AND b.uid=$2::uuid",[first,second]);
    expect(links.rows[0]?.count).toBe('1');
  });
});


test('a malformed attempt cannot enter the typed graph state and the prior record survives', async () => {
  const unitId = 'unit-malformed-attempt';
  await runningUnit(unitId);
  const before = await readUnit(database, unitId);
  await expect(database.transaction('write', async tx => {
    const uid = await readUnitGraphUidIn(tx, unitId, 1);
    if (uid === undefined) throw new Error('fixture unit is absent');
    await putFillVertexIn(tx, 'system.unit', uid, { attempt: 'one' });
  })).rejects.toThrow();
  expect(await readUnit(database, unitId)).toEqual(before);
});
