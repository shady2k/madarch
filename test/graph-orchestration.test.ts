import {test,expect} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {createRun,readUnitGraphUidIn,putFillVertexIn} from '../src/graph/fill-state.js';
import { createUnit } from './fill-unit-fixture.js';
import {recordInheritedUnit,recordRunConfiguration,readRunConfiguration,recordUnitPlan,readRunPlans,appendProgresses,readProgress,askRunControl,readRunControl,writeFillEnd,readFillEnd,recordUnitReads,readUnitReads} from '../src/graph/fill-orchestration.js';

test('orchestration records are typed graph facts with one run and unit identity',async()=>{
 const owner=await createTestDatabaseOwner();
 try{
  await createRun(owner,{runId:'metadata-run',product:'metadata-product',at:1});
  await createUnit(owner,{unitId:'metadata-unit',runId:'metadata-run',product:'metadata-product',stageId:'probe',scopeKey:'scope',inputsDigest:'inputs',retries:0,at:2});
  await createRun(owner,{runId:'inheriting-run',product:'metadata-product',at:2});
  await expect(recordInheritedUnit(owner,{runId:'inheriting-run',unitId:'metadata-unit',generation:1})).rejects.toThrow('cannot inherit unpublished unit');
  await owner.transaction('write',async tx=>{const uid=await readUnitGraphUidIn(tx,'metadata-unit',1);await putFillVertexIn(tx,'system.unit',uid!,{state:'published',published_at:2});});
  await recordInheritedUnit(owner,{runId:'inheriting-run',unitId:'metadata-unit',generation:1});
  await recordInheritedUnit(owner,{runId:'inheriting-run',unitId:'metadata-unit',generation:1});
  const inherited=await owner.transaction('snapshot',tx=>tx.query<{count:number}>("SELECT count(*)::int AS count FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.run-inherited-unit'"));
  expect(inherited.rows[0]?.count).toBe(1);
  const snapshot={repository:'repository',defaultBranch:'main',commit:'commit',registryHash:'registry',targets:{kinds:['one','two'],requested:['two'],vertex:'vertex',pluginsOnly:true}};
  await recordRunConfiguration(owner,{runId:'metadata-run',digest:'configuration',snapshot,at:3});
  expect((await readRunConfiguration(owner,'metadata-run'))?.snapshot).toEqual(snapshot);
  expect((await recordRunConfiguration(owner,{runId:'metadata-run',digest:'ignored',snapshot:{...snapshot,commit:'ignored'},at:4})).digest).toBe('configuration');
  await recordUnitPlan(owner,{unitId:'metadata-unit',generation:1,runId:'metadata-run',stageId:'probe',stageUnitId:'unit',scope:'scope',stagePosition:0,planPosition:2,at:4,cacheVersions:{model:'v1'}});
  expect((await readRunPlans(owner,'metadata-run'))[0]?.cacheVersions).toEqual({model:'v1'});
  await recordUnitReads(owner,[{unitId:'metadata-unit',generation:1,query:'read',rows:[],at:5},{unitId:'metadata-unit',generation:1,query:'read',rows:[{x:1}],at:6}]);
  expect((await readUnitReads(owner,'metadata-unit',1)).map(read=>[read.seq,read.members])).toEqual([[2,1]]);
  await appendProgresses(owner,[{runId:'metadata-run',at:7,stage:'probe',unitId:'metadata-unit',generation:1,kind:'unit-planned',summary:'planned'},{runId:'metadata-run',at:8,stage:'',unitId:'',generation:null,kind:'run-started',summary:'started'}]);
  expect((await readProgress(owner,'metadata-run')).map(event=>event.seq)).toEqual([1,2]);
  await askRunControl(owner,{runId:'metadata-run',action:'pause',at:9});
  expect(await readRunControl(owner,'metadata-run')).toBe('pause');
  expect(await readRunControl(owner,'metadata-run')).toBeNull();
  await askRunControl(owner,{runId:'metadata-run',action:'stop',at:10});
  expect(await readRunControl(owner,'metadata-run')).toBe('stop');
  expect(await readRunControl(owner,'metadata-run')).toBeNull();
  await writeFillEnd(owner,{runId:'metadata-run',state:'failed',message:'failure',unread:[{repository:'repository',path:'missing',reason:'gone'}]});
  expect(await readFillEnd(owner,'metadata-run')).toEqual({runId:'metadata-run',state:'failed',message:'failure',unread:[{repository:'repository',path:'missing',reason:'gone'}]});
  const tables=await owner.transaction('snapshot',tx=>tx.query<{name:string}>("SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname LIKE 'fill_%'"));
  expect(tables.rows).toEqual([]);
 }finally{await owner.close();}
},60000);
