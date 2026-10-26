import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { createGuidePublication, type GuidePublicationOwner } from '../src/writer/guides/publication.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideArtifact } from '../src/writer/guides/artifact.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { readGuideGraph, type GuidePreparedEvidence } from '../src/writer/guides/writer.js';
import type { SnapshotSource } from '../src/fill/snapshot.js';
import { GUIDE_SCHEMA } from '../src/writer/guides/model.js';
import { seedStarterSet } from '../src/knowledge/seed.js';

test('real guide work-item publication rejects moved membership, superseded materialization and authored edits',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'guide-publication-'));const database=await createPGliteDatabaseOwner({btreeGist:true});
 try{
  seedStarterSet(folder);
  const store=createGraphStore(database);await store.createSchema();const scope=await store.newNode();
  await store.openNode({nodeId:scope,kind:'code.repository',label:'sample',properties:{},validFrom:'2026-01-01T00:00:00Z',owner:{producer:'fixture',scope}});
  const context={valid:'2026-04-01T00:00:00.000000Z',known:new Date().toISOString(),state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
  const evidence:GuidePreparedEvidence={context,facts:[],spans:[],gaps:[],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:[]}};
  const raw={schema:GUIDE_SCHEMA,id:'administrator-guide:main',kind:'administrator-guide',locale:'en',title:'Guide',context,unitVersion:'1',inputDigest:guideDigest(context),prerequisites:[],gaps:[],procedures:[{id:'check',title:'Check',goal:'Check source',role:'Reader',prerequisites:[],steps:[{id:'step',title:'Step',cwd:'.',environment:'isolated',inputs:[],instruction:{kind:'command',content:'status'},expected:{status:0,observation:'Ready'},grounds:[{repository:'sample',commit:'a'.repeat(40),path:'guide.md',line:1,endLine:1}]}]}]};
  const validation={file:join(folder,'docs/guides/administrator.md'),expectedContext:context,expectedInputDigest:raw.inputDigest,expectedUnitVersion:'1',containsSecret:()=>false,verifyStep:async()=>[]};
  const checked=await validateGuide(raw,validation);expect(checked.ok).toBe(true);if(!checked.ok)return;const guide=checked.guide;
  // Held snapshot port is unused: the complete prepared read set is empty in this negative control.
  const snapshots={pins:async()=>[],open:async()=>{throw new Error('no source span was prepared');}} as SnapshotSource;
  const membership=await readGuideGraph({owner:database,scope},context);
  const facts=[...membership.nodes,...membership.edges];
  const owner:GuidePublicationOwner={owner:database,store,snapshots,output:folder,scope,valid:context.valid,agent:{run:async()=>{}},sensitiveValues:[],kind:'administrator-guide',locale:'en',context,inputDigest:raw.inputDigest,unitVersion:'1',evidence:{...evidence,facts},readMembership:guideDigest(facts),verified:new Set([guideDigest({document:guideDigest(guide),step:guideStepDigest(guide,'check',guide.procedures[0]!.steps[0]!)})])};
  const publish=await createGuidePublication(owner);const request={guide,artifact:renderGuideArtifact(guide),expectedContext:context,expectedInputDigest:raw.inputDigest,expectedUnitVersion:'1'};
  const first=await publish(request);expect(first.ok).toBe(true);expect(await readFile(validation.file,'utf8')).toBe(request.artifact);
  expect((await publish(request)).ok).toBe(true);
  await writeFile(validation.file,'Human edited text');const conflict=await publish(request);expect(conflict.ok).toBe(false);expect(await readFile(validation.file,'utf8')).toBe('Human edited text');
  await rm(validation.file);
  const originalRun=database.run.bind(database);let supersede=true;
  const supersedingDatabase=new Proxy(database,{get(target,key){if(key==='transaction')return async <T>(kind:Parameters<typeof database.transaction>[0],work:(tx:import('../src/history/types.js').OuterTransaction)=>Promise<T>)=>{
    if(kind==='write'&&supersede){supersede=false;const generation=Number((await originalRun(async(tx)=>(await tx.query<{generation:string}>("SELECT max(generation)::text AS generation FROM work_item WHERE producer='writer.administrator-guide' AND scope_id=$1::bigint",[scope])).rows[0]))?.generation??0)+1;
      await store.openWorkItem({producer:'writer.administrator-guide',scope,generation,inputDigest:'newer-input',leaseToken:'newer-owner',leaseUntil:new Date(Date.now()+60000)});
      await store.publish({producer:'writer.administrator-guide',scope,generation,inputDigest:'newer-input',leaseToken:'newer-owner',nodes:[]});
    }
    return await database.transaction(kind,work);
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const superseded=await createGuidePublication({...owner,owner:supersedingDatabase});
  const supersededResult=await superseded(request);expect(supersededResult.ok).toBe(false);if(!supersededResult.ok)expect(supersededResult.diagnostics[0]!.code).toBe('outbox-superseded-or-edited');
  expect(await readFile(validation.file,'utf8').catch(()=>undefined)).toBeUndefined();
  const originalTransaction=database.transaction.bind(database);
  let race=true;
  const racingDatabase=new Proxy(database,{get(target,key){if(key==='transaction')return async <T>(kind:Parameters<typeof database.transaction>[0],work:(tx:import('../src/history/types.js').OuterTransaction)=>Promise<T>)=>{if(kind==='write'&&race){race=false;await store.openNode({kind:'code.file',label:'new.txt',properties:{path:'new.txt'},validFrom:context.valid,owner:{producer:'fixture',scope}});}return await originalTransaction(kind,work);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const changedGuideResult=await validateGuide({...raw,title:'Changed guide'},validation);expect(changedGuideResult.ok).toBe(true);if(!changedGuideResult.ok)return;
  const changedGuide=changedGuideResult.guide;
  const stale=await createGuidePublication({...owner,owner:racingDatabase,verified:new Set([guideDigest({document:guideDigest(changedGuide),step:guideStepDigest(changedGuide,'check',changedGuide.procedures[0]!.steps[0]!)})])});
  const refused=await stale({...request,guide:changedGuide,artifact:renderGuideArtifact(changedGuide)});
  expect(refused.ok).toBe(false);if(!refused.ok)expect(refused.diagnostics[0]!.code).toBe('graph-read-moved');
  expect(await readFile(validation.file,'utf8').catch(()=>undefined)).toBeUndefined();
 }finally{await database.close();await rm(folder,{recursive:true,force:true});}
},20000);
