import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {pinContext} from '../src/graph/context.js';
import {loadAssertions,loadAssertionsBatch} from '../src/graph/assertion-read.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
const graph:GraphContract={vertex:[{name:'typed',table:generatedTableName('typed','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'amount',type:'bigint'},{name:'when',type:'timestamp'},{name:'enabled',type:'boolean'},{name:'details',type:'json',schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}],capability:'fixture'}],edge:[],dictionary:[]};
test('assertion property batch preserves native typed values and subject filtering',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:['one','two'].map(name=>({kind:'typed',key:{name},values:{amount:name==='one'?'9223372036854775807':'9007199254740991',when:'2026-01-01T12:00:00.123Z',enabled:true,details:{count:3}},producer:'fixture',producerVersion:'1'})),removals:[]});});
  await owner.run(async tx=>{
   const identities=await tx.query<{id:number}>(`SELECT id FROM node WHERE key->>'name'='one'`);
   let reads=0;const executor={query:((...args:Parameters<typeof tx.query>)=>{reads++;return tx.query(...args);}) as typeof tx.query};
   const rows=await loadAssertions(executor,'vertex','typed',['amount','when','enabled','details'],[Number(identities.rows[0]!.id)]);
   expect(rows[0]!.evidenceAttachments).toEqual([]);
   expect(reads).toBe(1);expect(rows.map(row=>[row.property,row.value])).toEqual([['amount','9223372036854775807'],['when','2026-01-01T12:00:00.123Z'],['enabled',true],['details',{count:3}]]);
   expect(await loadAssertions(executor,'vertex','typed',['amount'],[])).toEqual([]);expect(reads).toBe(1);
   const all=await loadAssertions(executor,'vertex','typed',['amount']);
   expect(all.map(row=>row.value)).toEqual(['9223372036854775807',9007199254740991]);
   const beforeBatch=reads;
   const batches=await loadAssertionsBatch(executor,[
    {sort:'vertex',kind:'typed',properties:['amount'],subjectIds:[Number(identities.rows[0]!.id)]},
    {sort:'vertex',kind:'typed',properties:['enabled','amount']},
    {sort:'vertex',kind:'typed',properties:['details'],subjectIds:[]},
   ]);
   expect(reads-beforeBatch).toBe(1);
   expect(batches.map(batch=>batch.map(row=>[row.property,row.value]))).toEqual([
    [['amount','9223372036854775807']],
    [['enabled',true],['enabled',true],['amount','9223372036854775807'],['amount',9007199254740991]],
    [],
   ]);
  });
 }finally{await owner.close();}
},30000);


test('SQL item 25 selects backdated corrections by recorded sequence and pins branch bases',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  let id=0;let branch='';let before='';
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'one'},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
   id=Number((await tx.query<{id:number}>("SELECT id FROM node WHERE key->>'name'='one'")).rows[0]!.id);
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:2,validFrom:'2022-01-01T00:00:00Z'});
  });
  await owner.transaction('write',async tx=>{branch=await pinContext(tx,'1','fixture-branch');before=(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;});
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:3,validFrom:'2021-01-01T00:00:00Z'});
  });
  await owner.run(async tx=>{
   const selected=async(contexts:number[],recordedAt?:string)=>(await loadAssertions(tx,'vertex','typed',['amount'],[id],{validAt:'2023-01-01T00:00:00Z',contexts,...(recordedAt===undefined?{}:{recordedAt})})).filter(row=>row.selected).map(row=>row.value);
   expect(await selected([1])).toEqual([3]);
   expect(await selected([1],before)).toEqual([2]);
   expect(await selected([Number(branch)])).toEqual([2]);
  });
 } finally {await owner.close();}
});
