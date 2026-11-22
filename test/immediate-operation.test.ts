import {test,expect} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {createOperationHost,initializeOperationScope,changeOperationRunState,resolveOperationScope} from '../src/graph/operation-host.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {EMPTY_CONTRACT} from '../src/graph/contract.js';
import {newUid} from '../src/graph/uid.js';
import {bindWriteCapability,writeAssertion} from '../src/graph/write.js';

const declaration={name:'operations',leaseSeconds:60,retries:1,retryDelaySeconds:0,retryBackoff:false};
test('immediate operation receipt, rollback, preconditions, run state and atomic completion',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try{
  await queue.declare(declaration);
  await queue.enqueue({queue:declaration.name,data:{}});
  const [job]=await queue.claim({queue:declaration.name});
  const runUid=newUid(),unitUid=newUid();
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,EMPTY_CONTRACT,'fixture.operation'));
  await owner.transaction('write',tx=>initializeOperationScope(tx,EMPTY_CONTRACT,binding,runUid,unitUid));
  const first=await owner.transaction('write',tx=>resolveOperationScope(tx,EMPTY_CONTRACT,binding,{runId:'run',unitId:'unit',generation:1,scope:'plugin/kind'}));
  const again=await owner.transaction('write',tx=>resolveOperationScope(tx,EMPTY_CONTRACT,binding,{runId:'run',unitId:'unit',generation:1,scope:'plugin/kind'}));
  expect(again).toEqual(first);
  const host=createOperationHost({owner,queue,job:job!,contract:EMPTY_CONTRACT,capability:binding,runUid,unitUid});
  let calls=0;
  expect(await host.execute({key:'a',request:{x:1}},async()=>({value:++calls}))).toEqual({value:1});
  expect(await host.execute({key:'a',request:{x:1}},async()=>({value:++calls}))).toEqual({value:1});
  expect(calls).toBe(1);
  await expect(host.execute({key:'a',request:{x:2}},async()=>null)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(host.execute({key:'b',request:{}},async()=>{throw new Error('crash');})).rejects.toThrow('crash');
  expect(await host.execute({key:'b',request:{}},async()=>({ok:true}))).toEqual({ok:true});
  const current=(await owner.run(tx=>tx.query<{revision:string}>(`SELECT max(a.recorded_sequence)::text AS revision FROM assertion a JOIN assertion_vertex_subject subject ON subject.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=subject.subject_edge_id JOIN node n ON n.id=attachment.to_node WHERE n.uid=$1::uuid`,[unitUid]))).rows[0]!.revision;
  expect(await host.execute({key:'fresh-read',request:{},preconditions:[{uid:unitUid,recordedSequence:current}]},async()=>({fresh:true}))).toEqual({fresh:true});
  await expect(host.execute({key:'stale-read',request:{},preconditions:[{uid:unitUid,recordedSequence:'0'}]},async()=>null)).rejects.toThrow('REVISION_CONFLICT');
  const relation=(await owner.run(tx=>tx.query<{uid:string}>(`SELECT e.uid::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.unit-run' ORDER BY e.uid LIMIT 1`))).rows[0]!;
  let edgeLocked!:()=>void,releaseEdge!:()=>void;
  const edgeReady=new Promise<void>(resolve=>{edgeLocked=resolve;});
  const edgeHeld=new Promise<void>(resolve=>{releaseEdge=resolve;});
  const blocker=owner.transaction('write',async tx=>{await tx.query('SELECT id FROM edge WHERE uid=$1::uuid FOR UPDATE',[relation.uid]);edgeLocked();await edgeHeld;});
  await edgeReady;
  let edgeSettled=false;
  const waiting=host.execute({key:'edge-lock',request:{},preconditions:[{uid:relation.uid,recordedSequence:'0'}]},async()=>null).then(()=>{edgeSettled=true;return '';},error=>{edgeSettled=true;return String(error);});
  await new Promise(resolve=>setTimeout(resolve,100));
  expect(edgeSettled).toBe(false);
  releaseEdge();await blocker;
  expect(await waiting).toContain('REVISION_CONFLICT');
  await expect(host.execute({key:'stale-edge',request:{},preconditions:[{uid:relation.uid,recordedSequence:'0'}]},async()=>null)).rejects.toThrow('REVISION_CONFLICT');
  await expect(host.execute({key:'missing-precondition',request:{},preconditions:[{uid:newUid(),recordedSequence:'0'}]},async()=>null)).rejects.toThrow('TARGET_MISSING');
  await owner.transaction('write',tx=>changeOperationRunState(tx,EMPTY_CONTRACT,binding,runUid,'paused'));
  await expect(host.execute({key:'paused',request:{}},async()=>null)).rejects.toThrow('RUN_NOT_WRITABLE');
  await owner.transaction('write',tx=>changeOperationRunState(tx,EMPTY_CONTRACT,binding,runUid,'running'));
  const setUnitState=async(value:string)=>await owner.transaction('write',async tx=>{bindWriteCapability(tx,{...binding,permissions:[{kind:'system.unit',properties:['*'],assert:true,retractOwn:true}]});const id=(await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[unitUid])).rows[0]!.id;await writeAssertion(tx,EMPTY_CONTRACT,{sort:'vertex',kind:'system.unit',subjectId:id,property:'state',operation:'assert',value},1);});
  await setUnitState('completed');
  await expect(host.execute({key:'unit-completed',request:{}},async()=>null)).rejects.toThrow('RUN_NOT_WRITABLE');
  await setUnitState('running');
  await host.execute({key:'done',request:{},completion:{output:{done:true},enqueue:[],outcome:{plugin:'probe',kind:'probe',outcome:'completed',produced:1}}},async()=>({done:true}));
  expect(await host.execute<{done:boolean}>({key:'done',request:{},completion:{output:{done:true},enqueue:[],outcome:{plugin:'probe',kind:'probe',outcome:'completed',produced:1}}},async()=>({done:false}))).toEqual({done:true});
  const affected=await owner.run(tx=>tx.query(`SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.assertion-operation'`));
  expect(affected.rows.length).toBeGreaterThan(0);
  await expect(host.execute({key:'late',request:{}},async()=>null)).rejects.toThrow('ATTEMPT_STALE');
 }finally{await queue.stop();await owner.close();}
},60000);

