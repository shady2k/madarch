import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {newUid} from '../src/graph/uid.js';
import {activeExistenceSql,loadAssertions} from '../src/graph/assertion-read.js';
import {reconcileDisputes,resolveDispute} from '../src/graph/disputes.js';
import {readDispute,listDisputeSlots,loadResolutionAssertion} from '../src/graph/dispute-read.js';
import {bindGraphProducer,activateGraphProducer,type ProducerBinding} from '../src/graph/producer-binding.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
type ResolutionHost=import('../src/graph/operation-host.js').OperationHost;
const executeResolution=(host:ResolutionHost,declared:GraphContract,binding:ProducerBinding,request:{key:string;input:import('../src/graph/disputes.js').ResolveDisputeInput})=>host.execute({key:request.key,request:request.input},tx=>resolveDispute(tx,declared,binding,request.input));
const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});
test('0039.16: writer stores one question for overlapping cross-source disagreement, not ordinary source history',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),operationUid=newUid(),a=newUid(),b=newUid();
 const bind=(tx:Parameters<typeof bindWriteCapability>[0],sourceUid:string)=>bindWriteCapability(tx,{productUid,principalUid,operationUid,sourceUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:[{kind:'sample',properties:['*'],assert:true,retractOwn:true}]});
 try{
  await owner.transaction('write',async tx=>{for(const [kind,uid] of [['source',a],['source',b],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);bind(tx,a);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,contract);});
  const amount=async()=>await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','sample',['amount']));
  const view=async()=>await owner.transaction('snapshot',async tx=>{const rows=await loadAssertions(tx,'vertex','sample',['amount']);return await readDispute(tx,contract,rows,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]});});
  expect(await view()).toBeNull();
  const id=String((await amount())[0]!.subjectId);
  await owner.transaction('write',async tx=>{bind(tx,a);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:id,property:'amount',operation:'assert',value:2,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
  expect(await view()).toBeNull();
  await owner.transaction('write',async tx=>{bind(tx,b);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:id,property:'amount',operation:'assert',value:3,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
  const question=await view();expect(question?.state).toBe('OPEN');expect(question?.candidates).toHaveLength(2);
  const unchangedCandidate=(await amount()).find(row=>row.source===a&&row.value===2)!.id;
  const expectSingleExistence=async()=>await owner.transaction('snapshot',async tx=>{
   expect((await loadAssertions(tx,'edge','system.dispute-candidate',['$exists'])).filter(row=>row.subject.type==='edge'&&row.subject.from===question!.id&&row.subject.to===unchangedCandidate)).toHaveLength(1);
   expect((await loadAssertions(tx,'vertex','system.dispute-question',['$exists'])).filter(row=>row.subject.type==='vertex'&&row.subject.uid===question!.id)).toHaveLength(1);
  });
  await expectSingleExistence();
  await owner.transaction('write',async tx=>{bind(tx,b);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:id,property:'amount',operation:'assert',value:3,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
  expect((await view())?.id).toBe(question!.id);
  await owner.transaction('write',async tx=>{bind(tx,b);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:id,property:'amount',operation:'retract',validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
  expect((await view())?.state).toBe('DISMISSED');
  expect((await view())?.id).toBe(question!.id);
  await expectSingleExistence();
  await owner.transaction('snapshot',async tx=>{
   const {readKindAssertions}=await import('../src/graph/records.js');
   const [record]=await readKindAssertions(tx,'vertex','sample',['amount'],{contract});
   const {selectAssertions}=await import('../src/graph/assertion-selection.js');
   expect(selectAssertions(record!.assertions.filter(row=>row.property==='amount'),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}).contested).toBe(false);expect(record?.values['amount']).toBe(2);
  });
  await owner.transaction('write',async tx=>{bind(tx,b);await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:id,property:'amount',operation:'assert',value:4,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);});
  expect((await view())?.state).toBe('OPEN');expect((await view())?.id).toBe(question!.id);
  await expectSingleExistence();
  await owner.transaction('snapshot',async tx=>expect((await tx.query(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.dispute-question'`)).rows).toHaveLength(1));
  await expect(owner.transaction('write',async tx=>{bind(tx,a);await resolveDispute(tx,contract,{} as ProducerBinding,{questionUid:question!.id,chosenAssertionUid:question!.candidates[0]!,expectedCandidates:question!.candidates,rationale:'A reason',evidence:[]});})).rejects.toThrow('does not permit resolve');
 }finally{await owner.close();}
},30000);

for(const withdraw of [false,true])test(`0039.17/27: durable resolution survives repeats, ${withdraw?'dismisses on withdrawal':'reopens on changed value'}, and preserves historical snapshot`,async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  const {startupBinding}=await import('../src/graph/manifest-publication.js');
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,contract,'dispute-fixture')).binding.productUid);
  const a=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'a',scope:productScope,version:'1'});
  const b=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'b',scope:productScope,version:'1'});
  const resolver=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'resolver',scope:productScope,version:'1'});
  const grant=(principal:typeof a.principal,resolve=false)=>bindGraphProducer(owner,contract,{principal,vertices:{sample:['amount'],'system.content-snapshot':['digest','content']},edges:{},actions:resolve?['assert','resolve']:['assert','retract-own']});
  const ga=grant(a.principal),gb=grant(b.principal),gr=grant(resolver.principal,true);
  const write=async(binding:ProducerBinding,value:number)=>await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,binding);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{amount:value},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,contract);});
  await write(ga,1);await write(gb,2);
  const view=async(recordedAt=new Date().toISOString())=>await owner.transaction('snapshot',async tx=>{const rows=await loadAssertions(tx,'vertex','sample',['amount']);const target=rows[0]!;return await readDispute(tx,contract,rows.filter(row=>row.subjectId===target.subjectId),{validAt:new Date().toISOString(),recordedAt,contexts:[1]});});
  const question=(await view())!;
  const {createHash}=await import('node:crypto');const content='Evidence';const digest=createHash('sha256').update(content).digest('hex');
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,gr);await publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});});
  const {createOperationHost,initializeOperationScope}=await import('../src/graph/operation-host.js');
  const {prepareQueueSchema}=await import('../src/adapters/schemas/queue.js');
  const {createPgBossQueue}=await import('../src/adapters/pg-boss-queue.js');
  const declaration={name:'resolve-fixture',leaseSeconds:60,retries:1,retryDelaySeconds:0,retryBackoff:false};
  await prepareQueueSchema(owner,{declarations:[declaration]});const queue=await createPgBossQueue({owner,supervise:false});
  try{
   await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});const [job]=await queue.claim({queue:declaration.name});
   const capability=await owner.transaction('write',tx=>activateGraphProducer(tx,contract,gr));
   const runUid=newUid(),unitUid=newUid();await owner.transaction('write',tx=>initializeOperationScope(tx,contract,capability,runUid,unitUid));
   const host=createOperationHost({owner,queue,job:job!,contract,capability,runUid,unitUid});
   const input={questionUid:question.id,chosenAssertionUid:question.candidates[1]!,expectedCandidates:question.candidates,rationale:'Checked evidence',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]};
   await expect(executeResolution(host,contract,{} as ProducerBinding,{key:'forged',input})).rejects.toThrow('does not permit resolve');
   await owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,gr);await publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'unrelated'},values:{amount:9},producer:'fixture',producerVersion:'1'}],removals:[]});});
   const unrelatedUid=(await owner.run(tx=>tx.query<{uid:string}>(`SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'='unrelated'`))).rows[0]!.uid;
   const unrelatedScope=bindGraphProducer(owner,contract,{principal:resolver.principal,vertices:{sample:['amount']},edges:{},scopeUid:unrelatedUid,actions:['resolve']});
   await expect(owner.transaction('write',async tx=>{
    await activateGraphProducer(tx,contract,unrelatedScope);
    await resolveDispute(tx,contract,unrelatedScope,input);
   })).rejects.toThrow('assertion outside authenticated scope');
   const uid=await executeResolution(host,contract,gr,{key:'resolve',input});
   await owner.transaction('snapshot',async tx=>expect((await loadAssertions(tx,'vertex','system.dispute-question',['$exists'])).filter(row=>row.subject.type==='vertex'&&row.subject.uid===question.id)).toHaveLength(1));
   expect(await executeResolution(host,contract,gr,{key:'resolve',input})).toBe(uid);
   await expect(executeResolution(host,contract,gr,{key:'stale',input:{...input,expectedCandidates:[]}})).rejects.toThrow('REVISION_CONFLICT');
  }finally{await queue.stop();}
  const resolved=(await view())!;expect(resolved.state).toBe('RESOLVED');expect(resolved.selectedAssertionUid).not.toBe(question.candidates[1]!);
  await owner.transaction('snapshot',async tx=>{
   const selector={validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]};
   expect((await listDisputeSlots(tx,contract,selector)).map(slot=>slot.dispute.selectedAssertionUid)).toContain(resolved.selectedAssertionUid!);
   const assertion=await loadResolutionAssertion(tx,contract,resolved.resolution!,await loadAssertions(tx,'vertex','sample',['amount']),selector);
   expect(assertion?.author).toBe(resolver.sourceUid);expect(assertion?.evidence).toHaveLength(1);
   expect(assertion?.id).not.toBe(resolved.resolution);
   const stored=await loadAssertions(tx,'vertex','sample',['amount']);
   expect(stored.find(row=>row.id===assertion?.id)??null).toEqual(assertion);
   expect(assertion?.source).not.toBe(resolver.sourceUid);
   expect(assertion?.validFrom).toBe('2020-01-01T00:00:00.000Z');
   expect(assertion?.validTo).toBeNull();
  });
  await expect(owner.transaction('write',async tx=>{await activateGraphProducer(tx,contract,gr);await resolveDispute(tx,contract,gr,{questionUid:question.id,chosenAssertionUid:question.candidates[1]!,expectedCandidates:[],rationale:'Stale',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});})).rejects.toThrow('REVISION_CONFLICT');
  await owner.transaction('snapshot',async tx=>{
   const rows=await loadAssertions(tx,'vertex','sample',['amount'],undefined,{validAt:'2020-06-01T00:00:00Z',recordedAt:new Date().toISOString(),contexts:[1]});
   expect(rows.find(row=>row.selected)?.id).toBe(resolved.selectedAssertionUid!);
  });
  const cutoff=new Date().toISOString();
  await write(gb,2);const repeated=(await view())!;expect(repeated.id).toBe(question.id);expect(repeated.state).toBe('RESOLVED');expect(repeated.resolution).toBe(resolved.resolution);
  if(withdraw)await owner.transaction('write',async tx=>{
   await activateGraphProducer(tx,contract,gb);
   const rows=await loadAssertions(tx,'vertex','sample',['amount']);const target=rows.find(row=>row.id===question.candidates[0])!;
   await writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(target.subjectId),property:'amount',operation:'retract',validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,contract);
  });else await write(gb,3);
  const reopened=(await view())!;expect(reopened.id).toBe(question.id);expect(reopened.state).toBe(withdraw?'DISMISSED':'OPEN');expect(reopened.supersededResolutions).toContain(resolved.resolution!);
  expect((await view(cutoff))!.state).toBe('RESOLVED');
  await owner.transaction('snapshot',async tx=>{
   const rows=await loadAssertions(tx,'vertex','sample',['amount'],undefined,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]});
   const original=rows.find(row=>row.id===question.candidates[0])!;
   expect(rows.find(row=>row.selected&&row.subjectId===original.subjectId)?.value).toBe(withdraw?1:3);
   expect(rows.find(row=>row.selected&&row.subjectId===original.subjectId)?.source).toBe(withdraw?ga.sourceUid:gb.sourceUid);
   expect(rows.find(row=>row.id===resolved.selectedAssertionUid)?.selected).toBe(false);
  });
 }finally{await owner.close();}
},30000);

