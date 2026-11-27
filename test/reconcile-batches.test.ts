import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '../src/plugin/host.js';
import type {FactsOperation,OwnFacts,VertexResult} from '../src/plugin-sdk.js';
import {createTestDatabaseOwner} from './test-database.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {createOperationHost,initializeOperationScope} from '../src/graph/operation-host.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {newUid} from '../src/graph/uid.js';
import {publishGraphDrafts,canonicalJson} from '../src/graph/write.js';
import {readKindAssertions} from '../src/graph/records.js';

const facts=(count:number,text=''):VertexResult[]=>Array.from({length:count},(_,id)=>({kind:'item',key:{id:String(id).padStart(4,'0')},values:{text}}));
async function run(vertices:VertexResult[],ownFacts:()=>Promise<OwnFacts>,apply:(key:string,operation:FactsOperation)=>Promise<unknown>){
 const folder=mkdtempSync(join(tmpdir(),'reconcile-batches-'));
 const outputs={vertices:[{kind:'item',key:['id'],fields:[{name:'text',type:'text',meaning:'text',example:'',required:false}]}],edges:[]};
 writeFileSync(join(folder,'plugin.json'),JSON.stringify({name:'batch',version:'1',entry:'main.ts',runtime:{name:'bun',version:Bun.version},produces:[{kind:'item',fields:'*'}]}));
 writeFileSync(join(folder,'contract.json'),JSON.stringify({id:'batch',version:'1',outputs,rights:{network:'none',graph:true,graphReads:['ownFacts']}}));
 writeFileSync(join(folder,'main.ts'),`import {definePlugin} from 'madarch-plugin-sdk'; await definePlugin({name:'batch',version:'1',contract:${JSON.stringify(outputs)},graph:true,graphReads:['ownFacts'],async extract(){return {vertices:${JSON.stringify(vertices)},end:{state:'complete'}};}});`);
 let session;
 try{
  session=await new PluginHost({pluginFolder:folder,repository:folder,workRoot:join(folder,'work'),trust:'validation',env:{...process.env,MADARCH_PLUGIN_SANDBOX:'off'},graph:{ownFacts:async()=>JSON.parse(JSON.stringify(await ownFacts())),files:async()=>[],value:async()=>null},operations:{apply:async(_unit,key,operation)=>await apply(key,operation as FactsOperation)},limits:{unitMs:120000}}).open();
  return await session.runUnit({unitId:'batch',kind:'item',key:{}});
 }finally{await session?.close();rmSync(folder,{recursive:true,force:true});}
}
test('1000 facts use two bounded content-addressed operations',async()=>{
 const operations:FactsOperation[]=[];
 const outcome=await run(facts(1000),async()=>({vertices:[],edges:[]}),async(key,operation)=>{
  operations.push(operation);
  if(operations.length>2)throw new Error(`${import.meta.path}:40: more than two operations`);
  expect(key).toBe('reconcile-'+createHash('sha256').update(canonicalJson(operation)).digest('hex'));
  expect(Buffer.byteLength(JSON.stringify(operation))).toBeLessThanOrEqual(512*1024);
  expect(operation.vertices?.length).toBeLessThanOrEqual(500);
  return {};
 });
 expect(outcome.state).toBe('extracted');
 expect(operations).toHaveLength(2);
 expect(operations.flatMap(op=>op.vertices??[])).toHaveLength(1000);
},30000);
test('byte bound counts UTF-8 and refuses an indivisible oversized fact',async()=>{
 const operations:FactsOperation[]=[];
 const outcome=await run(facts(3,'界'.repeat(90000)),async()=>({vertices:[],edges:[]}),async(_key,operation)=>{operations.push(operation);return {};});
 expect(outcome.state).toBe('extracted');
 expect(operations).toHaveLength(3);
 expect(operations.every(op=>Buffer.byteLength(JSON.stringify(op))<=512*1024)).toBe(true);
 const oversized=await run(facts(1,'界'.repeat(180000)),async()=>({vertices:[],edges:[]}),async()=>{throw new Error(`${import.meta.path}:54: oversized operation reached host`);});
 expect(oversized.state).toBe('not-extracted');
 if(oversized.state==='not-extracted')expect(oversized.cause.message).toContain('512');
},30000);
const contract:GraphContract={vertex:[{name:'item',table:generatedTableName('item','vertex'),key:['id'],fields:[{name:'id',type:'text'},{name:'text',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
async function database(work:(host:ReturnType<typeof createOperationHost>,owner:Awaited<ReturnType<typeof createTestDatabaseOwner>>)=>Promise<void>){
 const owner=await createTestDatabaseOwner({graphContract:contract,authenticated:false});
 const declaration={name:'batch',leaseSeconds:300,retries:1,retryDelaySeconds:0,retryBackoff:false};
 const queue=await createPgBossQueue({owner,supervise:false});
 try{
  await prepareQueueSchema(owner,{declarations:[declaration]});await queue.declare(declaration);await queue.enqueue({queue:'batch',data:{}});const [job]=await queue.claim({queue:'batch'});
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,contract,'fixture.batch'));
  const runUid=newUid(),unitUid=newUid();await owner.transaction('write',tx=>initializeOperationScope(tx,contract,binding,runUid,unitUid));
  await work(createOperationHost({owner,queue,job:job!,contract,capability:binding,runUid,unitUid}),owner);
 }finally{await queue.stop();await owner.close();}
}
test('retry after committed prefix sends only remainder without conflicting receipts',async()=>await database(async(host,owner)=>{
 const read=async()=>({vertices:(await owner.run(tx=>readKindAssertions(tx,'vertex','item',['id','text'],{contract}))).map(row=>({kind:'item',key:{id:String(row.key['id'])},values:{text:row.values['text']}})),edges:[]});
 const apply=async(key:string,operation:FactsOperation)=>await host.execute({key,request:operation},async(tx,context)=>{
  await publishGraphDrafts(tx,contract,{vertices:(operation.vertices??[]).map(v=>({kind:v.kind,key:v.key,values:v.values,producer:context.binding.sourceUid,producerVersion:'1'})),removals:[]});
  return {accepted:true};
 });
 let calls=0;
 const first=await run(facts(501),read,async(key,operation)=>{if(++calls===2)throw new Error(`${import.meta.path}:82: simulated crash after committed prefix`);return await apply(key,operation);});
 expect(first.state).toBe('not-extracted');
 const prefix=(await read()).vertices.length;expect(prefix).toBe(500);
 const sent:FactsOperation[]=[];
 const retry=await run(facts(501),read,async(key,operation)=>{sent.push(operation);return await apply(key,operation);});
 expect(retry.state).toBe('extracted');
 expect(sent.flatMap(op=>op.vertices??[])).toHaveLength(501-prefix);
 expect((await read()).vertices).toHaveLength(501);
}),120000);
test('verbatim batch repeat returns receipt without adding assertions',async()=>await database(async(host,owner)=>{
 const captured:{key:string;operation:FactsOperation}[]=[];let applies=0;
 const apply=async(key:string,operation:FactsOperation)=>await host.execute({key,request:operation},async(tx,context)=>{
  applies++;await publishGraphDrafts(tx,contract,{vertices:(operation.vertices??[]).map(v=>({kind:v.kind,key:v.key,values:v.values,producer:context.binding.sourceUid,producerVersion:'1'})),removals:[]});return {accepted:applies};
 });
 const first=await run(facts(2),async()=>({vertices:[],edges:[]}),async(key,operation)=>{captured.push({key,operation});return await apply(key,operation);});
 expect(first.state).toBe('extracted');expect(captured).toHaveLength(1);
 const count=async()=>(await owner.run(tx=>tx.query<{count:string}>('SELECT count(*)::text AS count FROM assertion'))).rows[0]!.count;
 const before=await count();
 expect(await apply(captured[0]!.key,captured[0]!.operation)).toEqual({accepted:1});
 expect(applies).toBe(1);expect(await count()).toBe(before);
}),60000);
