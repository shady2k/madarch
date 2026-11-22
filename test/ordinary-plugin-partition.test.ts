import {expect,test} from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { makeProduct } from './knowledge-fixture.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { closureOf } from '../src/plugin/closure.js';
import { createStagesFill } from '../src/product/fill-stages.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createOrchestrator, DEFAULT_ORCHESTRATOR_LIMITS, planRun, schedulerPass, startRun, stopHeartbeat, workOnce } from '../src/fill/orchestrator.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { readProgress } from '../src/graph/fill-orchestration.js';

import type {KeyValues} from 'madarch-plugin-sdk';
import {partitioned as disk} from '../plugins/disk/partition.js';
import {partitioned as git} from '../plugins/git/partition.js';

for(const [name,partitioned] of [['disk',disk],['git',git]] as const){
 const file=(path:string)=>({kind:'File',key:{path}});
 const blob=(digest:string)=>({kind:'Support',key:{digest}});
 const repository={kind:'Repository',key:{name:'fixture'}};
 const unused=async():Promise<never>=>{throw new Error('partition helper must not call the host');};
 const context:Parameters<Parameters<typeof disk>[0]>[1]={signal:new AbortController().signal,progress:()=>{},heartbeat:()=>{},facts:{apply:unused},reconcile:unused,agent:unused,read:unused,graph:{ownFacts:unused,files:unused,value:unused,removedEnds:unused,unevidenced:unused}};
 const unit:Parameters<Parameters<typeof disk>[0]>[0]={unitId:'files',kind:'File',key:{},inputs:{}};
 const fixture=()=>({end:{state:'complete' as const},vertices:[{...file('a'),evidence:{target:blob('a')}},{...file('b'),evidence:{target:blob('b')}},{...blob('a'),values:{content:'a'}},{...blob('b'),values:{content:'b'}},{...blob('inventory'),values:{content:'inventory'}}],edges:[{kind:'contains',from:repository,to:file('a'),evidence:{target:blob('inventory')}},{kind:'contains',from:repository,to:file('b'),evidence:{target:blob('inventory')}},{kind:'about',from:blob('inventory'),to:repository},{kind:'about',from:blob('a'),to:file('a')},{kind:'about',from:blob('b'),to:file('b')}]});
 test(`${name} partitions only output keys and carries referenced evidence support`,async()=>{
  const output=partitioned(async()=>fixture());
  expect((await output.planOutput(unit,context)).partitions).toEqual([{keys:[{path:'a'},{path:'b'}]}]);
  const selected=await output.extract({...unit,inputs:{keys:[{path:'a'}]}},context);
  expect(selected.vertices?.map(vertex=>[vertex.kind,vertex.key])).toEqual([['File',{path:'a'}],['Support',{digest:'a'}],['Support',{digest:'inventory'}]]);
  expect(selected.edges?.map(edge=>[edge.kind,edge.from.key,edge.to.key])).toEqual([['contains',{name:'fixture'},{path:'a'}],['about',{digest:'inventory'},{name:'fixture'}],['about',{digest:'a'},{path:'a'}]]);
 });
 test(`${name} refuses an ordinary edge without output or referenced support`,async()=>{
  const output=partitioned(async()=>({...fixture(),edges:[...fixture().edges,{kind:'unrelated',from:repository,to:{kind:'Other',key:{id:'outside'}}}]}));
  await expect(output.planOutput(unit,context)).rejects.toThrow('no output identity or referenced support');
 });
 test(`${name} counts required support bytes in each bounded group`,async()=>{
  const shared=blob('shared');
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices:[{...file('a'),values:{text:'a'.repeat(300000)},evidence:{target:shared}},{...file('b'),values:{text:'b'.repeat(300000)},evidence:{target:shared}},{...shared,values:{content:'s'.repeat(600000)}}],edges:[]}));
  expect((await output.planOutput(unit,context)).partitions).toEqual([{keys:[{path:'a'}]},{keys:[{path:'b'}]}]);
 });
 const GROUP_BYTES=1_000_000;
 /** The pre-search pass, kept whole as the oracle: the longest run from each key that stays within the bound. */
 const greedy=(vertices:readonly {readonly key:{readonly path:string}}[],sizeOf:(start:number,end:number)=>number)=>{
  const groups:{readonly path:string}[][]=[];
  for(let start=0;start<vertices.length;){
   let end=start;
   while(end+1<vertices.length&&sizeOf(start,end+1)<=GROUP_BYTES)end+=1;
   groups.push(vertices.slice(start,end+1).map(vertex=>vertex.key));
   start=end+1;
  }
  return groups;
 };
 /** Every partition's keys, page by page, as the host reads them. */
 const planned=async(output:ReturnType<typeof partitioned>)=>{
  const groups:KeyValues[][]=[];
  let cursor:string|undefined;
  for(;;){
   const page=await output.planOutput(unit,context,cursor);
   groups.push(...page.partitions.map(partition=>partition.keys));
   cursor=page.next;
   if(cursor===undefined)return groups;
  }
 };
 const sized=(lengths:readonly number[])=>{
  const vertices=lengths.map((length,at)=>({kind:'File',key:{path:`k${String(at).padStart(2,'0')}`},values:{text:'x'.repeat(length)}}));
  const sizeOf=(start:number,end:number)=>Buffer.byteLength(JSON.stringify({end:{state:'complete'},vertices:vertices.slice(start,end+1),edges:[]}));
  return {vertices,sizeOf};
 };
 test(`${name} groups keys of varied sizes exactly as the linear greedy pass does, binary phase included`,async()=>{
  const cycle=[110000,35000,80000,50000,95000,40000,125000,60000,30000,70000];
  const {vertices,sizeOf}=sized([...cycle,...cycle,...cycle]);
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices,edges:[]}));
  const actual=await planned(output);
  expect(actual).toEqual(greedy(vertices,sizeOf));
  expect(actual.length).toBeGreaterThan(1);
  // The exponential phase passes at least one boundary before the binary phase finds it, so this run exercises both.
  let overshoot=false;
  for(let start=0;start<vertices.length;){
   let end=start;
   while(end+1<vertices.length&&sizeOf(start,end+1)<=GROUP_BYTES)end+=1;
   let good=start,step=1;
   while(start+step<vertices.length&&sizeOf(start,start+step)<=GROUP_BYTES){good=start+step;step*=2;}
   if(step>1&&good>start&&end>good)overshoot=true;
   start=end+1;
  }
  expect(overshoot).toBe(true);
 });
 test(`${name} keeps a key whose own group exceeds the bound as a group of one`,async()=>{
  const {vertices,sizeOf}=sized([50000,50000,50000,50000,50000,50000,50000,50000,50000,50000,1400000,45000,45000,45000,45000,45000,45000,45000,45000,45000,45000,45000]);
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices,edges:[]}));
  const actual=await planned(output);
  expect(actual).toEqual(greedy(vertices,sizeOf));
  expect(actual.find(group=>group.some(key=>key.path==='k10'))).toEqual([{path:'k10'}]);
 });

 const commit=(hash:string)=>({kind:'code.commit',key:{hash}});
 const commitUnit={...unit,kind:'code.commit',unitId:'commits'};
 const commitFixture=(cycle:boolean)=>({
  end:{state:'complete' as const},
  vertices:['10','30','20','40'].map(hash=>({...commit(hash),values:{message:hash.repeat(170000)}})),
  edges:[{kind:'code.parent',from:commit('20'),to:commit('30')},{kind:'code.parent',from:commit('30'),to:commit('10')},...(cycle?[{kind:'code.parent',from:commit('10'),to:commit('20')}]:[])],
 });
 for(const cycle of [false,true]) test(`${name} closes every hash-ordered group over ${cycle?'the G0-G1 cycle':'a non-hash-ordered ancestry chain'}`,async()=>{
  const output=partitioned(async()=>commitFixture(cycle));
  const groups:KeyValues[][]=[];
  let cursor:string|undefined;
  do{
   const page=await output.planOutput(commitUnit,context,cursor);
   groups.push(...page.partitions.map(partition=>partition.keys));
   cursor=page.next;
  }while(cursor!==undefined);
  expect(groups.length).toBeGreaterThanOrEqual(2);
  for(const keys of groups){
   const selected=await output.extract({...commitUnit,inputs:{keys}},context);
   const present=new Set(selected.vertices?.filter(vertex=>vertex.kind==='code.commit').map(vertex=>JSON.stringify(vertex.key)));
   for(const edge of selected.edges??[])for(const endpoint of [edge.from,edge.to]){
    if(endpoint.kind==='code.commit')expect(present.has(JSON.stringify(endpoint.key))).toBe(true);
   }
  }
 });

 test(`${name} fills the same commits across changed group boundaries without retractions or disputes`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'madarch-commit-regroup-'));
  const owner=await createTestDatabaseOwner({btreeGist:true});
  const gitCommand=(folder:string,...args:string[])=>execFileSync('git',['-C',folder,...args],{stdio:'pipe'});
  try{
   const repo=join(root,'repo');mkdirSync(repo);
   writeFileSync(join(repo,'source.txt'),'source');
   gitCommand(repo,'init','-q','-b','main');gitCommand(repo,'add','-A');
   gitCommand(repo,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','source');
   const home=join(root,'home');mkdirSync(home);
   const product=makeProduct(home,'regroup',repo,'repo');seedStarterSet(product);
   const plugin=join(product,'plugins/git');mkdirSync(plugin,{recursive:true});
   const field=(name:string)=>({name,type:'text',meaning:name,example:name,required:true});
   const outputs={vertices:[{kind:'code.commit',key:['hash'],fields:['hash','message'].map(field),evidence:{immutable:true,digestField:'hash'}}],edges:[{kind:'code.parent',from:'code.commit',to:'code.commit',cardinality:{from:'many',to:'many'},labels:{en:{out:'parent',in:'child'},ru:{out:'parent',in:'child'}}}]};
   writeFileSync(join(plugin,'plugin.json'),JSON.stringify({name:'git',version:'1.0.0',entry:'main.ts',concurrency:2,runtime:{name:'bun',version:Bun.version},produces:[{kind:'code.commit',fields:'*',reads:[],partition:'key',support:{vertices:['code.commit'],edges:[]}}]}));
   writeFileSync(join(plugin,'contract.json'),JSON.stringify({id:'git',version:'1.0.0',outputs,rights:{network:'none',graph:true,graphReads:['files','value','ownFacts']}}));
   copyFileSync(join(import.meta.dir,`../plugins/${name}/partition.ts`),join(plugin,'partition.ts'));
   writeFileSync(join(plugin,'main.ts'),`import {definePlugin} from 'madarch-plugin-sdk';
import {partitioned} from './partition.ts';
import {single} from './scenario.js';
const output=partitioned(async()=>(${JSON.stringify(commitFixture(true))}));
await definePlugin({name:'git',version:'1.0.0',contract:${JSON.stringify(outputs)},
async planOutput(unit,context,cursor){const page=await output.planOutput(unit,context,cursor);return {...page,partitions:single?page.partitions.flatMap(part=>part.keys.map(key=>({keys:[key]}))):page.partitions};},
// Use the SDK automatic reconciliation path, as bundled plugins do.
async extract(unit,context){await new Promise(resolve=>setTimeout(resolve,2000));return await output.extract(unit,context);}});`);
   writeFolderManifest(product,stringify({language:'en',kinds:{'code.commit':{source:'graph',key:['hash'],fields:['hash','message'].map(name=>({name,type:'text'})),evidence:{immutable:true,digestField:'hash'}}},edges:[{name:'code.parent',from:['code.commit'],to:['code.commit'],cardinality:{from:{min:0,max:null},to:{min:0,max:null}},labels:outputs.edges[0]!.labels}],plugins:[{id:'git',version:1,path:'plugins/git',inputs:[],outputs:['code.commit'],closure:['plugins/git/plugin.json','plugins/git/contract.json','plugins/git/main.ts','plugins/git/partition.ts','plugins/git/scenario.js']}]}));
   let previousOpen=new Map<string,string>();
   // Change only a closure nonce on the last run: execute reconciliation again instead of inheriting cached units.
   for(const [runIndex,single] of [false,true,true].entries()){
    writeFileSync(join(plugin,'scenario.js'),`export const single=${single};export const extractionRun=${runIndex};`);
    const closure=closureOf(plugin).hash;
    writeFileSync(join(product,'madarch/plugins.lock'),stringify({plugins:[{id:'git',path:'plugins/git',version:'1.0.0',closure}]}));
    gitCommand(product,'add','-A');gitCommand(product,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm',`groups-${runIndex}`);
    const active=new Set<string>();let peak=0;
    const runId=`groups-${runIndex}`;
    const fill=await createStagesFill({product,database:owner,runId,store:home,releaseHashes:[closure],targets:{kinds:['code.commit']},prepareContract:async contract=>{await prepareTestStore(owner,{contract});}});
    const queue=await createPgBossQueue({owner,supervise:false});
    const queueName='fill-units';
    await queue.declare({name:queueName,leaseSeconds:DEFAULT_ORCHESTRATOR_LIMITS.attemptSeconds,heartbeatSeconds:DEFAULT_ORCHESTRATOR_LIMITS.heartbeatSeconds,retries:0,retryDelaySeconds:0,retryBackoff:false,singletons:true});
    const wiring=fill.wiring;
    const orchestrator=createOrchestrator({database:{transaction:owner.transaction.bind(owner),graphContract:wiring.graphContract},registry:fill.registry,queue,queueName,product:fill.product.name,
     configuration:async()=>{const held=await wiring.configuration();if(held!==undefined&&!held.ok)return held;return {ok:true,file:held?.file??product,lines:held?.lines??{},stages:Object.fromEntries(fill.registry.all().map(stage=>[stage.id,{...(held?.stages[stage.id] as Record<string,unknown>??{}),enabled:stage.id==='plugin-turns'}]))};},
     snapshot:()=>wiring.snapshot(),graph:(ref,tx)=>wiring.graph(ref,tx),inputs:ref=>wiring.inputs(ref),operations:wiring.operations,limits:{retries:0}});
    try{
     const started=await startRun(orchestrator,{runId});
     expect(started.ok).toBe(true);
     const planned=await planRun(orchestrator,{runId});
     if(planned.outcome==='refused')throw new Error(`${import.meta.path}: planning refused: ${JSON.stringify(planned)}`);
     let state='running';
     for(let pass=0;pass<30;pass++){
      const scheduled=await schedulerPass(orchestrator,{runId});state=scheduled.run.state;
      if(['succeeded','failed','blocked','cancelled'].includes(state))break;
      // The production driver calls workers sequentially; this fixture drives two real workers concurrently.
      const outcomes=await Promise.all([workOnce(orchestrator,{worker:'parallel-1'}),workOnce(orchestrator,{worker:'parallel-2'})]);
      if(outcomes.some(outcome=>outcome.result!==undefined&&['failed','retried','refused'].includes(outcome.result)))throw new Error(`${import.meta.path}: parallel fill failed: ${JSON.stringify(outcomes)}`);
      if(!scheduled.moved&&outcomes.every(outcome=>!outcome.claimed))throw new Error(`${import.meta.path}: parallel fill stalled: ${JSON.stringify(scheduled)}`);
     }
     if(state!=='succeeded')throw new Error(`${import.meta.path}: parallel fill did not succeed: ${JSON.stringify({state,progress:await readProgress(owner,runId)})}`);
     expect(state).toBe('succeeded');
    }finally{stopHeartbeat(orchestrator);await queue.stop();}
    for(const event of await readProgress(owner,runId)){
     if(!event.unitId.includes('git:code.commit#'))continue;
     if(event.kind==='unit-started')active.add(event.unitId);
     if(event.kind==='unit-published'||event.kind==='unit-failed')active.delete(event.unitId);
     peak=Math.max(peak,active.size);
    }
    console.info(JSON.stringify({helper:name,runId,peak}));
    expect(peak).toBeGreaterThanOrEqual(2);
    await assertOpinions(runId,runIndex);
   }
   async function assertOpinions(runId:string,runIndex:number){
   const contract=await readPinnedGraphContract(product);
   await owner.transaction('snapshot',async tx=>{
    const commits=await readKindAssertions(tx,'vertex','code.commit',['message'],{contract});
    expect(commits.map(row=>row.key['hash']).sort()).toEqual(['10','20','30','40']);
    const sources=await readKindAssertions(tx,'vertex','plugin',['installation'],{contract});
    const gitSources=sources.filter(source=>source.values['installation']===JSON.stringify(['system-engine','git']));
    expect(gitSources).toHaveLength(1);
    const gitSource=gitSources[0]!.uid;
    const assertions=await loadAssertions(tx,'vertex','code.commit',['$exists','hash','message']);
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.filter(row=>row.operation==='retract')).toEqual([]);
    const currentOpen=new Map<string,string>();
    for(const commit of commits)for(const property of ['$exists','hash','message']){
     const open=assertions.filter(row=>row.subjectId===commit.id&&row.property===property&&row.validTo===null);
     expect(open).toHaveLength(1);
     expect(open[0]!.source).toBe(gitSource);
     const slot=`${commit.key['hash']}:${property}`;
     currentOpen.set(slot,open[0]!.id);
     if(runIndex>0)expect(open[0]!.id).toEqual(previousOpen.get(slot)!);
     console.info(JSON.stringify({helper:name,runId,hash:commit.key['hash'],property,open:open.length,source:open[0]!.source,gitSource}));
    }
    previousOpen=currentOpen;
    const runs=await readKindAssertions(tx,'vertex','system.run',['run_name'],{contract});
    const run=runs.find(row=>row.values['run_name']===runId)!;
    const units=await readKindAssertions(tx,'vertex','system.unit',['unit_name','committed_operations','outcome'],{contract});
    const operations=await readKindAssertions(tx,'vertex','system.operation',['key','canonical_request'],{contract});
    const links=(await tx.query<{operation:string;unit:string}>(`SELECT o.uid::text AS operation,u.uid::text AS unit FROM edge ou JOIN entity ouk ON ouk.id=ou.entity_id JOIN node o ON o.id=ou.from_node JOIN node u ON u.id=ou.to_node JOIN edge ur ON ur.from_node=u.id JOIN entity urk ON urk.id=ur.entity_id JOIN node r ON r.id=ur.to_node WHERE ouk.name='system.operation-unit' AND urk.name='system.unit-run' AND r.uid=$1::uuid`,[run.uid])).rows;
    const summaries=units.filter(unit=>String(unit.values['unit_name']).includes('git:code.commit#')&&links.some(link=>link.unit===unit.uid)).map(unit=>{
     const own=operations.filter(operation=>links.some(link=>link.unit===unit.uid&&link.operation===operation.uid));
     const applies=own.filter(operation=>{const request=JSON.parse(String(operation.values['canonical_request'])).request as Record<string,unknown>;return ['vertices','edges','removals','edgeRemovals'].some(field=>Array.isArray(request[field]));});
     return {unit:unit.values['unit_name'],committed:unit.values['committed_operations'],operations:own.length,applies:applies.length,keys:own.map(operation=>operation.values['key']),outcome:unit.values['outcome'],requests:applies.map(operation=>{const request=JSON.parse(String(operation.values['canonical_request'])).request;return {vertices:request.vertices?.map((vertex:{kind:string;key:unknown})=>({kind:vertex.kind,key:vertex.key})),edges:request.edges?.length,removals:request.removals?.length};})};
    });
    console.info(JSON.stringify({helper:name,runId,operationSummary:summaries}));
    expect(summaries.length).toBeGreaterThan(1);
    if(runIndex===0)expect(summaries.reduce((sum,row)=>sum+row.applies,0)).toBeGreaterThan(0);
    if(runIndex===1||runIndex===2)for(const summary of summaries){expect(summary.applies).toBe(0);expect(summary.outcome).toBe('unchanged');}
    const questions=await readKindAssertions(tx,'vertex','system.dispute-question',['state'],{contract});
    expect(questions).toEqual([]);
   });
   }
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
 },120_000);
}
