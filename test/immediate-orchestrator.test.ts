import {test,expect} from 'bun:test';
import {Type} from 'typebox';
import {createTestDatabaseOwner} from './test-database.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {createOrchestrator,startRun,planRun,driveRun,stopHeartbeat} from '../src/fill/orchestrator.js';
import {StageRegistry} from '../src/fill/registry.js';
import {DEFAULT_STAGE_DEFAULTS,type FillStage} from '../src/fill/stage.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {createOperationHost,resolveOperationScope} from '../src/graph/operation-host.js';
import {EMPTY_CONTRACT} from '../src/graph/contract.js';

test('real orchestrator binds immediate attempt and terminal receipt without private draft facts',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});

 const name='immediate-fill';const declaration={name,singletons:true,leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 await queue.declare(declaration);
 let operations=0;
 const stage:FillStage={id:'probe',version:1,defaults:DEFAULT_STAGE_DEFAULTS,configSchema:Type.Object({}),consumes:{required:[],optional:[]},produces:[],
  plan:async()=>({units:[{id:'one',scope:'one'}],coverage:'planned'}),
  execute:async(_unit,context)=>{expect(context.operationUnitUid).toBeDefined();expect(await context.executeOperation!('write',{hello:true},async()=>({accepted:++operations}))).toEqual({accepted:1});return {outcome:'draft'};}};
 const registry=new StageRegistry();registry.register(stage);
 const orchestrator=createOrchestrator({database:owner,queue,queueName:name,product:'fixture',registry,configuration:()=>undefined,snapshot:()=>({repository:'fixture',defaultBranch:'main',commit:'abc',registryHash:'hash'}),graph:()=>({query:async()=>[]}),inputs:()=>({}),operations:{open:async({unit,plan,job,queue})=>{
  const opened=await owner.transaction('write',async tx=>{const {binding,contract}=await startupBinding(tx,EMPTY_CONTRACT,'probe',[]);const scope=await resolveOperationScope(tx,contract,binding,{runId:unit.runId,unitId:unit.unitId,generation:unit.generation,scope:plan.stageUnitId});return {binding,contract,...scope};});
  return {sourceUid:opened.binding.sourceUid,unitUid:opened.unitUid,host:createOperationHost({owner,queue,job,contract:opened.contract,capability:opened.binding,runUid:opened.runUid,unitUid:opened.unitUid})};
 }}});
 try{
  await startRun(orchestrator,{runId:'immediate-run'});
  await planRun(orchestrator,{runId:'immediate-run'});
  const result=await driveRun(orchestrator,{runId:'immediate-run',maxPasses:20});
  expect(result.settled).toBe(true);expect(operations).toBe(1);
  expect((await owner.run(tx=>tx.query("SELECT to_regclass('public.fill_unit_draft') AS held"))).rows[0]?.held).toBeNull();
  const lifecycle=await owner.run(tx=>tx.query<{same_operation:boolean,affected:boolean}>(`SELECT
    EXISTS(SELECT 1 FROM edge l JOIN entity lk ON lk.id=l.entity_id AND lk.name='system.assertion-operation' WHERE l.from_node=a.assertion_id AND l.to_node=op.id) AS same_operation,
    EXISTS(SELECT 1 FROM edge e JOIN entity ek ON ek.id=e.entity_id AND ek.name='system.operation-affected' WHERE e.from_node=op.id AND e.to_node=a.assertion_id) AS affected
    FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge subject ON subject.id=av.subject_edge_id
    JOIN node unit ON unit.id=subject.to_node JOIN edge ur ON ur.from_node=unit.id JOIN entity urk ON urk.id=ur.entity_id AND urk.name='system.unit-run'
    JOIN edge ou ON ou.to_node=unit.id JOIN entity ouk ON ouk.id=ou.entity_id AND ouk.name='system.operation-unit' JOIN node op ON op.id=ou.from_node
    WHERE a.property='state' AND EXISTS(SELECT 1 FROM edge affected JOIN entity ak ON ak.id=affected.entity_id AND ak.name='system.operation-affected' WHERE affected.from_node=op.id AND affected.to_node=a.assertion_id)`));
  expect(lifecycle.rows.some(row=>row.same_operation&&row.affected)).toBe(true);
  const journal=await owner.run(tx=>tx.query<{linked:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge subject ON subject.id=av.subject_edge_id
    JOIN node transition ON transition.id=subject.to_node JOIN entity tk ON tk.id=transition.entity_id AND tk.name='system.fill-transition'
    JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity lk ON lk.id=lineage.entity_id AND lk.name='system.assertion-operation'
    JOIN edge affected ON affected.from_node=lineage.to_node AND affected.to_node=a.assertion_id JOIN entity ak ON ak.id=affected.entity_id AND ak.name='system.operation-affected'
    WHERE a.property='to_state') AS linked`));
  expect(journal.rows[0]?.linked).toBe(true);


 }finally{stopHeartbeat(orchestrator);await queue.stop();await owner.close();}
},60000);
