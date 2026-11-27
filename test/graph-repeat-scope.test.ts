import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {newUid} from '../src/graph/uid.js';

const contract:GraphContract=withAssertionContract({vertex:[{name:'repeat-fixture',table:generatedTableName('repeat-fixture','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'},{name:'label',type:'text'},{name:'observed',type:'timestamp',nullable:true}]}],edge:[{name:'repeat-link',table:generatedTableName('repeat-link','edge'),from:['repeat-fixture'],to:['repeat-fixture'],repeats:false,cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked by'},ru:{out:'links',in:'linked by'}},fields:[{name:'observed',type:'timestamp',nullable:true}],capability:'fixture'}],dictionary:[]});
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

// Equal instants, null opinions and withdrawals must remain distinct stream states.
test.each(['vertex','edge'] as const)('0039 repeat normalizes nullable timestamps on a %s without swallowing withdrawals',async sort=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),sourceUid=newUid();
 const bind=(tx:Parameters<typeof bindWriteCapability>[0],operationUid:string)=>bindWriteCapability(tx,{productUid,principalUid,sourceUid,operationUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:['repeat-fixture','repeat-link'].map(kind=>({kind,properties:['*'],assert:true,retractOwn:true}))});
 try{
  await owner.transaction('write',async tx=>{
   const operationUid=newUid();
   for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
   bind(tx,operationUid);
   await publishGraphDrafts(tx,contract,{vertices:['one','two'].map(name=>({kind:'repeat-fixture',key:{name},values:{amount:7},producer:'fixture',producerVersion:'1'})),edges:[{kind:'repeat-link',from:{kind:'repeat-fixture',key:{name:'one'}},to:{kind:'repeat-fixture',key:{name:'two'}},producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  const kind=sort==='vertex'?'repeat-fixture':'repeat-link';
  const subjects=await owner.transaction('snapshot',tx=>loadAssertions(tx,sort,kind,['$exists']));
  const subjectId=subjects[0]!.subjectId;
  const write=async(operation:'assert'|'retract',value?:string|null)=>owner.transaction('write',async tx=>{
   const operationUid=newUid();await bootstrapWriteIdentity(tx,'system.operation',operationUid,productUid);bind(tx,operationUid);
   return writeAssertion(tx,contract,{sort,kind,subjectId:String(subjectId),property:'observed',operation,...(operation==='assert'?{value}:{}),validFrom:'2020-01-01T00:00:00Z',validTo:'2022-01-01T00:00:00Z'});
  });
  const initial=await write('assert','2020-02-01T03:00:00+03:00');
  expect(await write('assert','2020-02-01T00:00:00.000Z')).toBe(initial);
  const empty=await write('assert',null);
  expect(empty).not.toBe(initial);
  expect(await write('assert',null)).toBe(empty);
  const withdrawn=await write('retract');
  expect(withdrawn).not.toBe(empty);
  const withdrawnAgain=await write('retract');
  expect(withdrawnAgain).not.toBe(withdrawn);
  const restored=await write('assert','2020-02-01T00:00:00Z');
  expect(restored).not.toBe(initial);
  expect(await write('assert','2020-02-01T03:00:00+03:00')).toBe(restored);
  const headers=await owner.transaction('snapshot',tx=>loadAssertions(tx,sort,kind,['observed'],[subjectId],{validAt:'2021-01-01T00:00:00Z'}));
  expect(headers).toHaveLength(5);
  expect(headers.filter(row=>row.operation==='retract')).toHaveLength(2);
  expect(headers.find(row=>row.selected)?.id).toBe(restored);
  expect(headers.find(row=>row.id===empty)?.value).toBeNull();
 }finally{await owner.close();}
});

test('0039 repeat keeps language and historical interval boundaries',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),sourceUid=newUid();
 const bind=(tx:Parameters<typeof bindWriteCapability>[0],operationUid:string)=>bindWriteCapability(tx,{productUid,principalUid,sourceUid,operationUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:[{kind:'repeat-fixture',properties:['*'],assert:true,retractOwn:true}]});
 try{
  await owner.transaction('write',async tx=>{
   const operationUid=newUid();
   for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
   bind(tx,operationUid);
   await publishGraphDrafts(tx,contract,{vertices:[{kind:'repeat-fixture',key:{name:'one'},values:{amount:7},producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  const subject=(await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['amount'])))[0]!;
  const write=async(value:string,language:string,validFrom:string,validTo='2022-01-01T00:00:00Z')=>owner.transaction('write',async tx=>{
   const operationUid=newUid();await bootstrapWriteIdentity(tx,'system.operation',operationUid,productUid);bind(tx,operationUid);
   return writeAssertion(tx,contract,{sort:'vertex',kind:'repeat-fixture',subjectId:String(subject.subjectId),property:'label',operation:'assert',value,language,validFrom,validTo});
  });
  const english=await write('same','en','2020-01-01T00:00:00Z');
  const russian=await write('same','ru','2020-01-01T00:00:00Z');
  expect(russian).not.toBe(english);
  expect(await write('same','en','2020-06-01T00:00:00Z')).toBe(english);
  // The future opinion does not intersect the repeated finite interval.
  const future=await write('later','en','2023-01-01T00:00:00Z','2024-01-01T00:00:00Z');
  expect(future).not.toBe(english);
  expect(await write('same','en','2020-06-01T00:00:00Z')).toBe(english);
  const headers=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','repeat-fixture',['label'],[subject.subjectId],{validAt:'2021-01-01T00:00:00Z'}));
  expect(headers).toHaveLength(3);
  expect(headers.filter(row=>row.selected).map(row=>row.id).sort()).toEqual([english,russian].sort());
 }finally{await owner.close();}
});
