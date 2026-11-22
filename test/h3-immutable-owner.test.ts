import {expect,test} from 'bun:test';
import {generatedTableName,type GraphContract,type VertexDraft} from '../src/graph/contract.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {createTestDatabaseOwner} from './test-database.js';

const graph:GraphContract={vertex:[{name:'code.commit',table:generatedTableName('code.commit','vertex'),key:['hash'],fields:[{name:'hash',type:'text'},{name:'message',type:'text'}],capability:'fixture',evidence:{immutable:true,digestField:'hash'}}],edge:[],dictionary:[]};
const commit:VertexDraft={kind:'code.commit',key:{hash:'20'},values:{message:'original owner value'},producer:'fixture',producerVersion:'1'};

for(const operation of ['remove','change value'] as const){
 test(`H3 ${operation==='remove'?'A3':'A4'} immutable owner ${operation} is refused by the graph writer`,async()=>{
  const owner=await createTestDatabaseOwner({graphContract:graph});
  try{
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[commit],removals:[]}));
   const before=await owner.run(tx=>loadAssertions(tx,'vertex','code.commit',['$exists','hash','message']));
   const attempt=owner.transaction('write',tx=>publishGraphDrafts(tx,graph,operation==='remove'
    ?{vertices:[],removals:[{kind:commit.kind,key:commit.key,producer:'fixture'}]}
    :{vertices:[{...commit,values:{message:'changed owner value'}}],removals:[]}));
   const diagnostic=operation==='remove'?'128: IMMUTABLE_EVIDENCE immutable support cannot be retired':'130: IMMUTABLE_EVIDENCE support values cannot change';
   await expect(attempt).rejects.toEqual(new Error(`${new URL('../src/graph/write.ts',import.meta.url).pathname}:${diagnostic}`));
   expect(await owner.run(tx=>loadAssertions(tx,'vertex','code.commit',['$exists','hash','message']))).toEqual(before);
  }finally{await owner.close();}
 },30000);
}
