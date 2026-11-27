import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
import {activateGraphProducer,bindGraphProducer} from '../src/graph/producer-binding.js';
import {publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {reconcileDisputes,resolveDispute} from '../src/graph/disputes.js';
import {readDispute} from '../src/graph/dispute-read.js';
import {sha256Hex} from '../src/graph/digest.js';
const baseContract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[],dictionary:[]});

// Each scenario gets a separate database and independent producer streams.
export async function amendmentFixture(support=false,declareSupport=true){
 const {withManifestContract}=await import('../src/graph/manifest-contract.js');
 const contract:GraphContract=support?withAssertionContract(withManifestContract({...baseContract,edge:[{name:'justifies',from:['system.content-snapshot'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[],repeats:false,capability:'fixture'}]})):baseContract;
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const scope=await owner.transaction('write',async tx=>(await startupBinding(tx,contract,'amendment-scenarios')).binding.productUid);
 const identities=await Promise.all(['a','b','judge'].map(installationKey=>registerSystemSource(owner,contract,{type:'plugin',installationKey,scope,version:'1'})));
 const bindings=identities.map(identity=>bindGraphProducer(owner,contract,{principal:identity.principal,vertices:{sample:['amount'],'system.content-snapshot':['digest','content']},edges:support?{justifies:[]}:{},actions:['assert','retract-own','resolve']}));
 if(support&&declareSupport)await owner.transaction('write',async tx=>{const {contract:published}=await startupBinding(tx,contract,'manifest');await publishGraphDrafts(tx,published,{vertices:[{kind:'manifest.catalogue',key:{name:'product'},values:{declaration:JSON.stringify({file:'/fixture/catalog.yaml',kinds:{$map:[]},groups:{$map:[]},roles:{$map:[]},properties:{$map:[]},excludeDocuments:[],ignoreBlocks:[],findings:[],semanticBindings:{$map:[['evidence-support',{kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from',line:1}}}]]}})},producer:'fixture',producerVersion:'1'}],removals:[]});});
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
