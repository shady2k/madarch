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
const baseContract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
const contract=baseContract;
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

// Each scenario gets a separate database and independent producer streams.
async function amendmentFixture(support=false){
 const {withManifestContract}=await import('../src/graph/manifest-contract.js');
 const contract:GraphContract=support?withAssertionContract(withManifestContract({...baseContract,edge:[{name:'justifies',from:['system.content-snapshot'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[],repeats:false,capability:'fixture'}]})):baseContract;
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const scope=await owner.transaction('write',async tx=>(await startupBinding(tx,contract,'amendment-scenarios')).binding.productUid);
 const identities=await Promise.all(['a','b','judge'].map(installationKey=>registerSystemSource(owner,contract,{type:'plugin',installationKey,scope,version:'1'})));
 const bindings=identities.map(identity=>bindGraphProducer(owner,contract,{principal:identity.principal,vertices:{sample:['amount'],'system.content-snapshot':['digest','content']},edges:support?{justifies:[]}:{},actions:['assert','retract-own','resolve']}));
 if(support)await owner.transaction('write',async tx=>{const {contract:published}=await startupBinding(tx,contract,'manifest-scenario');await publishGraphDrafts(tx,published,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify({file:'/fixture/catalog.yaml',kinds:{$map:[]},groups:{$map:[]},roles:{$map:[]},properties:{$map:[]},excludeDocuments:[],ignoreBlocks:[],findings:[],semanticBindings:{$map:[['evidence-support',{kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from',line:1}}}]]}})},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const write=async(index:number,value:number,validFrom='2020-01-01T00:00:00Z')=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[index]!);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount:value},validFrom,producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,contract);});
 const rows=async(validAt='2020-06-01T00:00:00Z',recordedAt=new Date().toISOString(),context=1)=>owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','sample',['amount'],undefined,{validAt,recordedAt,contexts:[context]}));
 const view=async(validAt='2020-06-01T00:00:00Z',recordedAt=new Date().toISOString(),context=1)=>owner.transaction('snapshot',async tx=>readDispute(tx,contract,await loadAssertions(tx,'vertex','sample',['amount']),{validAt,recordedAt,contexts:[context]}));
 await write(0,1);await write(1,2);
 const content='Retained scenario proof',digest=sha256Hex(Buffer.from(content));
 await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);await publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});});
 if(support)await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'file'},values:{},producer:'fixture',producerVersion:'1'}],edges:[{kind:'justifies',from:{kind:'system.content-snapshot',key:{digest}},to:{kind:'sample',key:{name:'file'}},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const retireSupport=async(revoke:boolean)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);if(revoke){const edge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'`)).rows[0]!;await writeAssertion(tx,contract,{sort:'edge',kind:'justifies',subjectId:edge.id,property:'$exists',operation:'retract'});}else{const edge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'`)).rows[0]!;await writeAssertion(tx,contract,{sort:'edge',kind:'justifies',subjectId:edge.id,property:'$exists',operation:'assert',value:false});const file=(await tx.query<{id:string}>(`SELECT id::text FROM node WHERE key->>'name'='file'`)).rows[0]!;await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:file.id,property:'$exists',operation:'assert',value:false});}await reconcileDisputes(tx,contract);});
 const resolve=async(locator?:Record<string,unknown>)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);const candidates=await loadAssertions(tx,'vertex','sample',['amount']);const q=(await readDispute(tx,contract,candidates,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}))!;return resolveDispute(tx,contract,bindings[2]!,{questionUid:q.id,chosenAssertionUid:candidates.find(row=>row.source===bindings[0]!.sourceUid&&row.operation==='assert')!.id,expectedCandidates:q.candidates,rationale:'Reviewed',evidence:[{target:{kind:'system.content-snapshot',key:{digest}},...(locator?{locator}:{})}]});});
 const withdraw=async(index:number)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[index]!);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String((await loadAssertions(tx,'vertex','sample',['amount']))[0]!.subjectId),property:'amount',operation:'retract',validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
 return {owner,bindings,write,rows,view,resolve,withdraw,digest,retireSupport,contract};
}
test('losing source repeat at a later valid start leaves the decision assertion selected',async()=>{
 const f=await amendmentFixture();try{await f.resolve();const before=(await f.rows()).find(row=>row.selected)!;await f.write(1,2,'2020-02-01T00:00:00Z');const after=(await f.rows()).find(row=>row.selected)!;expect(after.id).toBe(before.id);expect(after.value).toBe(1);expect((await f.view())?.state).toBe('RESOLVED');}finally{await f.owner.close();}
},30000);
test('new value closes the decision exactly at the changed segment start',async()=>{
 const f=await amendmentFixture();try{await f.resolve();await f.write(1,3,'2020-03-01T00:00:00Z');expect((await f.rows('2020-02-01T00:00:00Z')).find(row=>row.selected)?.value).toBe(1);expect((await f.rows()).find(row=>row.selected)?.value).toBe(3);expect((await f.view())?.state).toBe('OPEN');const retract=(await f.rows()).find(row=>row.operation==='retract');expect(new Date(retract!.validFrom).toISOString()).toBe('2020-03-01T00:00:00.000Z');}finally{await f.owner.close();}
},30000);
test('backdated change retracts the decision across the whole judged segment',async()=>{
 const f=await amendmentFixture();try{await f.resolve();const decision=(await f.rows()).find(row=>row.selected)!;await f.write(1,3,'2019-01-01T00:00:00Z');expect((await f.rows()).find(row=>row.source===decision.source&&row.operation==='retract')?.validFrom).toBe(decision.validFrom);expect((await f.view())?.state).toBe('OPEN');expect((await f.rows()).find(row=>row.selected)?.source).not.toBe(decision.source);}finally{await f.owner.close();}
},30000);
test('winning producer withdrawal closes decision but keeps the losing ordinary stream',async()=>{
 const f=await amendmentFixture();try{await f.resolve();await f.withdraw(0);expect((await f.rows()).find(row=>row.selected)?.value).toBe(2);expect((await f.view())?.state).toBe('OPEN');expect((await f.rows()).some(row=>row.operation==='retract'&&row.source!==f.bindings[0]!.sourceUid)).toBe(true);}finally{await f.owner.close();}
},30000);
test('revoked proof support retracts the decision over the whole judged scope',async()=>{
 const f=await amendmentFixture(true);try{await f.resolve();const before=(await f.rows()).find(row=>row.selected)!;await f.retireSupport(true);expect((await f.view())?.state).toBe('OPEN');const retract=(await f.rows()).find(row=>row.source===before.source&&row.operation==='retract');expect(retract?.validFrom).toBe(before.validFrom);expect((await f.rows()).find(row=>row.selected)?.source).not.toBe(before.source);}finally{await f.owner.close();}
},30000);
test('stale proof keeps the resolution and records a problem pointing to its explanation',async()=>{
 const f=await amendmentFixture(true);try{const resolution=await f.resolve();const before=(await f.rows()).find(row=>row.selected)!;await f.retireSupport(false);expect((await f.view())?.state).toBe('RESOLVED');expect((await f.rows()).find(row=>row.selected)?.id).toBe(before.id);await f.owner.transaction('snapshot',async tx=>{const about=await tx.query<{uid:string}>(`SELECT origin.uid::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node JOIN node origin ON origin.id=e.from_node WHERE k.name='system.problem-about' AND target.uid=$1::uuid`,[resolution]);expect(about.rows).toHaveLength(1);const reasons=await loadAssertions(tx,'vertex','system.problem',['reason']);expect(reasons.some(row=>row.subject.type==='vertex'&&row.subject.uid===about.rows[0]!.uid&&String(row.value).includes('stale'))).toBe(true);});}finally{await f.owner.close();}
},30000);
test('historical recorded cutoff distinguishes dispute before and after resolution at the same valid date',async()=>{
 const f=await amendmentFixture();try{const cutoff=new Date().toISOString();await f.resolve();expect((await f.view('2020-06-01T00:00:00Z',cutoff))?.state).toBe('OPEN');expect((await f.rows('2020-06-01T00:00:00Z',cutoff)).find(row=>row.selected)?.value).toBe(2);expect((await f.view())?.state).toBe('RESOLVED');expect((await f.rows()).find(row=>row.selected)?.value).toBe(1);}finally{await f.owner.close();}
},30000);
test('pinned branch cannot see a later base resolution',async()=>{
 const f=await amendmentFixture();try{const branch=await f.owner.transaction('write',tx=>pinContext(tx,'1','separate-branch'));await f.resolve();expect((await f.rows(undefined,undefined,Number(branch))).find(row=>row.selected)?.value).toBe(2);expect((await f.view(undefined,undefined,Number(branch)))?.state).toBe('OPEN');expect((await f.rows()).find(row=>row.selected)?.value).toBe(1);}finally{await f.owner.close();}
},30000);

test('reopening then resolving again records RESOLVED without retracting the replacement decision',async()=>{
 const f=await amendmentFixture();try{await f.resolve();await f.write(1,3);expect((await f.view())?.state).toBe('OPEN');await f.resolve();expect((await f.view())?.state).toBe('RESOLVED');const latest=(await f.rows()).find(row=>row.selected)!;expect(latest.value).toBe(1);await f.owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,f.bindings[1]!);await reconcileDisputes(tx,contract);});expect((await f.view())?.state).toBe('RESOLVED');expect((await f.rows()).find(row=>row.selected)?.id).toBe(latest.id);}finally{await f.owner.close();}
},30000);
async function edgeAmendmentFixture(){
 const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'}]}],edge:[{name:'sample-link',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'links',in:'linked'},ru:{out:'links',in:'linked'}},fields:[{name:'amount',type:'integer'}],repeats:false,capability:'fixture'}],dictionary:[]});
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const scope=await owner.transaction('write',async tx=>(await startupBinding(tx,contract,'amendment-scenarios')).binding.productUid);
 const identities=await Promise.all(['a','b','judge'].map(installationKey=>registerSystemSource(owner,contract,{type:'plugin',installationKey,scope,version:'1'})));
 const bindings=identities.map(identity=>bindGraphProducer(owner,contract,{principal:identity.principal,vertices:{sample:[],'system.content-snapshot':['digest','content']},edges:{'sample-link':['amount']},actions:['assert','retract-own','resolve']}));
 const write=async(index:number,value:number,validFrom='2020-01-01T00:00:00Z')=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[index]!);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{},producer:'fixture',producerVersion:'1'}],edges:[{kind:'sample-link',from:{kind:'sample',key:{name:'one'}},to:{kind:'sample',key:{name:'one'}},values:{amount:value},validFrom,producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,contract);});
 const rows=async(validAt='2020-06-01T00:00:00Z',recordedAt=new Date().toISOString(),context=1)=>owner.transaction('snapshot',tx=>loadAssertions(tx,'edge','sample-link',['amount'],undefined,{validAt,recordedAt,contexts:[context]}));
 const view=async(validAt='2020-06-01T00:00:00Z',recordedAt=new Date().toISOString(),context=1)=>owner.transaction('snapshot',async tx=>readDispute(tx,contract,await loadAssertions(tx,'edge','sample-link',['amount']),{validAt,recordedAt,contexts:[context]}));
 await write(0,1);await write(1,2);
 const content='Retained scenario proof',digest=sha256Hex(Buffer.from(content));
 await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);await publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const resolve=async()=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[2]!);const candidates=await loadAssertions(tx,'edge','sample-link',['amount']);const q=(await readDispute(tx,contract,candidates,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}))!;return resolveDispute(tx,contract,bindings[2]!,{questionUid:q.id,chosenAssertionUid:candidates.find(row=>row.source===bindings[0]!.sourceUid&&row.operation==='assert')!.id,expectedCandidates:q.candidates,rationale:'Reviewed',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});});
 const withdraw=async(index:number)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,bindings[index]!);await writeAssertion(tx,contract,{sort:'edge',kind:'sample-link',subjectId:String((await loadAssertions(tx,'edge','sample-link',['amount']))[0]!.subjectId),property:'amount',operation:'retract',validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
 return {owner,bindings,write,rows,view,resolve,withdraw,digest};
}
test('edge-subject decision closure uses the edge kind and keeps historical selection',async()=>{
 const f=await edgeAmendmentFixture();try{await f.resolve();const decision=(await f.rows()).find(row=>row.selected)!;expect(decision.subject.type).toBe('edge');const cutoff=new Date().toISOString();await f.withdraw(0);expect((await f.rows()).find(row=>row.selected)?.value).toBe(2);expect((await f.view())?.state).toBe('OPEN');expect((await f.rows('2020-06-01T00:00:00Z',cutoff)).find(row=>row.selected)?.id).toBe(decision.id);expect((await f.rows()).find(row=>row.operation==='retract'&&row.source===decision.source)?.validFrom).toBe(decision.validFrom);}finally{await f.owner.close();}
},30000);

test('parent dispute write refreshes an unpinned child holding its own statement for the slot',async()=>{
 const f=await amendmentFixture();try{
  const child=await f.owner.transaction('write',async tx=>(await tx.query<{id:string;parent_recorded_seq:string|null}>(`INSERT INTO context(parent,ref) VALUES(1,'working-copy') RETURNING id::text,parent_recorded_seq::text`)).rows[0]!);
  expect(child.parent_recorded_seq).toBeNull();
  await f.owner.transaction('write',async tx=>{const active=await activateGraphProducer(tx,contract,f.bindings[2]!);const {bindWriteCapability}=await import('../src/graph/write.js');bindWriteCapability(tx,{...active,context:Number(child.id)});await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount:2},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]},Number(child.id));await reconcileDisputes(tx,contract);});
  await f.resolve();
  expect((await f.view(undefined,undefined,Number(child.id)))?.state).toBe('RESOLVED');
  await f.write(0,4,'2020-03-01T00:00:00Z');
  expect((await f.view(undefined,undefined,Number(child.id)))?.state).toBe('OPEN');
  expect((await f.rows(undefined,undefined,Number(child.id))).find(row=>row.selected)?.value).toBe(4);
  await f.owner.transaction('snapshot',async tx=>{const states=await loadAssertions(tx,'vertex','system.dispute-question',['state']);expect(states.some(row=>row.context===Number(child.id)&&row.value==='OPEN')).toBe(true);});
 }finally{await f.owner.close();}
},30000);

test('invalid retained span is refused before recording a decision assertion',async()=>{
 const f=await amendmentFixture();try{const before=await f.rows();await expect(f.resolve({start:0,end:10000})).rejects.toThrow('EVIDENCE_INVALID locator outside immutable content');expect((await f.view())?.state).toBe('OPEN');expect((await f.rows()).map(row=>row.id)).toEqual(before.map(row=>row.id));}finally{await f.owner.close();}
},30000);

test('a legacy explanation without a decision link reopens without crashing',async()=>{
 const f=await amendmentFixture();try{const resolution=await f.resolve();await f.owner.transaction('write',async tx=>{const installed=await startupBinding(tx,contract,'legacy-resolution');const {bindWriteCapability}=await import('../src/graph/write.js');const edge=(await tx.query<{id:string}>(`SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node WHERE k.name='system.resolution-assertion' AND origin.uid=$1::uuid`,[resolution])).rows[0]!;const exists=(await loadAssertions(tx,'edge','system.resolution-assertion',['$exists'],[Number(edge.id)]))[0]!;bindWriteCapability(tx,{...installed.binding,sourceUid:exists.source});await writeAssertion(tx,contract,{sort:'edge',kind:'system.resolution-assertion',subjectId:edge.id,property:'$exists',operation:'retract',validFrom:exists.validFrom});});await expect(f.write(1,3)).resolves.toBeUndefined();expect((await f.view())?.state).toBe('OPEN');}finally{await f.owner.close();}
},30000);
test('reconciliation restores a recorded OPEN question to RESOLVED without retracting replacement decision',async()=>{
 const f=await amendmentFixture();try{await f.resolve();await f.write(1,3);await f.resolve();const decision=(await f.rows()).find(row=>row.selected)!;const q=(await f.view())!;await f.owner.transaction('write',async tx=>{await startupBinding(tx,contract,'system.disputes');const state=(await loadAssertions(tx,'vertex','system.dispute-question',['state'])).find(row=>row.subject.type==='vertex'&&row.subject.uid===q.id)!;await writeAssertion(tx,contract,{sort:'vertex',kind:'system.dispute-question',subjectId:String(state.subjectId),property:'state',operation:'assert',value:'OPEN',validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});expect((await f.view())?.state).toBe('RESOLVED');expect((await f.rows()).find(row=>row.selected)?.id).toBe(decision.id);}finally{await f.owner.close();}
},30000);
