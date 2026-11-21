import {expect,test,spyOn} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {withManifestContract} from '../src/graph/manifest-contract.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
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
 expect((large.total-26)/200).toBe((small.total-26)/10);
 expect((large.rows-small.rows)/190).toBe((small.rows-41)/10);
},60000);
