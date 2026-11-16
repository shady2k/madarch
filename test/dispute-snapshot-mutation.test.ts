import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {reconcileDisputes} from '../src/graph/disputes.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {readDispute,listDisputeSlots} from '../src/graph/dispute-read.js';
import {newUid} from '../src/graph/uid.js';
const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});

test('dispute snapshot excludes denied and retracted candidate lineage but retains recorded history',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract,authenticated:false});
 try {
  for(const [source,amount] of [['019a0000-0000-7000-8000-000000000021',1],['019a0000-0000-7000-8000-000000000022',2]] as const){
   await owner.transaction('write',async tx=>{
    await bindTestWriteCapability(tx,contract,source);
    await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
    await reconcileDisputes(tx,contract);
   });
  }
  const view=async(recordedAt=new Date().toISOString())=>owner.transaction('snapshot',async tx=>readDispute(tx,contract,await loadAssertions(tx,'vertex','sample',['amount']),{validAt:'2020-06-01T00:00:00Z',recordedAt,contexts:[1]}));
  const before=(await view())!;
  expect(before.state).toBe('OPEN');expect(before.candidates).toHaveLength(2);
  const cutoff=new Date().toISOString();
  const candidate=before.candidates[0]!;
  const change=async(operation:'assert'|'retract')=>owner.transaction('write',async tx=>{
   const installed=await startupBinding(tx,contract,'system.disputes');
   const edge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name='system.dispute-candidate' AND origin.uid=$1::uuid AND target.uid=$2::uuid`,[before.id,candidate])).rows[0]!;
   const original=(await loadAssertions(tx,'edge','system.dispute-candidate',['$exists'],[Number(edge.id)]))[0]!;
   bindWriteCapability(tx,{...installed.binding,sourceUid:original.source});
   await writeAssertion(tx,contract,{sort:'edge',kind:'system.dispute-candidate',subjectId:edge.id,property:'$exists',operation,...(operation==='assert'?{value:false}:{}),validFrom:original.validFrom});
  });
  await change('assert');
  const remaining=before.candidates.filter(uid=>uid!==candidate);
  expect((await view())?.candidates).toEqual(remaining);
  expect((await view(cutoff))?.candidates).toEqual(before.candidates);
  await change('retract');
  expect((await view())?.candidates).toEqual(remaining);
  await owner.transaction('snapshot',async tx=>{
   const slots=await listDisputeSlots(tx,contract,{validAt:'2020-06-01T00:00:00Z',recordedAt:new Date().toISOString(),contexts:[1]});
   expect(slots).toHaveLength(1);expect(slots[0]!.dispute.candidates).toEqual(remaining);
  });
 } finally {await owner.close();}
},30000);

test('slot batches keep boolean vertex IDs separate from denied lineage edge IDs',async()=>{
 const declared:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]},{name:'flag',table:generatedTableName('flag','vertex'),key:[],capability:'fixture',fields:[{name:'enabled',type:'boolean'}]}],edge:[],dictionary:[]});
 const owner=await createTestDatabaseOwner({graphContract:declared,authenticated:false});
 try {
  const sources=['019a0000-0000-7000-8000-000000000031','019a0000-0000-7000-8000-000000000032'];
  for(const [index,source] of sources.entries())await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,declared,source);
   await publishGraphDrafts(tx,declared,{vertices:[{kind:'sample',key:{name:'collision-origin'},values:{amount:index+1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
   await reconcileDisputes(tx,declared);
  });
  const original=await owner.transaction('snapshot',async tx=>(await readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['amount']),{contexts:[1]}))!);
  let flagId=0;let flagUid='';let removed='';
  await owner.transaction('write',async tx=>{
   const binding=await bindTestWriteCapability(tx,declared,sources[0]!);
   const edge=(await tx.query<{id:number;uid:string}>(`SELECT e.id,target.uid::text AS uid FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name='system.dispute-candidate' AND origin.uid=$1::uuid ORDER BY e.id DESC LIMIT 1`,[original.id])).rows[0]!;
   const maximum=Number((await tx.query<{id:string}>('SELECT max(id)::text AS id FROM node')).rows[0]!.id);
   expect(Number(edge.id)).toBeGreaterThan(maximum);
   removed=edge.uid;
   // Bare identities consume one node ID each without creating assertion edges.
   while(flagId<Number(edge.id)){
    const uid=newUid();await bootstrapWriteIdentity(tx,'flag',uid,binding.productUid);
    flagId=Number((await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[uid])).rows[0]!.id);
    expect(flagId).toBeLessThanOrEqual(Number(edge.id));
    if(flagId===Number(edge.id))flagUid=uid;
   }
   expect(Number((await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[flagUid])).rows[0]!.id)).toBe(Number(edge.id));
   await publishGraphDrafts(tx,declared,{vertices:[{kind:'flag',uid:flagUid,key:{},values:{enabled:true},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,declared,sources[1]!);
   await writeAssertion(tx,declared,{sort:'vertex',kind:'flag',subjectId:String(flagId),property:'enabled',operation:'assert',value:false,validFrom:'2020-01-01T00:00:00Z'});
   await reconcileDisputes(tx,declared);
  });
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,declared,sources[1]!);
   await writeAssertion(tx,declared,{sort:'vertex',kind:'flag',subjectId:String(flagId),property:'enabled',operation:'assert',value:true,validFrom:'2020-01-01T00:00:00Z'});
   const installed=await startupBinding(tx,declared,'system.disputes');
   const row=(await loadAssertions(tx,'edge','system.dispute-candidate',['$exists'],[flagId]))[0]!;
   bindWriteCapability(tx,{...installed.binding,sourceUid:row.source});
   await writeAssertion(tx,declared,{sort:'edge',kind:'system.dispute-candidate',subjectId:String(flagId),property:'$exists',operation:'assert',value:false,validFrom:row.validFrom});
  });
  await owner.transaction('snapshot',async tx=>{
   const slots=await listDisputeSlots(tx,declared,{contexts:[1]});
   expect(slots.find(slot=>slot.kind==='flag')!.rows.find(row=>row.selected)?.value).toBe(true);
   expect(slots.find(slot=>slot.dispute.id===original.id)!.dispute.candidates).toEqual(original.candidates.filter(uid=>uid!==removed));
  });
 } finally {await owner.close();}
},30000);