test('failed attempt records graph reason and settles queue without retracting committed prefix',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 const queue=await createPgBossQueue({owner,supervise:false});
 const q={...declaration,name:'operation-failure',retries:0};
 await prepareQueueSchema(owner,{declarations:[q]});
 try{
  await queue.declare(q);await queue.enqueue({queue:q.name,data:{}});const [job]=await queue.claim({queue:q.name});
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,EMPTY_CONTRACT,'fixture.failure'));
  const runUid=newUid(),unitUid=newUid();
  await owner.transaction('write',tx=>initializeOperationScope(tx,EMPTY_CONTRACT,binding,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract:EMPTY_CONTRACT,capability:binding,runUid,unitUid});
  expect(await host.execute({key:'prefix',request:{}},async()=>({accepted:true}))).toEqual({accepted:true});
  expect(await host.fail('exact failure')).toBe(true);
  const jobState=await owner.run(tx=>tx.query<{state:string}>('SELECT state FROM pgboss.job WHERE id=$1::uuid',[job!.id]));
  expect(jobState.rows[0]?.state).toBe('failed');
  expect(await host.execute<{accepted:boolean}>({key:'prefix',request:{}},async()=>({accepted:false}))).toEqual({accepted:true});
  expect(await host.fail('late')).toBe(false);
  const {readKindAssertions}=await import('../src/graph/records.js');
  const state=await owner.transaction('snapshot',tx=>readKindAssertions(tx,'vertex','system.unit',['state','reason']));
  expect(state.find(row=>row.uid===unitUid)?.values.reason).toBe('exact failure');
 }finally{await queue.stop();await owner.close();}
},60000);

test('an operation capability cannot assert the fill machine state',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try{
  await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});
  const [job]=await queue.claim({queue:declaration.name});
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,EMPTY_CONTRACT,'fixture.untrusted',[]));
  const runUid=newUid(),unitUid=newUid();
  await owner.transaction('write',tx=>initializeOperationScope(tx,EMPTY_CONTRACT,binding,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract:EMPTY_CONTRACT,capability:binding,runUid,unitUid});
  await expect(host.execute({key:'machine-write',request:{}},async tx=>{
   const subject=(await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[unitUid])).rows[0]!;
   await writeAssertion(tx,EMPTY_CONTRACT,{sort:'vertex',kind:'system.unit',subjectId:subject.id,property:'state',operation:'assert',value:'failed'});
  })).rejects.toThrow('FORBIDDEN_SOURCE');
 }finally{await queue.stop();await owner.close();}
},60000);

test('machine authority preserves the operation host context',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 try{
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,EMPTY_CONTRACT,'fixture.context',[]));
  await owner.run(tx=>tx.query("INSERT INTO context (id,ref) OVERRIDING SYSTEM VALUE VALUES (2,'operation-context')"));
  const runUid=newUid(),unitUid=newUid();
  await owner.transaction('write',tx=>initializeOperationScope(tx,EMPTY_CONTRACT,{...binding,context:2},runUid,unitUid,2));
  const held=await owner.run(tx=>tx.query<{context_id:number}>(`SELECT a.context_id FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge s ON s.id=av.subject_edge_id JOIN node n ON n.id=s.to_node WHERE n.uid=$1::uuid AND a.property='state'`,[unitUid]));
  expect(held.rows.map(row=>Number(row.context_id))).toEqual([2]);
 }finally{await owner.close();}
},60000);
