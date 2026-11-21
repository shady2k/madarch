import { expect, test } from 'bun:test';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { createRun } from '../src/graph/fill-state.js';
import { writeOrchestration, recordRunStagePlannedIn, readRunPlanningSnapshot } from '../src/graph/fill-orchestration.js';

test('planning attempts and publication counters share one snapshot transaction', async () => {
 const owner=await createTestDatabaseOwner();
 try {
  await createRun(owner,{runId:'planning',product:'planning',at:1});
  await writeOrchestration(owner,tx => recordRunStagePlannedIn(tx,{runId:'planning',stageId:'source',units:0,publications:0,at:2}));
  let transactions=0;
  const counted=Object.create(owner) as TestDatabaseOwner;
  counted.transaction=async(kind,work)=>{transactions++;return await owner.transaction(kind,work);};
  const snapshot=await readRunPlanningSnapshot(counted,'planning');
  expect(snapshot).toEqual({attempts:[{runId:'planning',stageId:'source',units:0,publications:0,plannedAt:2}],stages:[],publications:0});
  expect(transactions).toBe(1);
 } finally {await owner.close();}
});
