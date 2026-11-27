import {expect,test,spyOn} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {withManifestContract} from '../src/graph/manifest-contract.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion,writeAssertions} from '../src/graph/write.js';
import * as uidModule from '../src/graph/uid.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {reconcileDisputes} from '../src/graph/disputes.js';
import {readDispute} from '../src/graph/dispute-read.js';
import type {SqlExecutor} from '../src/sql-driver.js';
const newUid=()=>uidModule.newUid();
const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
const from='2020-01-01T00:00:00.000Z';
type Reconcile=typeof reconcileDisputes;
async function fixture(count:number,seedQuestions:boolean,contract:GraphContract=baseContract){
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),a=newUid(),b=newUid();
 const bind=(tx:SqlExecutor,sourceUid:string)=>bindWriteCapability(tx,{productUid,principalUid,operationUid:operation,sourceUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:contract.vertex.concat(contract.edge as never[]).map(kind=>({kind:kind.name,properties:['*'],assert:true,retractOwn:true}))});
 let operation=newUid();
 await owner.transaction('write',async tx=>{
  for(const [kind,uid] of [['source',a],['source',b],['person',principalUid],['system.operation',operation]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
  for(const [source,value] of [[a,1],[b,2]] as const){bind(tx,source);await publishGraphDrafts(tx,contract,{vertices:Array.from({length:count},(_,i)=>({kind:'sample',key:{name:`slot-${String(i).padStart(3,'0')}`},values:{amount:value},validFrom:from,producer:'fixture',producerVersion:'1'})),removals:[]});}
  if(seedQuestions){
   const rows=await loadAssertions(tx,'vertex','sample',['amount']);bind(tx,a);
   const vertices=[],edges=[];
   for(const id of new Set(rows.map(row=>row.subjectId))){
    const candidates=rows.filter(row=>row.subjectId===id),uid=newUid(),question={kind:'system.dispute-question',uid,key:{}};
    vertices.push({...question,values:{property:'amount',language:null,segment_from:from,segment_to:null,state:'OPEN'},validFrom:from,producer:'fixture',producerVersion:'1'});
    for(const [index,row] of candidates.entries()){
     if(index===0)edges.push({kind:'system.dispute-anchor',from:question,to:{kind:'system.assertion',uid:row.id,key:{}},discriminator:row.id,validFrom:from,producer:'fixture',producerVersion:'1'});
     edges.push({kind:'system.dispute-candidate',from:question,to:{kind:'system.assertion',uid:row.id,key:{}},discriminator:row.id,validFrom:from,producer:'fixture',producerVersion:'1'});
    }
   }
   await publishGraphDrafts(tx,contract,{vertices,edges,removals:[]});
  }
 });
 // A new operation prevents fixture construction from being an affected write.
 operation=newUid();await owner.transaction('write',tx=>bootstrapWriteIdentity(tx,'system.operation',operation,productUid));
 const slots=await owner.transaction('snapshot',async tx=>(await tx.query<{id:number}>(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.key->>'name' COLLATE "C"`)).rows.map(row=>({sort:'vertex' as const,kind:'sample',subjectId:Number(row.id),property:'amount',language:null})));
 return {owner,bind,a,b,slots,productUid};
}
// UUID births are deterministic; no identity, valid time, membership or order is normalized.
function fixedUid(index:number){return `019a0000-0000-7000-8000-${index.toString(16).padStart(12,'0')}`;}
function normalizeGeneratedClocks(value:unknown){
 return JSON.parse(JSON.stringify(value,(key,item)=>key==='recordedAt'?'<recorded clock>':key==='recordedSequence'?'<recorded sequence>':typeof item==='bigint'?item.toString():item));
}
async function outcome(tx:SqlExecutor,slots:Awaited<ReturnType<typeof fixture>>['slots'],recordedAt=new Date().toISOString(),contract:GraphContract=baseContract){
 const rows=await loadAssertions(tx,'vertex','sample',['amount']);
 const questions=[];
 for(const slot of slots)for(const at of ['2020-06-01T00:00:00Z','2021-06-01T00:00:00Z','2023-06-01T00:00:00Z'])questions.push({subjectId:slot.subjectId,at,question:await readDispute(tx,contract,rows.filter(row=>row.subjectId===slot.subjectId),{validAt:at,recordedAt,contexts:[1]})});
 const states=await loadAssertions(tx,'vertex','system.dispute-question',['state','segment_from','segment_to']);
 const candidates=await loadAssertions(tx,'edge','system.dispute-candidate',['$exists']);
 const resolutions=await loadAssertions(tx,'vertex','system.dispute-resolution',['segment_from','segment_to','rationale']);
 const support=contract.edge.some(kind=>kind.name==='justifies')?await loadAssertions(tx,'edge','justifies',['$exists']):[];
 const writes=[...states,...resolutions,...candidates,...support,...rows].sort((a,b)=>a.recordedSequence<b.recordedSequence?-1:1).map(row=>({id:row.id,source:row.source,subject:row.subject.type==='edge'?{type:row.subject.type,kind:row.subject.kind,from:row.subject.from,to:row.subject.to}:row.subject,property:row.property,value:row.value,operation:row.operation,validFrom:row.validFrom,validTo:row.validTo,recordedAt:row.recordedAt,recordedSequence:row.recordedSequence}));
 return {questions,writes};
}
const scenarioNames=['temporal-withdrawal','invalid-evidence','outside-pin-source'] as const;
type Scenario=typeof scenarioNames[number];
const baseContract=contract;
async function scenario(name:Scenario){
 const contract=name==='invalid-evidence'?withAssertionContract(withManifestContract({...baseContract,edge:[{name:'justifies',from:['system.content-snapshot'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[],repeats:false,capability:'fixture'}]})):baseContract;
 let next=1000000;
 const births=spyOn(uidModule,'newUid').mockImplementation(()=>fixedUid(next++));
 const f=await fixture(1,true,contract);
 try{
  if(name==='temporal-withdrawal')return await f.owner.transaction('write',async tx=>{
   f.bind(tx,f.b);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(f.slots[0]!.subjectId),property:'amount',operation:'assert',value:3,validFrom:'2021-01-01T00:00:00Z',validTo:'2022-01-01T00:00:00Z'});
   await reconcileDisputes(tx,contract,f.slots,false);const opened=await outcome(tx,f.slots,undefined,contract);
   await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(f.slots[0]!.subjectId),property:'amount',operation:'retract',validFrom:from});
   await reconcileDisputes(tx,contract,f.slots,false);return normalizeGeneratedClocks({opened,withdrawn:await outcome(tx,f.slots,undefined,contract)});
  });
  const resolution=fixedUid(900001),decision=fixedUid(900002),third=fixedUid(900003);
  const content='Resolution evidence',digest=createHash('sha256').update(content).digest('hex');
  const support={kind:'system.content-snapshot',key:{digest}};
  await f.owner.transaction('write',async tx=>{
   f.bind(tx,f.a);
   if(name==='invalid-evidence'){
    const installed=await startupBinding(tx,contract,'manifest-support-fixture');
    await publishGraphDrafts(tx,installed.contract,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify({file:'/fixture/catalog.yaml',kinds:{$map:[]},groups:{$map:[]},roles:{$map:[]},properties:{$map:[]},excludeDocuments:[],ignoreBlocks:[],findings:[],semanticBindings:{$map:[['evidence-support',{kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from',line:1}}}]]}})},validFrom:from,producer:'fixture',producerVersion:'1'}],removals:[]});
    f.bind(tx,f.a);
   }
   const rows=await loadAssertions(tx,'vertex','sample',['amount']);
   const question=(await readDispute(tx,contract,rows,{validAt:'2020-06-01T00:00:00Z',recordedAt:new Date().toISOString(),contexts:[1]}))!;
   await publishGraphDrafts(tx,contract,{vertices:[{...support,values:{content},validFrom:from,producer:'fixture',producerVersion:'1'}],removals:[]});
   if(name==='invalid-evidence')await publishGraphDrafts(tx,contract,{vertices:[],edges:[{kind:'justifies',from:support,to:{kind:'sample',key:{name:'slot-000'}},validFrom:from,producer:'fixture',producerVersion:'1'}],removals:[]});
   await bootstrapWriteIdentity(tx,'source',decision,f.productUid);
   f.bind(tx,decision);
   const assertion=await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(f.slots[0]!.subjectId),property:'amount',operation:'assert',value:2,validFrom:from,evidence:[{target:support}]});
   f.bind(tx,f.a);
   const ref={kind:'system.dispute-resolution',uid:resolution,key:{}};
   const targets=[...rows.map(row=>({kind:'system.resolution-judged',targetKind:'system.assertion',uid:row.id})),{kind:'system.dispute-chosen',targetKind:'system.assertion',uid:rows.find(row=>row.source===f.b)!.id},{kind:'system.resolution-assertion',targetKind:'system.assertion',uid:assertion},{kind:'system.dispute-resolution-question',targetKind:'system.dispute-question',uid:question.id}];
   await publishGraphDrafts(tx,contract,{vertices:[{...ref,values:{segment_from:from,segment_to:null,rationale:'Checked evidence'},evidence:[{target:support}],validFrom:from,producer:'fixture',producerVersion:'1'}],edges:[...targets.map(target=>({kind:target.kind,from:ref,to:{kind:target.targetKind,uid:target.uid,key:{}},discriminator:target.uid,validFrom:from,producer:'fixture',producerVersion:'1'})),{kind:'system.dispute-question-resolution',from:{kind:'system.dispute-question',uid:question.id,key:{}},to:ref,discriminator:resolution,validFrom:from,producer:'fixture',producerVersion:'1'}],removals:[]});
   await reconcileDisputes(tx,contract,f.slots,false);
  });
  const cutoff=new Date().toISOString();
  const resolved=await f.owner.transaction('snapshot',tx=>outcome(tx,f.slots,undefined,contract));
  await f.owner.transaction('write',async tx=>{
   f.bind(tx,f.a);
   if(name==='invalid-evidence'){
    const edge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'`)).rows[0]!;
    await writeAssertion(tx,contract,{sort:'edge',kind:'justifies',subjectId:edge.id,property:'$exists',operation:'retract',validFrom:from});
   }else{
    await bootstrapWriteIdentity(tx,'source',third,f.productUid);f.bind(tx,third);
    await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(f.slots[0]!.subjectId),property:'amount',operation:'assert',value:3,validFrom:from});
   }
   await reconcileDisputes(tx,contract,f.slots,false);
  });
  return normalizeGeneratedClocks({resolved,reopened:await f.owner.transaction('snapshot',tx=>outcome(tx,f.slots,undefined,contract)),historical:await f.owner.transaction('snapshot',tx=>outcome(tx,f.slots,cutoff,contract))});
 }finally{await f.owner.close();births.mockRestore();}
}
const golden=JSON.parse(readFileSync(new URL('./fixtures/dispute-reconciliation-golden.json',import.meta.url),'utf8'));
for(const name of scenarioNames)test(`reconciliation matches captured 22a82795b JSON: ${name}`,async()=>{
 expect(JSON.stringify(await scenario(name))).toBe(JSON.stringify(golden[name]));
},30000);

