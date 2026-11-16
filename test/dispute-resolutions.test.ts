import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {withManifestContract} from '../src/graph/manifest-contract.js';
import {publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {readDispute,reconcileDisputes,resolveDispute} from '../src/graph/disputes.js';
import {bindGraphProducer,activateGraphProducer} from '../src/graph/producer-binding.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
import {createRun,createUnit,advanceUnit,readUnit} from '../src/graph/fill-state.js';
import {recordRunConfiguration,appendProgress,readProgress,readRunConfiguration} from '../src/graph/fill-orchestration.js';
import {setProductOperationRunState} from '../src/graph/operation-host.js';
const contract:GraphContract=withAssertionContract(withManifestContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]}));
test('standalone fill metadata writes retain canonical semantics after a durable resolution',async()=>{
 const declared=withAssertionContract({...contract,vertex:contract.vertex.map(kind=>kind.name==='sample'?{...kind,fields:[...kind.fields,{name:'note',type:'text' as const,nullable:true}]}:kind),edge:[{name:'refers',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'refers',in:'referred by'},ru:{out:'refers',in:'referred by'}},fields:[],repeats:false,capability:'fixture'}]});
 const {installDisputeSelection,refreshDisputeSelection}=await import('../src/graph/disputes.js');
 const {startupBinding}=await import('../src/graph/manifest-publication.js');
 const owner=await createTestDatabaseOwner({graphContract:declared});let stage='bootstrap';
 try{
  const productScope=await owner.transaction('write',async tx=>(await startupBinding(tx,declared,'existence-fixture')).binding.productUid);
  const sources=await Promise.all(['exists-a','exists-b','exists-resolver'].map(installationKey=>registerSystemSource(owner,declared,{type:'plugin',installationKey,scope:productScope,version:'1'})));
  const bindings=sources.map(source=>bindGraphProducer(owner,declared,{principal:source.principal,vertices:{sample:['amount','note'],'system.content-snapshot':['digest','content']},edges:{refers:[]},actions:['assert','resolve']}));
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[0]!);await installDisputeSelection(tx,declared);await publishGraphDrafts(tx,declared,{vertices:['target','caller'].map(name=>({kind:'sample',key:{name},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'})),removals:[]});await reconcileDisputes(tx,declared);await refreshDisputeSelection(tx,declared);});
  const target=(await owner.run(tx=>tx.query<{id:string;uid:string}>(`SELECT n.id::text,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' AND n.key->>'name'='target'`))).rows[0]!;
  await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[1]!);await installDisputeSelection(tx,declared);await writeAssertion(tx,declared,{sort:'vertex',kind:'sample',subjectId:target.id,property:'$exists',operation:'assert',value:false,validFrom:'2020-01-01T00:00:00Z'});await reconcileDisputes(tx,declared);await refreshDisputeSelection(tx,declared);});
  const question=await owner.transaction('snapshot',async tx=>readDispute(tx,declared,await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}));expect(question?.state).toBe('OPEN');
  const {sha256Hex}=await import('../src/graph/digest.js');const content='Existence proof',digest=sha256Hex(Buffer.from(content));
  stage='resolve';await owner.transaction('write',async tx=>{await activateGraphProducer(tx,declared,bindings[2]!);await installDisputeSelection(tx,declared);await publishGraphDrafts(tx,declared,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],removals:[]});const rows=await loadAssertions(tx,'vertex','sample',['$exists'],[Number(target.id)]);const chosen=rows.find(row=>row.source===bindings[1]!.sourceUid&&row.value===false)!;await resolveDispute(tx,declared,bindings[2]!,{questionUid:question!.id,chosenAssertionUid:chosen.id,expectedCandidates:question!.candidates,rationale:'Target retired',evidence:[{target:{kind:'system.content-snapshot',key:{digest}}}]});await reconcileDisputes(tx,declared);await refreshDisputeSelection(tx,declared);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');});
  stage='standalone-fill';
  const checkedDatabase:Pick<typeof owner,'transaction'>&{graphContract:GraphContract}={graphContract:declared,transaction:async(kind,work)=>await owner.transaction(kind,async tx=>{
   const result=await work(tx);
   if(kind==='write')expect((await tx.query<{active:boolean}>(`SELECT graph_vertex_active($1::bigint,'sample',1) AS active`,[target.id])).rows[0]?.active).toBe(false);
   return result;
  })};
  await createRun(checkedDatabase,{runId:'resolved-fill',product:productScope,at:1});
  await createUnit(checkedDatabase,{unitId:'resolved-unit',runId:'resolved-fill',product:productScope,stageId:'probe',scopeKey:'scope',inputsDigest:'inputs',retries:0,at:2});
  const snapshot={repository:'repository',defaultBranch:'main',commit:'commit',registryHash:'registry'};
  await recordRunConfiguration(checkedDatabase,{runId:'resolved-fill',digest:'configuration',snapshot,at:3});
  const progress=await appendProgress(checkedDatabase,{runId:'resolved-fill',at:4,stage:'probe',unitId:'resolved-unit',generation:1,kind:'unit-planned',summary:'planned'});
  expect(progress.seq).toBe(1);
  expect((await readRunConfiguration(owner,'resolved-fill'))?.snapshot).toEqual(snapshot);
  expect((await readProgress(owner,'resolved-fill')).map(event=>event.kind)).toEqual(['unit-planned']);
  expect((await advanceUnit(checkedDatabase,{unitId:'resolved-unit',event:{type:'admit',at:5,generation:1}})).ok).toBe(true);
  await setProductOperationRunState(owner,declared,'resolved-fill','paused');
  expect((await readUnit(owner,'resolved-unit'))?.state).toBe('ready');
 }catch(error){throw new Error(`standalone fill scenario ${stage}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}finally{await owner.close();}
},60000);
