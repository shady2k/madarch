import {test,expect} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {createOperationHost,initializeOperationScope,changeOperationRunState,resolveOperationScope} from '../src/graph/operation-host.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {EMPTY_CONTRACT,generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {newUid} from '../src/graph/uid.js';
import {bindWriteCapability,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';

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
  // A refusal names this module's source path and line, never the file the engine is bundled into (madarch-64o5.200):
  // this message reaches the run's failure detail as its head, and a reader can open no line of `/$bunfs/root/…`.
  const paused = await host.execute({key:'paused',request:{}},async()=>null).then(()=>null,error=>error as Error);
  expect(paused?.message).toMatch(/^src\/graph\/operation-host\.ts:87: RUN_NOT_WRITABLE run paused unit running$/u);
  expect(paused?.message).not.toContain('bunfs');
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

test('subject preconditions name this source\u2019s stream, retracted and never-asserted subjects included',async()=>{
 // 0039 item 24: a plugin addresses a subject by identity, and the sequence a batch was decided from is this source's
 // own stream position for it, so another source's statement on the same subject never makes the batch stale.
 const contract:GraphContract={
  vertex:[{name:'fixture.item',table:generatedTableName('fixture.item','vertex'),key:['name'],capability:'reader',fields:[{name:'name',type:'text'},{name:'text',type:'text',nullable:true}]}],
  edge:[{name:'fixture.link',table:generatedTableName('fixture.link','edge'),from:['fixture.item'],to:['fixture.item'],cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked by'},ru:{out:'связан',in:'связан'}},repeats:true,discriminator:'place',capability:'reader',fields:[]}],
  dictionary:[],
 };
 const item=(name:string)=>({kind:'fixture.item',key:{name}});
 const link=(from:string,to:string)=>({kind:'fixture.link',from:item(from),to:item(to),discriminator:'line:1'});
 const owner=await createTestDatabaseOwner({graphContract:contract});
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try{
  await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});
  const [job]=await queue.claim({queue:declaration.name});
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,contract,'fixture.preconditions'));
  const source=binding.sourceUid;
  const publish=async(drafts:Parameters<typeof publishGraphDrafts>[2],as=source)=>await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,contract,as);return await publishGraphDrafts(tx,contract,drafts,1);});
  await publish({vertices:[{...item('kept'),values:{text:'first'},producer:'preconditions',producerVersion:'1'},{...item('withdrawn'),values:{text:'gone'},producer:'preconditions',producerVersion:'1'}],removals:[]});
  await publish({vertices:[],edges:[{...link('kept','withdrawn'),producer:'preconditions',producerVersion:'1'}],removals:[]});
  await publish({vertices:[],removals:[{...item('withdrawn'),producer:'preconditions'}]});
  /** The subject's last recorded sequence in one source's stream, read independently of the writer's own answer. */
  const sequenceOf=async(kind:'vertex'|'edge',subject:Record<string,unknown>,of=source):Promise<string>=>{
   const sql=kind==='vertex'
    ?`SELECT max(a.recorded_sequence)::text AS revision FROM assertion a
      JOIN edge held ON held.from_node=a.assertion_id
      JOIN entity held_kind ON held_kind.id=held.entity_id AND held_kind.name='system.assertion-source'
      JOIN node held_source ON held_source.id=held.to_node
      JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id JOIN edge attachment ON attachment.id=s.subject_edge_id JOIN node n ON n.id=attachment.to_node JOIN entity k ON k.id=n.entity_id
      WHERE k.name=$1 AND n.key=$2::jsonb AND held_source.uid=$3::uuid`
    :`SELECT max(a.recorded_sequence)::text AS revision FROM assertion a
      JOIN edge held ON held.from_node=a.assertion_id
      JOIN entity held_kind ON held_kind.id=held.entity_id AND held_kind.name='system.assertion-source'
      JOIN node held_source ON held_source.id=held.to_node
      JOIN assertion_edge_subject s ON s.assertion_id=a.assertion_id JOIN edge subject_edge ON subject_edge.id=s.edge_id JOIN node from_node ON from_node.id=subject_edge.from_node JOIN node to_node ON to_node.id=subject_edge.to_node JOIN entity k ON k.id=subject_edge.entity_id
      WHERE k.name=$1 AND from_node.key=$2::jsonb AND to_node.key=$3::jsonb AND subject_edge.discriminator=$4 AND held_source.uid=$5::uuid`;
   const values=kind==='vertex'?['fixture.item',subject,of]:['fixture.link',{name:subject['from']},{name:subject['to']},String(subject['discriminator']),of];
   return (await owner.run(tx=>tx.query<{revision:string|null}>(sql,values))).rows[0]?.revision??'0';
  };
  const runUid=newUid(),unitUid=newUid();
  await owner.transaction('write',tx=>initializeOperationScope(tx,contract,binding,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract,capability:binding,runUid,unitUid});
  const execute=async(key:string,preconditions:readonly import('../src/graph/operation-host.js').OperationPrecondition[])=>await host.execute({key,request:{},preconditions},async()=>({accepted:true}));
  const kept=await sequenceOf('vertex',{name:'kept'});
  expect(Number(kept)).toBeGreaterThan(0);
  expect(await execute('kept-fresh',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'kept'}},recordedSequence:kept}])).toEqual({accepted:true});
  await expect(execute('kept-stale',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'kept'}},recordedSequence:'0'}])).rejects.toThrow('REVISION_CONFLICT');
  // A subject another source states too is not this source's business: its own stream did not move.
  await publish({vertices:[{...item('kept'),values:{text:'another source'},producer:'other',producerVersion:'1'}],removals:[]},'019a0000-0000-7000-8000-000000000099');
  expect(await sequenceOf('vertex',{name:'kept'})).toBe(kept);
  expect(await execute('kept-foreign-statement',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'kept'}},recordedSequence:kept}])).toEqual({accepted:true});
  // A withdrawn subject keeps its place in the stream: a later assertion is decided from the retraction's sequence.
  const withdrawn=await sequenceOf('vertex',{name:'withdrawn'});
  expect(Number(withdrawn)).toBeGreaterThan(0);
  expect(await execute('withdrawn-fresh',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'withdrawn'}},recordedSequence:withdrawn}])).toEqual({accepted:true});
  await expect(execute('withdrawn-absent',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'withdrawn'}}}])).rejects.toThrow('REVISION_CONFLICT');
  // A subject this source never asserted: the batch states that absence, and the writer holds it to it.
  expect(await sequenceOf('vertex',{name:'absent'})).toBe('0');
  expect(await execute('absent-stated',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'absent'}}}])).toEqual({accepted:true});
  expect(await execute('absent-zero',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'absent'}},recordedSequence:'0'}])).toEqual({accepted:true});
  await expect(execute('absent-changed',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'absent'}},recordedSequence:'1'}])).rejects.toThrow('REVISION_CONFLICT');
  // An edge is a subject of its own, by its kind and ends.
  const linked=await sequenceOf('edge',{from:'kept',to:'withdrawn',discriminator:'line:1'});
  expect(Number(linked)).toBeGreaterThan(0);
  expect(await execute('edge-fresh',[{subject:{sort:'edge',kind:'fixture.link',from:item('kept'),to:item('withdrawn'),discriminator:'line:1'},recordedSequence:linked}])).toEqual({accepted:true});
  await expect(execute('edge-stale',[{subject:{sort:'edge',kind:'fixture.link',from:item('kept'),to:item('withdrawn'),discriminator:'line:1'},recordedSequence:'0'}])).rejects.toThrow('REVISION_CONFLICT');
  await expect(execute('repeated',[{subject:{sort:'vertex',kind:'fixture.item',key:{name:'kept'}}},{subject:{sort:'vertex',kind:'fixture.item',key:{name:'kept'}}}])).rejects.toThrow('MALFORMED_PRECONDITION');
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