async function measure(count:number,reconcile:Reconcile,changing=false,catalog=count){
 const f=await fixture(catalog,!changing);
 try{return await f.owner.transaction('write',async tx=>{
  f.bind(tx,f.a);
  await startupBinding(tx,contract,'system.disputes');
  const counts={total:0,rows:0,clocks:0};
  const statements:string[]=[];
  const query=tx.query.bind(tx);
  tx.query=async<Row extends object=Record<string,unknown>>(sql:string,values?:readonly unknown[]):Promise<{rows:Row[]}>=>{
   counts.total++;statements.push(sql);
   if(sql.includes('clock_timestamp()'))counts.clocks++;
   const result=await query(sql,values);counts.rows+=result.rows.length;
   return result as {rows:Row[]};
  };
  try{await reconcile(tx,contract,f.slots.slice(0,count),false);}finally{tx.query=query;}
  return {...counts,statements};
 });}finally{await f.owner.close();}
}
test('stable affected slots bound every SQL statement by writes',async()=>{
 const small=await measure(10,reconcileDisputes);
 console.log('stable small',JSON.stringify({...small,statements:undefined}));
 // Before the fix each slot has two instants: 10 -> 200 adds 380 clocks.
 expect(small.clocks).toBe(3);
 const large=await measure(200,reconcileDisputes);
 console.log('stable large',JSON.stringify({...large,statements:undefined}));
 expect(large.statements.map(sql=>sql.replace(/source.to_node=\d+::bigint/g,'source.to_node=<identity>::bigint'))).toEqual(small.statements.map(sql=>sql.replace(/source.to_node=\d+::bigint/g,'source.to_node=<identity>::bigint')));
 expect(large.rows-small.rows).toBe(190*13);
},60000);
test('unrelated question catalog does not enlarge the reconciliation snapshot',async()=>{
 const small=await measure(10,reconcileDisputes,false,10);
 const large=await measure(10,reconcileDisputes,false,200);
 console.log('catalog',JSON.stringify({small:{...small,statements:undefined},large:{...large,statements:undefined}}));
 expect(large.total).toBe(small.total);
 expect(large.rows).toBe(small.rows);
},60000);
test('opening questions reads the same statements and rows per change',async()=>{
 const small=await measure(10,reconcileDisputes,true);
 console.log('changing small',JSON.stringify({...small,statements:undefined}));
 expect(small.clocks).toBe(13);
 const large=await measure(200,reconcileDisputes,true);
 console.log('changing large',JSON.stringify({...large,statements:undefined}));
 // The fixed part of the transaction is the reconciliation snapshot and the write rights: 21 statements and
 // 26 rows, which a started installation answers from what it installed rather than reading again per
 // transaction (madarch-64o5.176). Everything else is per slot.
 expect((large.total-21)/200).toBe((small.total-21)/10);
 expect((large.rows-small.rows)/190).toBe((small.rows-26)/10);
},60000);

