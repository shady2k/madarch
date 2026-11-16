import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {newUid} from '../src/graph/uid.js';

const contract:GraphContract=withAssertionContract({vertex:[{name:'repeat-fixture',table:generatedTableName('repeat-fixture','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
test('0039 amendment: repeating a stream value retains its header and attaches the new pass',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),sourceUid=newUid(),first=newUid(),second=newUid();
 const bind=(tx:Parameters<typeof bindWriteCapability>[0],operationUid:string)=>bindWriteCapability(tx,{productUid,principalUid,sourceUid,operationUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:[{kind:'repeat-fixture',properties:['*'],assert:true,retractOwn:true}]});
 try{
  await owner.transaction('write',async tx=>{
   for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',first],['system.operation',second]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
   bind(tx,first);
   await publishGraphDrafts(tx,contract,{vertices:[{kind:'repeat-fixture',key:{name:'one'},values:{amount:7},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  const original=(await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount'])))[0]!;
  const repeated=await owner.transaction('write',async tx=>{
   bind(tx,second);
   return await writeAssertion(tx,contract,{sort:'vertex',kind:'repeat-fixture',subjectId:String(original.subjectId),property:'amount',operation:'assert',value:7,validFrom:'2021-01-01T00:00:00Z'});
  });
  expect(repeated).toBe(original.id);
  const headers=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount']));
  expect(headers).toHaveLength(1);
  expect(headers[0]!.recordedSequence).toBe(original.recordedSequence);
  const passes=await owner.run(tx=>tx.query<{uid:string}>(`SELECT target.uid::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE origin.uid=$1::uuid AND k.name='system.assertion-operation' ORDER BY target.uid`,[original.id]));
  expect(passes.rows.map(row=>row.uid).sort()).toEqual([first,second].sort());
 }finally{await owner.close();}
});
