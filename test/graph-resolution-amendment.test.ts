import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
import {activateGraphProducer,bindGraphProducer,type ProducerBinding} from '../src/graph/producer-binding.js';
import {publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {reconcileDisputes,resolveDispute} from '../src/graph/disputes.js';
import {readDispute} from '../src/graph/dispute-read.js';
import {pinContext} from '../src/graph/context.js';
import {sha256Hex} from '../src/graph/digest.js';
const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
test('resolution source preserves the principal ordinary correction after winner withdrawal and respects a pinned branch',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  const scope=await owner.transaction('write',async tx=>(await startupBinding(tx,contract,'amendment-fixture')).binding.productUid);
  const identities=await Promise.all(['producer','person'].map(installationKey=>registerSystemSource(owner,contract,{type:'plugin',installationKey,scope,version:'1'})));
  const bindings=identities.map(identity=>bindGraphProducer(owner,contract,{principal:identity.principal,vertices:{sample:['amount'],'system.content-snapshot':['digest','content']},edges:{},actions:['assert','retract-own','resolve']}));
  const write=async(binding:ProducerBinding,amount:number)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,binding);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,contract);});
  await write(bindings[0]!,1);await write(bindings[1]!,2);
  const branch=await owner.transaction('write',tx=>pinContext(tx,'1','before-resolution'));
  const content='Checked retained proof',digest=sha256Hex(Buffer.from(content));
  await owner.transaction('write',async tx=>{
   await activateGraphProducer(tx,contract,bindings[1]!);
   await publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});
   const rows=await loadAssertions(tx,'vertex','sample',['amount']);
   const question=(await readDispute(tx,contract,rows,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}))!;
   await resolveDispute(tx,contract,bindings[1]!,{questionUid:question.id,chosenAssertionUid:rows.find(row=>row.value===1)!.id,expectedCandidates:question.candidates,rationale:'Checked',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});
   await reconcileDisputes(tx,contract);
  });
  const selected=async(context=1)=>owner.transaction('snapshot',async tx=>(await loadAssertions(tx,'vertex','sample',['amount'],undefined,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[context]})).find(row=>row.selected));
  expect((await selected())?.value).toBe(1);
  expect((await selected())?.source).not.toBe(bindings[1]!.sourceUid);
  expect((await selected(Number(branch)))?.value).toBe(2);
  const beforeWithdrawal=new Date().toISOString();
  await owner.transaction('write',async tx=>{
   await activateGraphProducer(tx,contract,bindings[0]!);const rows=await loadAssertions(tx,'vertex','sample',['amount']);
   await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(rows[0]!.subjectId),property:'amount',operation:'retract',validFrom:'2020-01-01T00:00:00Z'});
   await reconcileDisputes(tx,contract);
  });
  expect((await selected())?.value).toBe(2);
  expect((await selected())?.source).toBe(bindings[1]!.sourceUid);
  await owner.transaction('snapshot',async tx=>{
   const rows=await loadAssertions(tx,'vertex','sample',['amount']);
   expect((await readDispute(tx,contract,rows,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}))?.state).toBe('OPEN');
   const historical=await loadAssertions(tx,'vertex','sample',['amount'],undefined,{validAt:'2020-06-01T00:00:00Z',recordedAt:beforeWithdrawal,contexts:[1]});
   expect(historical.find(row=>row.selected)?.value).toBe(1);
  });
 }finally{await owner.close();}
},30000);