test('0039.16/27: equal and nonoverlapping values do not create questions; future edge disputes retain edge subjects',async()=>{
 const declared=withAssertionContract({...contract,edge:[{name:'sample-link',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'link',in:'link'},ru:{out:'link',in:'link'}},fields:[{name:'amount',type:'integer'}],repeats:false,capability:'fixture'}]});
 const owner=await createTestDatabaseOwner({graphContract:declared});
 try{
  const productUid=newUid(),principalUid=newUid(),operationUid=newUid(),a=newUid(),b=newUid();
  const bind=async(tx:Parameters<typeof bindWriteCapability>[0],sourceUid:string)=>{for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);bindWriteCapability(tx,{productUid,principalUid,operationUid,sourceUid,context:1,scope:productUid,contractVersion:graphContractVersion(declared),permissions:['sample','sample-link'].map(kind=>({kind,properties:['*'],assert:true,retractOwn:true}))});};
  const left={kind:'sample',key:{name:'left'}},right={kind:'sample',key:{name:'right'}};
  const write=async(source:string,value:number,from:string,to:string|null)=>owner.transaction('write',async tx=>{await bind(tx,source);await publishGraphDrafts(tx,declared,{vertices:[{...left,values:{amount:value},validFrom:from,validTo:to,producer:'fixture',producerVersion:'1'},{...right,producer:'fixture',producerVersion:'1'}],edges:[{kind:'sample-link',from:left,to:right,values:{amount:value},validFrom:from,validTo:to,producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,declared);});
  await owner.transaction('write',async tx=>{await bind(tx,a);await publishGraphDrafts(tx,declared,{vertices:[{...left,producer:'fixture',producerVersion:'1',validFrom:'2000-01-01T00:00:00Z'},{...right,producer:'fixture',producerVersion:'1',validFrom:'2000-01-01T00:00:00Z'}],removals:[]});});
  await write(a,1,'2020-01-01T00:00:00Z','2021-01-01T00:00:00Z');await write(b,2,'2021-01-01T00:00:00Z','2022-01-01T00:00:00Z');
  await owner.transaction('snapshot',async tx=>expect((await tx.query(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.dispute-question'`)).rows).toHaveLength(0));
  await write(a,3,'2035-01-01T00:00:00Z',null);await write(b,3,'2035-01-01T00:00:00Z',null);
  await owner.transaction('snapshot',async tx=>expect((await tx.query(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.dispute-question'`)).rows).toHaveLength(0));
  const {pinContext}=await import('../src/graph/context.js');
  const branch=await owner.transaction('write',tx=>pinContext(tx,'1','before-later-assertion'));
  await write(b,4,'2035-01-01T00:00:00Z',null);
  const {resolveEntityRef,requireWriteCapability}=await import('../src/graph/write.js');
  await expect(owner.transaction('write',async tx=>{
   await bind(tx,a);const active=requireWriteCapability(tx);bindWriteCapability(tx,{...active,context:Number(branch)});
   const rows=await loadAssertions(tx,'edge','sample-link',['amount']);const later=rows.find(row=>row.value===4)!;
   await resolveEntityRef(tx,declared,{kind:'system.assertion',uid:later.id,key:{}},Number(branch));
  })).rejects.toThrow('MISSING_ENDPOINT');

  await owner.transaction('snapshot',async tx=>{
   const rows=await loadAssertions(tx,'edge','sample-link',['amount']);const selector={validAt:'2036-01-01T00:00:00Z',recordedAt:new Date().toISOString(),contexts:[1]};
   const dispute=await readDispute(tx,declared,rows,selector);expect(dispute?.state).toBe('OPEN');expect(dispute?.candidates).toHaveLength(2);expect(rows[0]!.subject.type).toBe('edge');
   expect(await readDispute(tx,declared,rows,{...selector,validAt:'2030-01-01T00:00:00Z'})).toBeNull();
  });
 }finally{await owner.close();}
},60000);

test('0039.27: withdrawing declared support reopens resolution through the operation hook and retains history',async()=>{
 const {withManifestContract}=await import('../src/graph/manifest-contract.js');
 const declared=withAssertionContract(withManifestContract({...contract,edge:[{name:'justifies',from:['system.content-snapshot'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[],repeats:false,capability:'fixture'}]}));
 const owner=await createTestDatabaseOwner({graphContract:declared});
 const {createOperationHost,initializeOperationScope}=await import('../src/graph/operation-host.js');
 const {prepareQueueSchema}=await import('../src/adapters/schemas/queue.js');
 const {createPgBossQueue}=await import('../src/adapters/pg-boss-queue.js');
 const {startupBinding}=await import('../src/graph/manifest-publication.js');
 const declaration={name:'withdraw-support',leaseSeconds:60,retries:1,retryDelaySeconds:0,retryBackoff:false};
 await prepareQueueSchema(owner,{declarations:[declaration]});const queue=await createPgBossQueue({owner,supervise:false});
 try{
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,declared,'dispute-support-fixture')).binding.productUid);
  const sources=await Promise.all(['a','b','resolver'].map(installationKey=>registerSystemSource(owner,declared,{type:'plugin',installationKey,scope:productScope,version:'1'})));
  const bindings=sources.map(source=>bindGraphProducer(owner,declared,{principal:source.principal,vertices:{sample:['amount'],'system.content-snapshot':['digest','content']},edges:{justifies:[]},actions:['assert','retract-own','resolve']}));
  await owner.transaction('write',async tx=>{
   const {contract:published}=await startupBinding(tx,declared,'manifest-support-fixture');
   await publishGraphDrafts(tx,published,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify({file:'/fixture/madarch/catalog.yaml',kinds:{$map:[]},groups:{$map:[]},roles:{$map:[]},properties:{$map:[]},excludeDocuments:[],ignoreBlocks:[],findings:[],semanticBindings:{$map:[['evidence-support',{kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from',line:1}}}]]}})},producer:'manifest-support-fixture',producerVersion:'1'}],removals:[]});
  });
  const {readPublishedManifest}=await import('../src/graph/manifest-publication.js');
  expect((await owner.run(tx=>readPublishedManifest(tx)))?.semanticBindings?.get('evidence-support')?.edges?.['about']).toMatchObject({kind:'justifies',direction:'from'});
  for(const [index,binding] of bindings.slice(0,2).entries())await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,binding);await publishGraphDrafts(tx,declared,{vertices:[{kind:'sample',key:{name:'one'},values:{amount:index+1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,declared);});
  const view=async(recordedAt=new Date().toISOString())=>owner.transaction('snapshot',async tx=>readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['amount']),{validAt:new Date().toISOString(),recordedAt,contexts:[1]}));
  const question=(await view())!;const resolver=bindings[2]!;
  const {sha256Hex}=await import('../src/graph/digest.js');const content='Retained proof',digest=sha256Hex(Buffer.from(content));
  const snapshot={kind:'system.content-snapshot',key:{digest}},subject={kind:'sample',key:{name:'one'}};
  const capability=await owner.transaction('write',async tx=>{const binding=await activateGraphProducer(tx,declared,resolver);await publishGraphDrafts(tx,declared,{vertices:[{...snapshot,values:{content},producer:'fixture',producerVersion:'1'}],edges:[{kind:'justifies',from:snapshot,to:subject,producer:'fixture',producerVersion:'1'}],removals:[]});return binding;});
  await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});const [job]=await queue.claim({queue:declaration.name});
  const runUid=newUid(),unitUid=newUid();await owner.transaction('write',tx=>initializeOperationScope(tx,declared,capability,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract:declared,capability,runUid,unitUid});
  const resolution=await executeResolution(host,declared,resolver,{key:'resolve',input:{questionUid:question.id,chosenAssertionUid:question.candidates[0]!,expectedCandidates:question.candidates,rationale:'Current support checked',evidence:[{target:snapshot}]}});
  expect((await view())?.state).toBe('RESOLVED');const cutoff=new Date().toISOString();
  const support=(await owner.run(tx=>tx.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'`))).rows[0]!;
  // This operation touches only support. Its normal post-operation hook must find the dependent dispute.
  await host.execute({key:'withdraw',request:{support:support.id}},async tx=>{await writeAssertion(tx,declared,{sort:'edge',kind:'justifies',subjectId:support.id,property:'$exists',operation:'retract'});return {withdrawn:true};});
  const reopened=(await view())!;expect(reopened.id).toBe(question.id);expect(reopened.state).toBe('OPEN');expect(reopened.supersededResolutions).toContain(resolution);
  expect((await view(cutoff))?.state).toBe('RESOLVED');
  await owner.transaction('snapshot',async tx=>{const state=await loadAssertions(tx,'vertex','system.dispute-question',['state']);expect(state.filter(row=>row.subject.type==='vertex'&&row.subject.uid===question.id).at(-1)?.value).toBe('OPEN');const retained=await loadResolutionAssertion(tx,declared,resolution,await loadAssertions(tx,'vertex','sample',['amount']),{validAt:new Date().toISOString(),recordedAt:cutoff,contexts:[1]});expect(retained?.evidence).toHaveLength(1);});
 }finally{await queue.stop();await owner.close();}
},60000);

test('foundation nullable product fields dispute without turning protected base fields into questions',async()=>{
 const declared=withAssertionContract({...contract,vertex:[...contract.vertex.map(kind=>kind.name==='person'?{...kind,fields:[...kind.fields,{name:'product_note',type:'text' as const,nullable:true}]}:kind)]});
 const owner=await createTestDatabaseOwner({graphContract:declared});
 try{
  const {startupBinding}=await import('../src/graph/manifest-publication.js');
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,declared,'dispute-extension-fixture')).binding.productUid);
  const sources=await Promise.all(['foundation-a','foundation-b'].map(installationKey=>registerSystemSource(owner,declared,{type:'plugin',installationKey,scope:productScope,version:'1'})));
  const bindings=sources.map(source=>bindGraphProducer(owner,declared,{principal:source.principal,vertices:{person:['product_note']},edges:{}}));const uid=newUid();
  for(const [index,binding] of bindings.entries())await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,binding);await publishGraphDrafts(tx,declared,{vertices:[{kind:'person',uid,key:{},values:{product_note:index===0?'First':'Second'},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});await reconcileDisputes(tx,declared);});
  await owner.transaction('snapshot',async tx=>{
   const selectors={validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]};
   const slots=await listDisputeSlots(tx,declared,selectors);expect(slots).toHaveLength(1);expect(slots[0]?.kind).toBe('person');expect(slots[0]?.property).toBe('product_note');expect(slots[0]?.dispute.state).toBe('OPEN');expect(slots[0]?.dispute.candidates).toHaveLength(2);
   const {isDisputableProperty}=await import('../src/graph/system-contract.js');expect(isDisputableProperty('vertex','person','label')).toBe(false);expect(isDisputableProperty('vertex','person','$exists')).toBe(false);expect(isDisputableProperty('vertex','person','product_note')).toBe(true);
  });
 }finally{await owner.close();}
},60000);

test('resolved false existence agrees across SQL sets, records, endpoint and mention admission',async()=>{
 const declared=withAssertionContract({...contract,vertex:contract.vertex.map(kind=>kind.name==='sample'?{...kind,fields:[...kind.fields,{name:'note',type:'text' as const,nullable:true}]}:kind),edge:[{name:'refers',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'refers',in:'referred by'},ru:{out:'refers',in:'referred by'}},fields:[],repeats:false,capability:'fixture'}]});
 const {startupBinding}=await import('../src/graph/manifest-publication.js');const {readKindAssertions}=await import('../src/graph/records.js');
 const owner=await createTestDatabaseOwner({graphContract:declared});let stage='bootstrap';
 try{
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,declared,'existence-fixture')).binding.productUid);
  const sources=await Promise.all(['exists-a','exists-b','exists-resolver'].map(installationKey=>registerSystemSource(owner,declared,{type:'plugin',installationKey,scope:productScope,version:'1'})));
  const bindings=sources.map(source=>bindGraphProducer(owner,declared,{principal:source.principal,vertices:{sample:['amount','note'],'system.content-snapshot':['digest','content']},edges:{refers:[]},actions:['assert','resolve']}));
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[0]!);await publishGraphDrafts(tx,declared,{vertices:['target','caller'].map(name=>({kind:'sample',key:{name},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'})),removals:[]});await reconcileDisputes(tx,declared);});
  const target=(await owner.run(tx=>tx.query<{id:string;uid:string}>(`SELECT n.id::text,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'='target'`))).rows[0]!;
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[1]!);await writeAssertion(tx,declared,{sort:'vertex',kind:'sample',subjectId:target.id,property:'$exists',operation:'assert',value:false,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,declared);});
  const question=await owner.transaction('snapshot',async tx=>readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}));expect(question?.state).toBe('OPEN');
  const {sha256Hex}=await import('../src/graph/digest.js');const content='Existence proof',digest=sha256Hex(Buffer.from(content));
  stage='resolve';await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[2]!);await publishGraphDrafts(tx,declared,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});const rows=await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]);const chosen=rows.find(row=>row.source===bindings[1]!.sourceUid&&row.value===false)!;await resolveDispute(tx,declared,bindings[2]!,{questionUid:question!.id,chosenAssertionUid:chosen.id,expectedCandidates:question!.candidates,rationale:'Target retired',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});await reconcileDisputes(tx,declared);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');});
  stage='unprimed-snapshot';expect((await owner.transaction('snapshot',tx=>tx.query<{active:boolean}>(`SELECT graph_vertex_active($1::bigint,'sample',1) AS active`,[target.id]))).rows[0]?.active).toBe(false);
  stage='snapshot';await owner.transaction('snapshot',async tx=>{

   const result=await tx.query<{scalar:boolean;in_set:boolean}>(`SELECT graph_vertex_active($1::bigint,'sample',1) AS scalar,EXISTS(SELECT 1 FROM graph_vertex_active_ids('sample',1) active(id) WHERE id=$1::bigint) AS in_set`,[target.id]);
   expect(result.rows[0]).toEqual({scalar:false,in_set:false});
   expect((await readKindAssertions(tx,'vertex','sample',['amount'],{contract:declared})).some(row=>row.uid===target.uid)).toBe(false);
   const at=new Date().toISOString(),selectors={validAt:at,recordedAt:at,contexts:[1]};
   const resolved=await readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]),selectors);
   expect(resolved?.state).toBe('RESOLVED');
   if(resolved?.selectedAssertionUid==null)throw new Error(`${import.meta.path}:201: resolved existence has no canonical selected assertion`);
   const predicate=activeExistenceSql('vertex','n',declared.vertex.map(kind=>kind.name),selectors);
   const visible=await tx.query<{name:string}>(`SELECT n.key->>'name' AS name FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'=ANY($1::text[]) AND ${predicate} ORDER BY name COLLATE "C"`,[['target','caller']]);
   expect(visible.rows).toEqual([{name:'caller'}]);
  });
  const rejected=async(mention:boolean)=>owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[0]!);await publishGraphDrafts(tx,declared,{vertices:mention?[{kind:'sample',key:{name:'caller'},values:{note:`[[uid:${target.uid}]]`},producer:'fixture',producerVersion:'1'}]:[],edges:mention?[]:[{kind:'refers',from:{kind:'sample',key:{name:'caller'}},to:{kind:'sample',key:{name:'target'}},producer:'fixture',producerVersion:'1'}],removals:[]});});
  stage='endpoint-rejection';await expect(rejected(false)).rejects.toThrow('MISSING_ENDPOINT');stage='mention-rejection';await expect(rejected(true)).rejects.toThrow('TARGET_MISSING');
 }catch(error){throw new Error(`resolved false scenario ${stage}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}finally{await owner.close();}
},60000);

test('late graph writes fail forced constraints and savepoint rollback restores resolved false selection',async()=>{
 const declared=withAssertionContract({...contract,vertex:contract.vertex.map(kind=>kind.name==='sample'?{...kind,fields:[...kind.fields,{name:'note',type:'text' as const,nullable:true}]}:kind),edge:[{name:'refers',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'refers',in:'referred by'},ru:{out:'refers',in:'referred by'}},fields:[],repeats:false,capability:'fixture'}]});
 const {startupBinding}=await import('../src/graph/manifest-publication.js');
 const owner=await createTestDatabaseOwner({graphContract:declared});let stage='bootstrap';
 try{
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,declared,'existence-fixture')).binding.productUid);
  const sources=await Promise.all(['exists-a','exists-b','exists-resolver'].map(installationKey=>registerSystemSource(owner,declared,{type:'plugin',installationKey,scope:productScope,version:'1'})));
  const bindings=sources.map(source=>bindGraphProducer(owner,declared,{principal:source.principal,vertices:{sample:['amount','note'],'system.content-snapshot':['digest','content']},edges:{refers:[]},actions:['assert','resolve']}));
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[0]!);await publishGraphDrafts(tx,declared,{vertices:['target','caller'].map(name=>({kind:'sample',key:{name},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'})),removals:[]});await reconcileDisputes(tx,declared);});
  const target=(await owner.run(tx=>tx.query<{id:string;uid:string}>(`SELECT n.id::text,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'='target'`))).rows[0]!;
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[1]!);await writeAssertion(tx,declared,{sort:'vertex',kind:'sample',subjectId:target.id,property:'$exists',operation:'assert',value:false,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,declared);});
  const question=await owner.transaction('snapshot',async tx=>readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}));expect(question?.state).toBe('OPEN');
  const {sha256Hex}=await import('../src/graph/digest.js');const content='Existence proof',digest=sha256Hex(Buffer.from(content));
  stage='resolve';await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[2]!);await publishGraphDrafts(tx,declared,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});const rows=await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]);const chosen=rows.find(row=>row.source===bindings[1]!.sourceUid&&row.value===false)!;await resolveDispute(tx,declared,bindings[2]!,{questionUid:question!.id,chosenAssertionUid:chosen.id,expectedCandidates:question!.candidates,rationale:'Target retired',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});await reconcileDisputes(tx,declared);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');});
  stage='late-write-constraint-fence';
  await owner.transaction('write',async tx=>{

   const selected=async()=> (await tx.query<{scalar:boolean;in_set:boolean}>(`SELECT graph_vertex_active($1::bigint,'sample',1) AS scalar,EXISTS(SELECT 1 FROM graph_vertex_active_ids('sample',1) active(id) WHERE id=$1::bigint) AS in_set`,[target.id])).rows[0];
   expect(await selected()).toEqual({scalar:false,in_set:false});
   await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
   await tx.query('SET CONSTRAINTS ALL DEFERRED');
   await tx.query('SAVEPOINT before_late_edge');
   const caller=(await tx.query<{id:string}>(`SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'='caller'`)).rows[0]!;
   const inserted=await tx.query<{id:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,context_id) SELECT $1,id,$2::bigint,$3::bigint,1 FROM entity WHERE name='refers' RETURNING id::text`,[newUid(),caller.id,target.id]);
   expect(inserted.rows).toHaveLength(1);
   await activateGraphProducer(tx,declared,bindings[0]!);
   await writeAssertion(tx,declared,{sort:'edge',kind:'refers',subjectId:inserted.rows[0]!.id,property:'$exists',operation:'assert',value:true});
   await expect(tx.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow('TARGET_MISSING');
   await tx.query('ROLLBACK TO SAVEPOINT before_late_edge');
   expect(await selected()).toEqual({scalar:false,in_set:false});
   await tx.query('SAVEPOINT before_child_projection');
   const child=(await tx.query<{id:string}>(`INSERT INTO context(parent,ref) VALUES(1,'late-fence-child') RETURNING id::text`)).rows[0]!;

   const childSelection=(await tx.query<{active:boolean}>(`SELECT graph_vertex_active($1::bigint,'sample',$2::bigint) AS active`,[target.id,child.id])).rows[0]!;
   expect(childSelection.active).toBe(false);
   await tx.query('ROLLBACK TO SAVEPOINT before_child_projection');
   expect(await selected()).toEqual({scalar:false,in_set:false});

   await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
   expect(await selected()).toEqual({scalar:false,in_set:false});
  });
 }catch(error){throw new Error(`late write fence scenario ${stage}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}finally{await owner.close();}
},60000);
