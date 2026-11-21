import {test,expect} from 'bun:test';
import {assertionValueTableName} from '../src/graph/contract.js';
import {createTestDatabaseOwner} from './test-database.js';
import {createRun,readRunGraphUidIn,readUnitGraphUidIn,putFillVertexIn} from '../src/graph/fill-state.js';
import { createUnit } from './fill-unit-fixture.js';
import {writeOrchestration,recordInheritedUnitIn,recordRunConfigurationIn,readRunConfiguration,recordUnitPlanIn,readRunPlans,appendProgresses,readProgress,askRunControl,readRunControl,writeFillEnd,readFillEnd,recordUnitReads,readUnitReads} from '../src/graph/fill-orchestration.js';

test('orchestration records are typed graph facts with one run and unit identity',async()=>{
 const owner=await createTestDatabaseOwner();
 try{
  await createRun(owner,{runId:'metadata-run',product:'metadata-product',at:1});
  await createUnit(owner,{unitId:'metadata-unit',runId:'metadata-run',product:'metadata-product',stageId:'probe',scopeKey:'scope',inputsDigest:'inputs',retries:0,at:2});
  await createRun(owner,{runId:'inheriting-run',product:'metadata-product',at:2});
  await expect(writeOrchestration(owner,tx => recordInheritedUnitIn(tx,{runId:'inheriting-run',unitId:'metadata-unit',generation:1}))).rejects.toThrow('cannot inherit unpublished unit');
  await owner.transaction('write',async tx=>{const uid=await readUnitGraphUidIn(tx,'metadata-unit',1);await putFillVertexIn(tx,'system.unit',uid!,{state:'published',published_at:2});});
  await writeOrchestration(owner,tx => recordInheritedUnitIn(tx,{runId:'inheriting-run',unitId:'metadata-unit',generation:1}));
  await writeOrchestration(owner,tx => recordInheritedUnitIn(tx,{runId:'inheriting-run',unitId:'metadata-unit',generation:1}));
  const inherited=await owner.transaction('snapshot',tx=>tx.query<{count:number}>("SELECT count(*)::int AS count FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.run-inherited-unit'"));
  expect(inherited.rows[0]?.count).toBe(1);
  const snapshot={repository:'repository',defaultBranch:'main',commit:'commit',registryHash:'registry',targets:{kinds:['one','two'],requested:['two'],vertex:'vertex',pluginsOnly:true}};
  await writeOrchestration(owner,tx => recordRunConfigurationIn(tx,{runId:'metadata-run',digest:'configuration',snapshot,at:3}));
  expect((await readRunConfiguration(owner,'metadata-run'))?.snapshot).toEqual(snapshot);
  expect((await writeOrchestration(owner,tx => recordRunConfigurationIn(tx,{runId:'metadata-run',digest:'ignored',snapshot:{...snapshot,commit:'ignored'},at:4}))).digest).toBe('configuration');
  await writeOrchestration(owner,tx => recordUnitPlanIn(tx,{unitId:'metadata-unit',generation:1,runId:'metadata-run',stageId:'probe',stageUnitId:'unit',scope:'scope',stagePosition:0,planPosition:2,at:4,cacheVersions:{model:'v1'}}));
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

test('allocating progress sequences reads only the existing sequence field',async()=>{
 const owner=await createTestDatabaseOwner();
 try{
  await createRun(owner,{runId:'sequence-run',product:'sequence-product',at:1});
  const uid=await owner.transaction('snapshot',async tx=>await readRunGraphUidIn(tx,'sequence-run'));
  expect(typeof uid).toBe('string');
  const event={runId:'sequence-run',at:2,stage:'',unitId:'',generation:null,kind:'run-started' as const,summary:'started'};
  await appendProgresses(owner,[event]);
  const seen:{sql:string;parameters:readonly unknown[]}[]=[];
  const measured={graphContract:owner.graphContract,transaction: async <T>(kind: Parameters<typeof owner.transaction>[0], work: (tx: import('../src/history-types.js').OuterTransaction)=>Promise<T>):Promise<T> => owner.transaction(kind,async tx=>work({...tx,query:async <Row extends object>(sql:string,parameters?:readonly unknown[])=>{
   seen.push({sql,parameters:parameters??[]});
   return tx.query<Row>(sql,parameters);
  }}))};
  const appended=await appendProgresses(measured,[{...event,at:3,summary:'next'}]);
  expect(appended.map(row=>row.seq)).toEqual([2]);
  // One generated value table holds one property of system.progress (decision 0039, item 25).
  // The sequence selection is the only statement that names a progress value table and is bound
  // to the run; it must name only the seq table and carry the run's uid. The transaction also
  // writes every property table, so the selection check is not vacuous.
  const properties=['seq','at','stage','unit_name','generation','kind','summary'];
  const table=(property:string):string=>assertionValueTableName('system.progress','vertex',property);
  const writes=(sql:string,property:string):boolean=>sql.includes(`INSERT INTO "${table(property)}"`);
  const namesProgressValue=(sql:string):boolean=>properties.some(property=>sql.includes(`"${table(property)}"`));
  const boundToRun=(query:{sql:string;parameters:readonly unknown[]}):boolean=>namesProgressValue(query.sql)&&query.sql.includes("name='system.progress-run'")&&query.parameters.includes(uid);
  const selectionReads=seen.filter(boundToRun);
  expect(selectionReads).toHaveLength(1);
  const selection=selectionReads[0]!;
  expect(properties.filter(property=>selection.sql.includes(`"${table(property)}"`))).toEqual(['seq']);
  expect(selection.sql).toContain("property='seq'");
  // The statement is bound to one run: its first parameter is that run's uid, and no other is.
  expect(selection.parameters[0]).toBe(uid);
  expect(selection.parameters.filter(parameter=>parameter===uid)).toEqual([uid]);
  for(const property of properties)expect({property,writes:seen.some(query=>writes(query.sql,property))}).toEqual({property,writes:true});
  expect((await readProgress(owner,'sequence-run')).map(row=>row.summary)).toEqual(['started','next']);
 }finally{await owner.close();}
},30_000);
