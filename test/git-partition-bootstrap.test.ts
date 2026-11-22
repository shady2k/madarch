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
import gitContract from '../plugins/git/contract.json';

for(const omitBootstrap of [false,true]) test(`repository-only bootstrap precedes a first K child citing P across different owner groups; omitted=${omitBootstrap}`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'madarch-commit-regroup-'));
  const owner=await createTestDatabaseOwner({btreeGist:true});
  const gitCommand=(folder:string,...args:string[])=>execFileSync('git',['-C',folder,...args],{stdio:'pipe',env:{...process.env,GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}});
  try{
   const repo=join(root,'repo');mkdirSync(repo);
   gitCommand(repo,'init','-q','-b','main');
   let observed=false;
   let firstKApplied=false;
   let firstKSnapshot:{key:Record<string,unknown>;fields:string[]}[]=[];
   const hashes:string[]=[];
   for(let index=0;index<4;index++){
    writeFileSync(join(repo,'source.txt'),`source-${index}`);
    gitCommand(repo,'add','-A');
    const message=join(root,'message');writeFileSync(message,`commit-${index} ${'x'.repeat(100000)}`);
    gitCommand(repo,'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','-F',message);
    hashes.push(gitCommand(repo,'rev-parse','HEAD').toString('utf8').trim());
   }
   const home=join(root,'home');mkdirSync(home);
   const product=makeProduct(home,'regroup',repo,'repo');seedStarterSet(product);
   const plugin=join(product,'plugins/git');mkdirSync(plugin,{recursive:true});
   const commitContract=gitContract.outputs.vertices.find(vertex=>vertex.kind==='code.commit')!;
   const parentContract=gitContract.outputs.edges.find(edge=>edge.kind==='code.parent')!;
   const fields=commitContract.fields.map(field=>field.name);
   const repositoryContract=gitContract.outputs.vertices.find(vertex=>vertex.kind==='code.repository')!;
   const outputs={vertices:[commitContract,repositoryContract],edges:[parentContract]};
   writeFileSync(join(plugin,'plugin.json'),JSON.stringify({name:'git',version:'1.0.0',entry:'entry.ts',tier:'core',capabilities:['git'],concurrency:1,runtime:{name:'bun',version:Bun.version},tools:[{name:'git',source:'system',minimumVersion:'2.31'}],produces:[{kind:'code.commit',fields:'*',reads:['code.file','code.repository'],partition:'key',support:{vertices:['code.commit'],edges:[]}}]}));
   writeFileSync(join(plugin,'contract.json'),JSON.stringify({id:'git',version:'1.0.0',outputs,rights:gitContract.rights}));
   for(const file of ['main.ts','reader.ts','git-bytes.ts','partition.ts'])copyFileSync(join(import.meta.dir,'../plugins/git',file),join(plugin,file));
   writeFileSync(join(plugin,'entry.ts'),`import {definePlugin} from 'madarch-plugin-sdk';
import {extract} from './main.ts';
import {partitioned} from './partition.ts';
import {single,nonce,omitBootstrap} from './scenario.js';
const output=partitioned(extract);
await definePlugin({name:'git',version:'1.0.0',filesystem:true,graph:true,contract:${JSON.stringify(outputs)},
async planOutput(unit,context,cursor){const page=await output.planOutput(unit,context,cursor);const keys=page.partitions.flatMap(part=>part.keys).filter(key=>nonce!==1||key.hash===${JSON.stringify(hashes[1])}).sort((a,b)=>a.hash===${JSON.stringify(hashes[1])}?-1:b.hash===${JSON.stringify(hashes[1])}?1:0);return {...page,partitions:single?keys.map(key=>({keys:[key]})):Array.from({length:Math.ceil(keys.length/2)},(_,index)=>({keys:keys.slice(index*2,index*2+2)}))};},
async extract(unit,context){
if(omitBootstrap&&unit.kind==='code.repository')return {vertices:[],edges:[],end:{state:'complete'}};
const answer=await output.extract(unit,context);
if(unit.kind==='code.commit'&&unit.inputs.keys?.some(key=>key.hash===${JSON.stringify(hashes[1])})) {
const own=await context.graph.ownFacts({});
console.error(JSON.stringify({capture:'K-child',own:own.vertices.map(v=>v.key),desired:answer.vertices.map(v=>v.key)}));
if(!own.vertices.some(v=>v.key.hash===${JSON.stringify(hashes[1])})) {
if(own.vertices.length!==0) throw new Error('first K child must have no own vertices');

if(answer.edges.some(e=>e.from.key.hash===${JSON.stringify(hashes[1])}&&e.to.key.hash===${JSON.stringify(hashes[3])})) throw new Error('K has edge to P');
}

if(!answer.vertices.some(v=>v.key.hash===${JSON.stringify(hashes[0])})) throw new Error('missing parent Q');
}
return answer;}});`);
   const labels={en:{out:'repository',in:'file'},ru:{out:'repository',in:'file'}};
   writeFolderManifest(product,stringify({language:'en',kinds:{
    'code.commit':{source:'graph','derives-from':['code.file','code.repository'],key:['hash'],fields:commitContract.fields.map(({name,type})=>({name,type,producers:['git']})),evidence:commitContract.evidence},
    'code.repository':{source:'graph',key:['name'],fields:[{name:'name',type:'text',producers:['person']},{name:'url',type:'text',producers:['person']},{name:'history_shallow',type:'boolean',producers:['git']}]},
    'code.file':{source:'graph',key:['path'],fields:[{name:'path',type:'text',producers:['person']}],'key-edges':[{role:'code.file-repository',edge:'code.file-repository',side:'from'}]},
   },'semantic-bindings':{file:{kind:'code.file',fields:{path:'path'},edges:{repository:{kind:'code.file-repository',direction:'from'}}},repository:{kind:'code.repository',fields:{name:'name',url:'url'}}},edges:[{name:'code.parent',from:['code.commit'],to:['code.commit'],fields:parentContract.fields!.map(({name,type})=>({name,type,producers:['git']})),cardinality:{from:{min:0,max:null},to:{min:0,max:null}},labels:parentContract.labels},{name:'code.file-repository','on-parent-delete':'restrict',from:['code.file'],to:['code.repository'],cardinality:{from:{min:1,max:1},to:{min:0,max:null}},labels}],plugins:[{id:'git',version:1,path:'plugins/git',inputs:['code.file','code.repository'],outputs:['code.commit','code.repository'],closure:['plugins/git/plugin.json','plugins/git/contract.json','plugins/git/entry.ts','plugins/git/main.ts','plugins/git/reader.ts','plugins/git/git-bytes.ts','plugins/git/partition.ts','plugins/git/scenario.js']}]}));

   for(const [runIndex,single] of [false,true,false,false,true].entries()){
    if(omitBootstrap&&runIndex===0)continue;
    if(omitBootstrap&&runIndex>1)break;
    // The immutable pin must already exist. Both setup runs use actual unpartitioned git extraction through the SDK.
    const bootstrap=runIndex===0;
    const pinBootstrap=runIndex===0;
    const manifest=JSON.parse(readFileSync(join(plugin,'plugin.json'),'utf8'));
    manifest.produces=[{kind:'code.repository',fields:['history_shallow'],reads:['code.repository'],support:{vertices:['code.commit'],edges:[]}},{kind:'code.commit',fields:'*',reads:['code.file','code.repository'],...(bootstrap?{}:{partition:'key'}),support:{vertices:['code.commit'],edges:[]}}];

    writeFileSync(join(plugin,'plugin.json'),JSON.stringify(manifest));
    writeFileSync(join(plugin,'scenario.js'),`export const single=${single}; export const nonce=${runIndex}; export const omitBootstrap=${omitBootstrap};`);
    const closure=closureOf(plugin).hash;
    writeFileSync(join(product,'madarch/plugins.lock'),stringify({plugins:[{id:'git',path:'plugins/git',version:'1.0.0',closure}]}));
    gitCommand(product,'add','-A');gitCommand(product,'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','--allow-empty','-qm',`groups-${single}`);
    const active=new Set<string>();let peak=0;
    const runId=bootstrap?`bootstrap-${runIndex}`:`groups-${runIndex}`;
    // Closure commits belong to the product, not the fixed source history under test. Keep the actual source snapshot.
    const fill=await createStagesFill({product,prepareRepositoryInputs:async(pins,workRoot,options)=>prepareRepositoryInputs(pins.filter(pin=>pin.id==='repo'),workRoot,options),database:owner,runId,store:home,releaseHashes:[closure],targets:{kinds:[pinBootstrap?'code.repository':'code.commit']},prepareContract:async contract=>{await prepareTestStore(owner,{contract});}});
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
     if(planned.outcome==='refused')throw new Error(`${import.meta.path}:88: planning refused: ${JSON.stringify(planned)}`);
     let state='running';
     for(let pass=0;pass<30;pass++){
      const scheduled=await schedulerPass(orchestrator,{runId});state=scheduled.run.state;
      if(['succeeded','failed','blocked','cancelled'].includes(state))break;
      // Execute a single worker so the first selected child precedes the pin owner.
      const outcomes=[await workOnce(orchestrator,{worker:'serial'})];
      if(omitBootstrap&&outcomes.some(outcome=>outcome.result==='failed')){
      expect(JSON.stringify(outcomes)).toContain('MISSING_ENDPOINT code.commit');
      const contract=await readPinnedGraphContract(product);
      await owner.transaction('snapshot',async tx=>{
       const commits=await readKindAssertions(tx,'vertex','code.commit',fields,{contract});
       expect(commits).toEqual([]);
       console.info(JSON.stringify({negative:'missing-bootstrap',P:hashes[3],outcomes,present:commits.map(commit=>commit.key['hash'])}));
      });
      return;
     }
     if(outcomes.some(outcome=>outcome.result!==undefined&&['failed','retried','refused'].includes(outcome.result)))throw new Error(`${import.meta.path}:95: parallel fill failed: ${JSON.stringify(outcomes)}`);
      if(!omitBootstrap&&runIndex===1&&outcomes.some(outcome=>outcome.claimed&&outcome.result!==undefined&&outcome.result!=='failed')){
       const contract=await readPinnedGraphContract(product);
       await owner.transaction('snapshot',async tx=>{
        const commits=await readKindAssertions(tx,'vertex','code.commit',fields,{contract});
        const k=commits.find(commit=>commit.key['hash']===hashes[1]);
        const p=commits.find(commit=>commit.key['hash']===hashes[3]);
        if(k!==undefined&&!firstKApplied){
         firstKApplied=true;
         firstKSnapshot=commits.map(commit=>({key:commit.key,fields:Object.keys(commit.values).sort()}));
         expect(p,`${import.meta.path}:137: first K apply must observe bootstrap P before its owner`).toBeDefined();
         expect(Object.keys(p!.values).sort(),`${import.meta.path}:138: P owner must not precede first K apply`).toEqual(['$exists','hash']);
         expect(p!.values['subject']).toBeUndefined();
         expect(Object.keys(k.values).sort()).toEqual(['$exists',...fields].sort());
         expect(commits.some(commit=>commit.key['hash']===hashes[0])).toBe(true);
         observed=true;
         console.info(JSON.stringify({capture:'K-before-P-owner',present:firstKSnapshot}));
        }
       });
      }
      if(!scheduled.moved&&outcomes.every(outcome=>!outcome.claimed))throw new Error(`${import.meta.path}:96: parallel fill stalled: ${JSON.stringify(scheduled)}`);
     }
     if(state!=='succeeded')throw new Error(`${import.meta.path}:98: parallel fill did not succeed: ${JSON.stringify({state,progress:await readProgress(owner,runId)})}`);
     if(omitBootstrap)throw new Error('missing-bootstrap extraction unexpectedly succeeded');
     expect(state).toBe('succeeded');
     if(runIndex===1){
      expect(observed,`${import.meta.path}:153: first K apply observation is required`).toBe(true);
      expect(firstKSnapshot.find(commit=>commit.key['hash']===hashes[3])?.fields).toEqual(['$exists','hash']);
      expect(firstKSnapshot.find(commit=>commit.key['hash']===hashes[1])?.fields).toEqual(['$exists',...fields].sort());
     }
    }finally{stopHeartbeat(orchestrator);await queue.stop();}
    for(const event of await readProgress(owner,runId)){
     if(!event.unitId.includes('git:code.commit#'))continue;
     if(event.kind==='unit-started')active.add(event.unitId);
     if(event.kind==='unit-published'||event.kind==='unit-failed')active.delete(event.unitId);
     peak=Math.max(peak,active.size);
    }
    console.info(JSON.stringify({helper:'real-git',runId,peak,bootstrap,pin:hashes.at(-1)}));
    if(!bootstrap)expect(peak).toBe(1);
    if(pinBootstrap){
      const contract=await readPinnedGraphContract(product);
      await owner.transaction('snapshot',async tx=>{
        const commits=await readKindAssertions(tx,'vertex','code.commit',fields,{contract});
        console.info(JSON.stringify({prerequisite:'repository-only bootstrap',P:hashes[3],K:hashes[1],Q:hashes[0],present:commits.map(row=>row.key['hash'])}));
        expect(commits.map(row=>row.key['hash'])).toEqual([hashes[3]!]);
      });
    }
    if(!pinBootstrap)await assertOpinions(runId,runIndex);
   }
   async function assertOpinions(runId:string,runIndex:number){
   const contract=await readPinnedGraphContract(product);
   await owner.transaction('snapshot',async tx=>{
    const commits=await readKindAssertions(tx,'vertex','code.commit',fields,{contract});
    expect(commits.map(row=>row.key['hash']).sort()).toEqual([...hashes].sort());
    const sources=await readKindAssertions(tx,'vertex','plugin',['installation'],{contract});
    const gitSources=sources.filter(source=>source.values['installation']===JSON.stringify(['system-engine','git']));
    expect(gitSources).toHaveLength(1);
    const gitSource=gitSources[0]!.uid;
    const assertions=await loadAssertions(tx,'vertex','code.commit',['$exists',...fields]);
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.filter(row=>row.operation==='retract')).toEqual([]);
    for(const commit of commits)for(const property of ['$exists',...fields]){
     const open=assertions.filter(row=>row.subjectId===commit.id&&row.property===property&&row.validTo===null);
     expect(open).toHaveLength(1);
     expect(open[0]!.source).toBe(gitSource);
     console.info(JSON.stringify({helper:'real-git',runId,hash:commit.key['hash'],property,open:open.length,source:open[0]!.source,gitSource}));
    }
    const runs=await readKindAssertions(tx,'vertex','system.run',['run_name'],{contract});
    const run=runs.find(row=>row.values['run_name']===runId)!;
    const units=await readKindAssertions(tx,'vertex','system.unit',['unit_name','committed_operations','outcome'],{contract});
    const operations=await readKindAssertions(tx,'vertex','system.operation',['key','canonical_request'],{contract});
    const links=(await tx.query<{operation:string;unit:string}>(`SELECT o.uid::text AS operation,u.uid::text AS unit FROM edge ou JOIN entity ouk ON ouk.id=ou.entity_id JOIN node o ON o.id=ou.from_node JOIN node u ON u.id=ou.to_node JOIN edge ur ON ur.from_node=u.id JOIN entity urk ON urk.id=ur.entity_id JOIN node r ON r.id=ur.to_node WHERE ouk.name='system.operation-unit' AND urk.name='system.unit-run' AND r.uid=$1::uuid`,[run.uid])).rows;
    const summaries=units.filter(unit=>String(unit.values['unit_name']).includes('git:code.commit#')&&links.some(link=>link.unit===unit.uid)).map(unit=>{
     const own=operations.filter(operation=>links.some(link=>link.unit===unit.uid&&link.operation===operation.uid));
     const applies=own.filter(operation=>{const raw=operation.values['canonical_request'];const canonical=typeof raw==='string'?JSON.parse(raw):raw;const request=canonical?.request;return request!==undefined&&(request.vertices!==undefined||request.edges!==undefined);});
     return {unit:unit.values['unit_name'],committed:unit.values['committed_operations'],operations:own.length,applies:applies.length,outcome:unit.values['outcome'],foreignApplies:own.filter(operation=>{const raw=operation.values['canonical_request'];const canonical=typeof raw==='string'?JSON.parse(raw):raw;return (canonical?.request?.vertices??[]).some((vertex:{kind:string})=>vertex.kind==='code.blob');}).length};
    });
    if(runIndex===1){
     const applies=operations.filter(operation=>links.some(link=>link.operation===operation.uid)).flatMap(operation=>{
      const raw=operation.values['canonical_request'];const canonical=typeof raw==='string'?JSON.parse(raw):raw;
      return canonical?.request?.vertices===undefined?[]:[canonical.request];
     });
     const first=applies.find(request=>request.vertices.some((vertex:{key:{hash:string}})=>vertex.key.hash===hashes[1]))!;
     expect(first).toBeDefined();

     expect(first.vertices.some((vertex:{key:{hash:string}})=>vertex.key.hash===hashes[3])).toBe(false);
     expect(first.vertices.some((vertex:{key:{hash:string}})=>vertex.key.hash===hashes[0])).toBe(true);
     expect(first.edges.some((edge:{from:{key:{hash:string}};to:{key:{hash:string}}})=>edge.from.key.hash===hashes[1]&&edge.to.key.hash===hashes[0])).toBe(true);
     console.info(JSON.stringify({capture:'first-K-apply',vertices:first.vertices.map((vertex:{key:unknown})=>vertex.key),edges:first.edges}));
     const parent=await readKindAssertions(tx,'edge','code.parent',['position'],{contract});
     const k=commits.find(commit=>commit.key['hash']===hashes[1])!;
     const q=commits.find(commit=>commit.key['hash']===hashes[0])!;
     expect(parent.some(edge=>edge.from===k.id&&edge.to===q.id)).toBe(true);
     const evidence=assertions.filter(row=>row.subjectId===k.id&&row.property==='subject');
     expect(evidence.length).toBeGreaterThan(0);
     expect(evidence.some(row=>row.evidenceAttachments.some(attachment=>attachment.key['hash']===hashes[3]&&attachment.locator.includes(hashes[3]!)))).toBe(true);
     console.info(JSON.stringify({capture:'persisted-K-evidence',evidence:evidence.map(row=>({evidence:row.evidence,evidenceAttachments:row.evidenceAttachments,repositoryTargets:row.repositoryTargets}))}));
    }
    console.info(JSON.stringify({helper:'real-git',runId,operationSummary:summaries}));
    if(runIndex===1){expect(summaries.length).toBeGreaterThan(0);}
    if(runIndex===4)expect(summaries.length).toBe(hashes.length);
    if(runIndex>2)for(const summary of summaries){expect(summary.applies).toBe(0);expect(summary.outcome).toBe('unchanged');}
    const questions=await readKindAssertions(tx,'vertex','system.dispute-question',['state'],{contract});
    expect(questions).toEqual([]);
   });
   }
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
 },120_000);

