import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {newUid} from '../src/graph/uid.js';

const contract:GraphContract=withAssertionContract({vertex:[{name:'repeat-fixture',table:generatedTableName('repeat-fixture','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
test.each([
 {name:'extending an explicit end',originalTo:'2021-01-01T00:00:00Z',nextTo:'2022-01-01T00:00:00Z',later:false},
 {name:'narrowing an explicit end',originalTo:'2022-01-01T00:00:00Z',nextTo:'2021-01-01T00:00:00Z',later:false},
 {name:'backdating an equal value over a newer different value',originalTo:null,nextTo:null,later:true},
])('0039 repeat preserves meaning when $name',async ({originalTo,nextTo,later})=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),sourceUid=newUid();
 const bind=(tx:Parameters<typeof bindWriteCapability>[0],operationUid:string)=>bindWriteCapability(tx,{productUid,principalUid,sourceUid,operationUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:[{kind:'repeat-fixture',properties:['*'],assert:true,retractOwn:true}]});
 try{
  await owner.transaction('write',async tx=>{
   const operationUid=newUid();
   for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
   bind(tx,operationUid);
   await publishGraphDrafts(tx,contract,{vertices:[{kind:'repeat-fixture',key:{name:'one'},values:{amount:7},validFrom:'2020-01-01T00:00:00Z',validTo:originalTo,producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  const original=(await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount'])))[0]!;
  const write=async(value:number,validFrom:string,validTo:string|null)=>await owner.transaction('write',async tx=>{
   const operationUid=newUid();await bootstrapWriteIdentity(tx,'system.operation',operationUid,productUid);bind(tx,operationUid);
   return await writeAssertion(tx,contract,{sort:'vertex',kind:'repeat-fixture',subjectId:String(original.subjectId),property:'amount',operation:'assert',value,validFrom,validTo});
  });
  if(later)await write(9,'2021-01-01T00:00:00Z',null);
  const changed=await write(7,'2020-01-01T00:00:00Z',nextTo);
  expect(changed).not.toBe(original.id);
  const headers=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount']));
  expect(headers).toHaveLength(later?3:2);
  expect(headers.find(row=>row.id===changed)?.validTo).toBe(nextTo===null?null:new Date(nextTo).toISOString());
  const selected=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount'],[original.subjectId],{validAt:later?'2021-06-01T00:00:00Z':'2020-06-01T00:00:00Z'}));
  expect(selected.find(row=>row.selected)?.id).toBe(changed);
 }finally{await owner.close();}
});
