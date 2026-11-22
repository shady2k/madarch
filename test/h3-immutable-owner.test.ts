import {expect,test} from 'bun:test';
import {generatedTableName,type GraphContract,type VertexDraft} from '../src/graph/contract.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {readKindAssertions} from '../src/graph/records.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {createTestDatabaseOwner} from './test-database.js';

const graph:GraphContract={vertex:[{name:'code.commit',table:generatedTableName('code.commit','vertex'),key:['hash'],fields:[{name:'hash',type:'text'},{name:'message',type:'text'}],capability:'fixture',evidence:{immutable:true,digestField:'hash'}}],edge:[],dictionary:[]};
const commit:VertexDraft={kind:'code.commit',key:{hash:'20'},values:{message:'original owner value'},producer:'fixture',producerVersion:'1'};

for(const operation of ['remove','change value'] as const){
 test(`H3 ${operation==='remove'?'A3':'A4'} immutable owner ${operation} is refused by the graph writer`,async()=>{
  const owner=await createTestDatabaseOwner({graphContract:graph});
  try{
   const other:VertexDraft={...commit,key:{hash:'21'}};
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[commit],removals:[]}));
   const before=await owner.run(tx=>loadAssertions(tx,'vertex','code.commit',['$exists','hash','message']));
   const attempt=owner.transaction('write',async tx=>{
    await publishGraphDrafts(tx,graph,{vertices:[other],removals:[]});
    await publishGraphDrafts(tx,graph,operation==='remove'
     ?{vertices:[],removals:[{kind:commit.kind,key:commit.key,producer:'fixture'}]}
     :{vertices:[{...commit,values:{message:'changed owner value'}}],removals:[]});
   });
   const diagnostic=operation==='remove'?'128: IMMUTABLE_EVIDENCE immutable support cannot be retired':'130: IMMUTABLE_EVIDENCE support values cannot change';
   await expect(attempt).rejects.toEqual(new Error(`${new URL('../src/graph/write.ts',import.meta.url).pathname}:${diagnostic}`));
   const after=await owner.run(tx=>loadAssertions(tx,'vertex','code.commit',['$exists','hash','message']));
   expect(after).toEqual(before);
   expect(after.filter(row=>row.operation==='assert'&&row.validTo===null).map(row=>[row.property,row.value])).toEqual(expect.arrayContaining([['$exists',true],['message','original owner value']]));
   const retained=await owner.run(tx=>readKindAssertions(tx,'vertex','code.commit',['message'],{contract:graph}));
   expect(retained.map(row=>({key:row.key,message:row.values.message}))).toEqual([{key:commit.key,message:'original owner value'}]);
  }finally{await owner.close();}
 },30000);
}
