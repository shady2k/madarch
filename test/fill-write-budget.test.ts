import { expect, test, spyOn } from 'bun:test';
import { Client } from 'pg';
import { acquireGraphWriteLock } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, createUnit } from '../src/graph/fill-state.js';
import { recordUnitPlan } from '../src/graph/fill-orchestration.js';

test('an orchestration step takes one graph lock and at most twenty statements', async () => {
 const owner = await createTestDatabaseOwner();
 try {
  await createRun(owner, {runId:'budget', product:'budget', at:1});
  await createUnit(owner,{unitId:'unit',product:'budget',runId:'budget',stageId:'stage',scopeKey:'scope',inputsDigest:'digest',retries:0,at:1});
  await recordUnitPlan(owner,{unitId:'unit',generation:1,runId:'budget',stageId:'stage',stageUnitId:'unit',scope:'scope',stagePosition:0,planPosition:0,at:2});
  const statements:string[]=[];
  let databaseMs=0;
  const original=Client.prototype.query;
  const spy=spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
   if(typeof args[0]==='string')statements.push(args[0]);
   const start=performance.now();
   return Reflect.apply(original,this,args).finally(()=>{databaseMs+=performance.now()-start;});
  } as typeof original);
  try {
   await recordUnitPlan(owner,{unitId:'unit',generation:1,runId:'budget',stageId:'stage',stageUnitId:'unit',scope:'scope',stagePosition:0,planPosition:0,at:3,cacheVersions:{a:'1',b:'2',c:'3'}});
  } finally { spy.mockRestore(); }
  console.log('orchestration step trace',JSON.stringify({statements:statements.length,transactions:statements.filter(sql=>/^BEGIN/.test(sql)).length,databaseMs,locks:statements.filter(sql=>sql==='SELECT pg_advisory_xact_lock($1::bigint)').length,constraints:statements.filter(sql=>sql==='SET CONSTRAINTS ALL IMMEDIATE').length}));
  expect(statements.filter(sql=>sql==='SELECT pg_advisory_xact_lock($1::bigint)').length).toBe(1);
  expect(statements.length).toBeLessThanOrEqual(20);
 } finally { await owner.close(); }
},30_000);

test('nested graph write lock requests share one transaction lock',async()=>{
 const statements:string[]=[];
 const tx={query:async(sql:string)=>{statements.push(sql);return {rows:[]};}};
 await Promise.all([acquireGraphWriteLock(tx),acquireGraphWriteLock(tx)]);
 await acquireGraphWriteLock(tx);
 expect(statements).toEqual(['SELECT pg_advisory_xact_lock($1::bigint)']);
});
