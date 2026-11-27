import {expect,test} from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { prepareRepositoryInputs } from '../src/plugin/repository-input.js';
import diskContract from '../plugins/disk/contract.json';

 test(`real disk files reconcile without own-kind edges while retaining foreign blob evidence`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'madarch-file-regroup-'));
  const owner=await createTestDatabaseOwner({btreeGist:true});
  const gitCommand=(folder:string,...args:string[])=>execFileSync('git',['-C',folder,...args],{stdio:'pipe'});
  try{
   const repo=join(root,'repo');mkdirSync(repo);
   gitCommand(repo,'init','-q','-b','main');
   const paths=Array.from({length:4},(_,index)=>`source-${index}.txt`);
   for(const [index,path] of paths.entries())writeFileSync(join(repo,path),`source-${index} ${'x'.repeat(280000)}`);
   gitCommand(repo,'add','-A');
   gitCommand(repo,'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','Files');
   const pin=gitCommand(repo,'rev-parse','HEAD').toString('utf8').trim();
   const home=join(root,'home');mkdirSync(home);
   const product=makeProduct(home,'regroup',repo,'repo');seedStarterSet(product);
   const plugin=join(product,'plugins/disk');mkdirSync(plugin,{recursive:true});
   const shippedFile=diskContract.outputs.vertices.find(vertex=>vertex.kind==='code.file')!;
   // No file classification rule is declared: the extractor intentionally emits no class.
   const fileContract={...shippedFile,fields:shippedFile.fields.filter(field=>field.name!=='class')};
   const blobContract=diskContract.outputs.vertices.find(vertex=>vertex.kind==='code.blob')!;
   const fields=fileContract.fields.map(field=>field.name);
   const outputs={vertices:[{...fileContract,keyEdges:[]},blobContract],edges:[]};
   writeFileSync(join(plugin,'plugin.json'),JSON.stringify({name:'disk',version:'1.0.0',entry:'entry.ts',tier:'core',capabilities:['filesystem'],concurrency:2,runtime:{name:'bun',version:Bun.version},tools:[{name:'git',source:'system',minimumVersion:'2.31'}],produces:[{kind:'code.file',fields:'*',reads:[],partition:'key',support:{vertices:['code.blob'],edges:[]}}]}));
   writeFileSync(join(plugin,'contract.json'),JSON.stringify({id:'disk',version:'1.0.0',outputs,rights:diskContract.rights}));
   for(const file of ['main.ts','reader.ts','git-bytes.ts','partition.ts','languages.json'])copyFileSync(join(import.meta.dir,'../plugins/disk',file),join(plugin,file));
   writeFileSync(join(plugin,'entry.ts'),`import {definePlugin} from 'madarch-plugin-sdk';
import {extract} from './main.ts';
import {partitioned} from './partition.ts';
import {single} from './scenario.js';
const output=partitioned(extract);
await definePlugin({name:'disk',version:'1.0.0',filesystem:true,graphReads:['ownFacts'],contract:${JSON.stringify(outputs)},
async planOutput(unit,context,cursor){const page=await output.planOutput(unit,context,cursor);return {...page,partitions:single?page.partitions.flatMap(part=>part.keys.map(key=>({keys:[key]}))):page.partitions};},
async extract(unit,context){await new Promise(resolve=>setTimeout(resolve,2000));return await output.extract(unit,context);}});`);
   writeFolderManifest(product,stringify({language:'en',kinds:{
    'code.file':{source:'graph',key:['path'],fields:fileContract.fields.map(({name,type,...field})=>({name,type,...('schema' in field?{schema:field.schema}:{}),producers:['disk']}))},
    'code.blob':{source:'graph',key:['digest'],fields:blobContract.fields.map(({name,type})=>({name,type,producers:['disk']})),evidence:blobContract.evidence},
   },'semantic-bindings':{file:{kind:'code.file',fields:{path:'path'}}},plugins:[{id:'disk',version:1,path:'plugins/disk',inputs:[],outputs:['code.file'],closure:['plugins/disk/plugin.json','plugins/disk/contract.json','plugins/disk/entry.ts','plugins/disk/main.ts','plugins/disk/reader.ts','plugins/disk/git-bytes.ts','plugins/disk/partition.ts','plugins/disk/languages.json','plugins/disk/scenario.js']}]}));
   for(const [runIndex,single] of [false,true,true].entries()){
    const manifest=JSON.parse(readFileSync(join(plugin,'plugin.json'),'utf8'));
    manifest.produces=[{kind:'code.file',fields:'*',reads:[],partition:'key',support:{vertices:['code.blob'],edges:[]}}];
    writeFileSync(join(plugin,'plugin.json'),JSON.stringify(manifest));
    writeFileSync(join(plugin,'scenario.js'),`export const single=${single}; export const nonce=${runIndex};`);
    const closure=closureOf(plugin).hash;
    writeFileSync(join(product,'madarch/plugins.lock'),stringify({plugins:[{id:'disk',path:'plugins/disk',version:'1.0.0',closure}]}));
    gitCommand(product,'add','-A');gitCommand(product,'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','--allow-empty','-qm',`groups-${single}`);
    const active=new Set<string>();let peak=0;
    const runId=`groups-${runIndex}`;
    const fill=await createStagesFill({product,prepareRepositoryInputs:async(pins,workRoot,options)=>prepareRepositoryInputs(pins.filter(pin=>pin.id==='repo'),workRoot,options),database:owner,runId,store:home,releaseHashes:[closure],targets:{kinds:['code.file']},prepareContract:async contract=>{await prepareTestStore(owner,{contract});}});
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
     if(planned.outcome==='refused')throw new Error(`${import.meta.path}:81: planning refused: ${JSON.stringify(planned)}`);
     let state='running';
     for(let pass=0;pass<30;pass++){
      const scheduled=await schedulerPass(orchestrator,{runId});state=scheduled.run.state;
      if(['succeeded','failed','blocked','cancelled'].includes(state))break;
      // The production driver calls workers sequentially; this fixture drives two real workers concurrently.
      const outcomes=await Promise.all([workOnce(orchestrator,{worker:'parallel-1'}),workOnce(orchestrator,{worker:'parallel-2'})]);
      if(outcomes.some(outcome=>outcome.result!==undefined&&['failed','retried','refused'].includes(outcome.result)))throw new Error(`${import.meta.path}:88: parallel fill failed: ${JSON.stringify(outcomes)}`);
      if(!scheduled.moved&&outcomes.every(outcome=>!outcome.claimed))throw new Error(`${import.meta.path}:89: parallel fill stalled: ${JSON.stringify(scheduled)}`);
     }
     if(state!=='succeeded')throw new Error(`${import.meta.path}:91: parallel fill did not succeed: ${JSON.stringify({state,progress:await readProgress(owner,runId)})}`);
     expect(state).toBe('succeeded');
    }finally{stopHeartbeat(orchestrator);await queue.stop();}
    for(const event of await readProgress(owner,runId)){
     if(!event.unitId.includes('disk:code.file#'))continue;
     if(event.kind==='unit-started')active.add(event.unitId);
     if(event.kind==='unit-published'||event.kind==='unit-failed')active.delete(event.unitId);
     peak=Math.max(peak,active.size);
    }
    console.info(JSON.stringify({helper:'real-disk',runId,peak,pin}));
    expect(peak).toBeGreaterThanOrEqual(2);
    await assertOpinions(runId,runIndex);
   }
   async function assertOpinions(runId:string,runIndex:number){
   const contract=await readPinnedGraphContract(product);
   await owner.transaction('snapshot',async tx=>{
    const commits=await readKindAssertions(tx,'vertex','code.file',fields,{contract});
    expect(commits.map(row=>row.key['path']).sort()).toEqual([...paths].sort());
    const sources=await readKindAssertions(tx,'vertex','plugin',['installation'],{contract});
    const gitSources=sources.filter(source=>source.values['installation']===JSON.stringify(['system-engine','disk']));
    expect(gitSources).toHaveLength(1);
    const gitSource=gitSources[0]!.uid;
    const assertions=await loadAssertions(tx,'vertex','code.file',['$exists',...fields]);
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.filter(row=>row.operation==='retract')).toEqual([]);
    for(const commit of commits)for(const property of ['$exists',...fields]){
     const open=assertions.filter(row=>row.subjectId===commit.id&&row.property===property&&row.validTo===null);
     expect(open).toHaveLength(1);
     expect(open[0]!.source).toBe(gitSource);
     console.info(JSON.stringify({helper:'real-disk',runId,path:commit.key['path'],property,open:open.length,source:open[0]!.source,gitSource}));
    }
    const runs=await readKindAssertions(tx,'vertex','system.run',['run_name'],{contract});
    const run=runs.find(row=>row.values['run_name']===runId)!;
    const units=await readKindAssertions(tx,'vertex','system.unit',['unit_name','committed_operations','outcome'],{contract});
    const operations=await readKindAssertions(tx,'vertex','system.operation',['key','canonical_request'],{contract});
    const links=(await tx.query<{operation:string;unit:string}>(`SELECT o.uid::text AS operation,u.uid::text AS unit FROM edge ou JOIN entity ouk ON ouk.id=ou.entity_id JOIN node o ON o.id=ou.from_node JOIN node u ON u.id=ou.to_node JOIN edge ur ON ur.from_node=u.id JOIN entity urk ON urk.id=ur.entity_id JOIN node r ON r.id=ur.to_node WHERE ouk.name='system.operation-unit' AND urk.name='system.unit-run' AND r.uid=$1::uuid`,[run.uid])).rows;
    const summaries=units.filter(unit=>String(unit.values['unit_name']).includes('disk:code.file#')&&links.some(link=>link.unit===unit.uid)).map(unit=>{
     const own=operations.filter(operation=>links.some(link=>link.unit===unit.uid&&link.operation===operation.uid));
     const applies=own.filter(operation=>{const raw=operation.values['canonical_request'];const canonical=typeof raw==='string'?JSON.parse(raw):raw;const request=canonical?.request;return request!==undefined&&((request.vertices??[]).some((vertex:{kind:string})=>vertex.kind==='code.file')||(request.edges??[]).some((edge:{kind:string})=>edge.kind==='code.file'));});
     return {unit:unit.values['unit_name'],committed:unit.values['committed_operations'],operations:own.length,applies:applies.length,outcome:unit.values['outcome'],foreignApplies:own.filter(operation=>{const raw=operation.values['canonical_request'];const canonical=typeof raw==='string'?JSON.parse(raw):raw;return (canonical?.request?.vertices??[]).some((vertex:{kind:string})=>vertex.kind==='code.blob');}).length};
    });
    console.info(JSON.stringify({helper:'real-disk',runId,operationSummary:summaries}));
    expect(summaries.length).toBeGreaterThan(1);
    // Foreign blob support is counted above, not asserted: it is outside own-kind reconciliation (ALX-1098 A1).
    if(runIndex>0)for(const summary of summaries)expect(summary.applies).toBe(0);
    const questions=await readKindAssertions(tx,'vertex','system.dispute-question',['state'],{contract});
    expect(questions).toEqual([]);
   });
   }
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
 },120_000);