// Exercise the production default through the fenced host, not an explicit slot list.
async function hostMeasure(catalog:number,withdraw=false){
 const contract=withdraw?withAssertionContract(withManifestContract({...baseContract,edge:[{name:'justifies',from:['system.content-snapshot'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[],repeats:false,capability:'fixture'}]})):baseContract;
 const started=performance.now();
 const f=await fixture(withdraw?catalog+1:catalog+10,true,contract);
 let setupMs=0,baselineMs=0,operationMs=0;
 let supportEdge='';let resolutionSource='';
 if(withdraw)await f.owner.transaction('write',async tx=>{
  const installed=await startupBinding(tx,contract,'support-manifest');
  await publishGraphDrafts(tx,installed.contract,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify({file:'/fixture/catalog.yaml',kinds:{$map:[]},groups:{$map:[]},roles:{$map:[]},properties:{$map:[]},excludeDocuments:[],ignoreBlocks:[],findings:[],semanticBindings:{$map:[['evidence-support',{kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from',line:1}}}]]}})},validFrom:from,producer:'fixture',producerVersion:'1'}],removals:[]});
  f.bind(tx,f.a);
  const rows=await loadAssertions(tx,'vertex','sample',['amount']);
  const anchors=(await tx.query<{question:string;target:string}>(`SELECT q.uid::text AS question,a.uid::text AS target FROM edge e JOIN entity k ON k.id=e.entity_id AND k.name='system.dispute-anchor' JOIN node q ON q.id=e.from_node JOIN node a ON a.id=e.to_node`)).rows;
  const vertices=[],edges=[];const decision=newUid();resolutionSource=decision;await bootstrapWriteIdentity(tx,'source',decision,f.productUid);
  const proofs=f.slots.map((_,index)=>{const content=`Proof ${index}`,digest=createHash('sha256').update(content).digest('hex');return {kind:'system.content-snapshot',key:{digest},values:{content},validFrom:from,producer:'fixture',producerVersion:'1'};});
  await publishGraphDrafts(tx,contract,{vertices:proofs,edges:proofs.map((proof,index)=>({kind:'justifies',from:proof,to:{kind:'sample',key:{name:`slot-${String(index).padStart(3,'0')}`}},validFrom:from,producer:'fixture',producerVersion:'1'})),removals:[]});
  f.bind(tx,decision);
  const decisions=await writeAssertions(tx,contract,f.slots.map((slot,index)=>({sort:'vertex' as const,kind:'sample',subjectId:String(slot.subjectId),property:'amount',operation:'assert' as const,value:2,validFrom:from,evidence:[{target:proofs[index]!}]})));f.bind(tx,f.a);
  for(const [index,slot] of f.slots.entries()){
   const candidates=rows.filter(row=>row.subjectId===slot.subjectId);const question=anchors.find(anchor=>candidates.some(row=>row.id===anchor.target))!.question;
   const support=proofs[index]!,assertion=decisions[index]!;
   const resolution={kind:'system.dispute-resolution',uid:newUid(),key:{}};
   vertices.push({...resolution,values:{segment_from:from,segment_to:null,rationale:'Checked'},evidence:[{target:support}],validFrom:from,producer:'fixture',producerVersion:'1'});
   const targets=[...candidates.map(row=>({kind:'system.resolution-judged',target:{kind:'system.assertion',uid:row.id,key:{}}})),{kind:'system.dispute-chosen',target:{kind:'system.assertion',uid:candidates.find(row=>row.source===f.b)!.id,key:{}}},{kind:'system.resolution-assertion',target:{kind:'system.assertion',uid:assertion,key:{}}}];
   for(const target of targets)edges.push({kind:target.kind,from:resolution,to:target.target,discriminator:target.target.uid,validFrom:from,producer:'fixture',producerVersion:'1'});
   edges.push({kind:'system.dispute-question-resolution',from:{kind:'system.dispute-question',uid:question,key:{}},to:resolution,discriminator:resolution.uid,validFrom:from,producer:'fixture',producerVersion:'1'});
  }
  await publishGraphDrafts(tx,contract,{vertices,edges,removals:[]});
  const states=await loadAssertions(tx,'vertex','system.dispute-question',['state']);
  await writeAssertions(tx,contract,states.map(state=>({sort:'vertex' as const,kind:'system.dispute-question',subjectId:String(state.subjectId),property:'state',operation:'assert' as const,value:'RESOLVED',validFrom:from})));
  supportEdge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node WHERE k.name='justifies' AND target.id=$1::bigint`,[f.slots[0]!.subjectId])).rows[0]!.id;
 });
 setupMs=performance.now()-started;
 if(withdraw){const baseline=performance.now();await f.owner.transaction('write',async tx=>{f.bind(tx,f.a);await reconcileDisputes(tx,contract,f.slots,false);});baselineMs=performance.now()-baseline;}
 console.log('HOST-PHASE',JSON.stringify({catalog,withdraw,setupMs,baselineMs}));
 const {createPgBossQueue}=await import('../src/adapters/pg-boss-queue.js');
 const {prepareQueueSchema}=await import('../src/adapters/schemas/queue.js');
 const {createOperationHost,initializeOperationScope}=await import('../src/graph/operation-host.js');
 const {requireWriteCapability}=await import('../src/graph/write.js');
 const queue=await createPgBossQueue({owner:f.owner,supervise:false});
 try{
  const declaration={name:'dependency-fixture',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
  await prepareQueueSchema(f.owner,{declarations:[declaration]});await queue.declare(declaration);
  await queue.enqueue({queue:declaration.name,data:{}});const [job]=await queue.claim({queue:declaration.name});
  const runUid=newUid(),unitUid=newUid();
  const binding=await f.owner.transaction('write',async tx=>{f.bind(tx,f.a);const binding=requireWriteCapability(tx);for(const [kind,uid] of [['person',binding.principalUid],['source',binding.sourceUid]] as const){const node=(await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[uid])).rows[0]!;await writeAssertion(tx,contract,{sort:'vertex',kind,subjectId:node.id,property:'$exists',operation:'assert',value:true});}await initializeOperationScope(tx,contract,binding,runUid,unitUid);return binding;});
  const statements:{sql:string;rows:number;values?:readonly unknown[]}[]=[];let recording=false;
  const observed:typeof f.owner={...f.owner,transaction:(kind,work,options)=>f.owner.transaction(kind,async tx=>{
   const query=tx.query.bind(tx);tx.query=async<Row extends object>(sql:string,values?:readonly unknown[])=>{const result=await query<Row>(sql,values);if(recording)statements.push({sql,rows:result.rows.length,values});return result;};
   try{return await work(tx);}finally{tx.query=query;}
  },options)};
  const host=createOperationHost({owner:observed,queue,job:job!,contract,capability:binding,runUid,unitUid});
  const operationStart=performance.now();
  await host.execute({key:'fixed-ten',request:{}},async tx=>{
   if(withdraw)await writeAssertion(tx,contract,{sort:'edge',kind:'justifies',subjectId:supportEdge,property:'$exists',operation:'retract'});
   else for(const slot of f.slots.slice(0,10))await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(slot.subjectId),property:'amount',operation:'assert',value:1,validFrom:from});
   recording=true;return {accepted:true};
  });
  operationMs=performance.now()-operationStart;recording=false;
  console.log('HOST-OPERATION',JSON.stringify({catalog,withdraw,operationMs}));
  const outcome=withdraw?await f.owner.transaction('snapshot',async tx=>({state:(await readDispute(tx,contract,(await loadAssertions(tx,'vertex','sample',['amount'])).filter(row=>row.subjectId===f.slots[0]!.subjectId),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}))?.state,retracted:(await loadAssertions(tx,'vertex','sample',['amount'])).some(row=>row.source===resolutionSource&&row.operation==='retract')})):undefined;
  // Measure tuples visited, not just the rows the anchor lookup returns.
  const anchorStatements=statements.filter(statement=>statement.sql.startsWith('SELECT CASE WHEN vertex.assertion_id IS NOT NULL')&&statement.sql.includes("name='system.dispute-anchor'"));
  expect(anchorStatements.length).toBeGreaterThan(0);
  let anchorWork=0;
  const rollback=new Error('rollback anchor plans');
  const countedRelations=new Set(['edge','node','assertion','assertion_vertex_subject','assertion_edge_subject']);
  const visited=(plan:Record<string,unknown>):number=>{
   const own=countedRelations.has(String(plan['Relation Name']))?(Number(plan['Actual Rows']??0)+Number(plan['Rows Removed by Filter']??0)+Number(plan['Rows Removed by Index Recheck']??0))*Number(plan['Actual Loops']??0):0;
   return own+((plan['Plans']??[]) as Record<string,unknown>[]).reduce((sum,child)=>sum+visited(child),0);
  };
  // The lookup visits at most one tuple on each counted relation of its plan per driver row, so the
  // plan's own probe count times the driver rows the fixture feeds it is the work of a lookup that
  // walks nothing else.
  const probes=(plan:Record<string,unknown>):number=>(countedRelations.has(String(plan['Relation Name']))?1:0)+((plan['Plans']??[]) as Record<string,unknown>[]).reduce((sum,child)=>sum+probes(child),0);
  // The driver rows come from what this case itself furnishes, never from the `$4` list the lookup
  // under test assembles: the fixture recorded two sources' assertions on every slot, the harness
  // writes the two identity assertions before the operation runs, and the operation writes one
  // assertion per touched slot. The direct lookup is fed by those slots' assertions, the dependency
  // lookup by the operation's own identities. Both counts ignore the question catalogue.
  const touchedSlots=withdraw?1:10,assertionsPerSlot=2,identityWrites=2;
  const dependency=(sql:string)=>sql.includes('FROM edge evidence');
  const expectedDrivers=(sql:string)=>dependency(sql)?touchedSlots+identityWrites:touchedSlots*assertionsPerSlot;
  expect([...new Set(anchorStatements.map(statement=>dependency(statement.sql)?'dependency':'direct'))].sort()).toEqual(['dependency','direct']);
  await expect(f.owner.transaction('write',async tx=>{
   await tx.query('SET LOCAL enable_seqscan=off');
   for(const statement of anchorStatements){
    const explained=await tx.query<{'QUERY PLAN':{Plan:Record<string,unknown>}[]}>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`,statement.values);
    const plan=explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    const work=visited(plan);anchorWork+=work;
    const drivers=Array.isArray(statement.values?.[3])?(statement.values[3] as readonly unknown[]).length:0;
    const expected=expectedDrivers(statement.sql),budget=probes(plan)*expected;
    console.log('HOST-ANCHOR-PLAN',JSON.stringify({catalog,withdraw,drivers,expected,work,budget,sql:statement.sql,values:statement.values,plan}));
    // PostgreSQL may order the inner edge/assertion pair of the anchor join either way, which costs
    // at most one further probe per driver row (measured: 80 against 90 visited tuples for the same
    // ten slots); both orders stay inside the plan's own probe count, while a lookup that walked the
    // unrelated questions, or one fed inputs the fixture never wrote, leaves it at once.
    expect(drivers).toBeLessThanOrEqual(expected);
    expect(work).toBeLessThanOrEqual(budget);
   }
   throw rollback;
  })).rejects.toBe(rollback);
  return {total:statements.length,rows:statements.reduce((sum,s)=>sum+s.rows,0),statements,outcome,setupMs,baselineMs,operationMs,anchorWork};
 }finally{await queue.stop();await f.owner.close();}
}
test('operation host bounds fixed touched slots independently of unrelated questions',async()=>{
 const small=await hostMeasure(10),large=await hostMeasure(200);
 console.log('HOST-TOUCHED',JSON.stringify({small,large}));
 expect(large.total).toBe(small.total);expect(large.rows).toBe(small.rows);
},30000);

test('operation host support withdrawal reopens only dependent resolution with bounded rows',async()=>{
 const small=await hostMeasure(10,true),large=await hostMeasure(200,true);
 console.log('HOST-SUPPORT',JSON.stringify({small,large}));
 expect(small.outcome?.state).toBe('OPEN');expect(large.outcome?.state).toBe('OPEN');
 expect(small.outcome?.retracted).toBe(true);expect(large.outcome?.retracted).toBe(true);
 expect(large.total).toBe(small.total);expect(large.rows).toBe(small.rows);
// The baseline walks every resolved question; the measured 200-question setup exceeded 30 seconds.
},120000);
