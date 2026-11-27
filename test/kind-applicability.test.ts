import {fillPlanView} from '../src/knowledge/fill-plan.js';
import { planPluginTurns, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { parsePluginManifest } from '../src/plugin/closure.js';
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { fillProductProfile } from '../src/graph/product-profile.js';
import { createGitSnapshotSource } from '../src/plugin/repository-snapshot.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { assertApplicability, assertOutcomeApplicability, cascadeApplicability, storedApplicability } from '../src/graph/applicability.js';
import { readKindAssertions } from '../src/graph/records.js';

for (const kubernetes of [false,true]) test(`0039.35: pinned fixture ${kubernetes ? 'with':'without'} Kubernetes markers, explicit cascade only`,async () => {
 const folder=mkdtempSync(join(tmpdir(),'profile-fixture-'));
 mkdirSync(join(folder,'madarch'));
 writeFolderManifest(folder,`kinds:
  cluster:
    source: graph
    applicability: {dependencies: [], markers: ['**/Chart.yaml'], profile: deployment}
  workload:
    source: graph
    applicability: {dependencies: [cluster], markers: []}
  structural:
    source: graph
    derives-from: [cluster]
  profile:
    source: graph
    profile-markers: {languages: ['**/*.ts']}
    key-edges: [{role: scope, edge: profile-scope, side: from}]
    fields:
    - {name: languages, type: json, schema: {$schema: 'https://json-schema.org/draft/2020-12/schema', type: array, items: {type: string}}, nullable: true, producers: [profile-markers]}
edges:
- name: profile-scope
  from: [profile]
  to: [system.product]
  cardinality: {from: {min: 1, max: 1}, to: {min: 0, max: null}}
  on-parent-delete: cascade
  labels: {en: {out: describes, in: described by}, ru: {out: describes, in: described by}}
`);
 writeFileSync(join(folder,'README.md'),'fixture');
 writeFileSync(join(folder,'main.ts'),'export const value = 1;');
 if(kubernetes)writeFileSync(join(folder,'Chart.yaml'),'apiVersion: v2');
 execFileSync('git',['init','-q',folder]);
 execFileSync('git',['-C',folder,'add','.']);
 execFileSync('git',['-C',folder,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','fixture']);
 const validated=validateProductManifests(folder);
 if(!validated.ok || validated.value===undefined)throw new Error(JSON.stringify(validated));
 const manifest=validated.value.manifest;
 const contract=withManifestContract(graphContractOf(manifest));
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try {
  await publishValidatedManifests(owner,validated.value,contract);
  const commit = execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  // Reverse the marker in the worktree after pinning: the profile must use the committed tree.
  if (kubernetes) rmSync(join(folder, 'Chart.yaml'));
  else writeFileSync(join(folder, 'Chart.yaml'), 'apiVersion: v2');
  const source=createGitSnapshotSource([{id:'fixture',root:folder,form:'code',commit}]);
  expect(await fillProductProfile(owner,contract,manifest,createGitSnapshotSource([]))).toEqual([]);
  await expect(fillProductProfile(owner,contract,manifest,createGitSnapshotSource([{id:'missing',root:join(folder,'missing'),form:'code',commit:'HEAD'}]))).rejects.toThrow();
  expect(await storedApplicability(owner,contract)).toEqual([]);
  const marks=await fillProductProfile(owner,contract,manifest,source);
  const profiles = await owner.run(tx=>readKindAssertions(tx,'vertex','profile',['languages'],{contract}));
  expect(profiles[0]?.values['languages']).toEqual(['main.ts']);
  expect(marks.find(mark=>mark.kind==='cluster')?.state).toBe(kubernetes?'applicable':'inapplicable');
  expect(marks.find(mark=>mark.kind==='structural')).toBeUndefined();
  expect(marks.find(mark=>mark.kind==='workload')?.state).toBe(kubernetes?undefined:'inapplicable');
  expect(marks[0]?.evidence.length).toBeGreaterThan(0);
  const declaration = parsePluginManifest(JSON.stringify({name:'mock-agent',version:'1.0.0',entry:'index.ts',runtime:{name:'bun',version:Bun.version},agent:{prompt:'Mock only',roots:['product'],catalogue:true},produces:[{kind:'cluster',fields:'*'}]}),join(folder,'plugin.json'));
  const agentManifest = {...manifest,plugins:new Map([['mock-agent',{id:'mock-agent',version:'1.0.0',inputs:[],outputs:['cluster'],closure:[],line:1,declaration,contract:{id:'mock-agent',version:'1.0.0',reads:'unit' as const,file:join(folder,'plugin.json'),agent:declaration.agent,vertices:[],edges:[]}}]])};
  const planned = await planPluginTurns({owner,contract,manifest:agentManifest,snapshots:source,productFolder:folder,locks:new Map([['mock-agent',{id:'mock-agent',version:'1.0.0',closure:'a'.repeat(64),path:'plugins/mock-agent',line:1}]]),targets:{kinds:['cluster']},agent:{}} as unknown as PluginTurnWiring);
  expect(planned.map(unit=>unit.kind.name)).toEqual(kubernetes?['cluster']:[]);
  const view=fillPlanView(agentManifest,folder,['cluster'],['cluster'],[],false,marks);
  expect(view.skipped.find(skip=>skip.kind==='cluster')?.reason).toBe(kubernetes?undefined:marks.find(mark=>mark.kind==='cluster')?.reason);
  expect(view.units.map(unit=>unit.kind)).toEqual(kubernetes?['cluster']:[]);
  if(!kubernetes){
   const records=await owner.run(tx=>readKindAssertions(tx,'vertex','system.kind-applicability',['state'],{contract}));
   expect(records.some(record=>record.selectedAssertions.some(assertion=>assertion.evidence.some(uid=>records.some(parent=>parent.assertions.some(a=>a.id===uid)))))).toBe(true);
  }

  const evidence = [{target:{kind:'system.assertion',key:{},uid:(await owner.run(tx=>readKindAssertions(tx,'vertex','system.kind-applicability',['state'],{contract})))[0]!.selectedAssertions.find(row=>row.property==='state')!.id}}];
  if (!kubernetes) {
   await owner.transaction('write',async tx=>{
    await startupBinding(tx,contract,'profile-markers');
    await assertApplicability(tx,contract,'cluster','applicable','Instances now found',evidence);
    await cascadeApplicability(tx,contract,manifest);
   });
   const replaced = await storedApplicability(owner,contract);
   expect(replaced.find(mark=>mark.kind==='cluster')?.state).toBe('applicable');
   expect(replaced.find(mark=>mark.kind==='cluster')?.contested).toBe(false);
   expect(replaced.find(mark=>mark.kind==='workload')?.state).not.toBe('inapplicable');
   await owner.transaction('write',async tx=>{
    await startupBinding(tx,contract,'another-source');
    await assertApplicability(tx,contract,'cluster','inapplicable','Searched another snapshot',evidence);
   });
   expect((await storedApplicability(owner,contract)).find(mark=>mark.kind==='cluster')?.contested).toBe(true);
   // A turn that finds the kind already inapplicable completes as inapplicable, and that completion never restates the
   // stored mark: the agent's search, its reason and its evidence stand (ALX-1856, the agent-turn path).
   const stored = (await storedApplicability(owner,contract)).find(mark=>mark.kind==='cluster')!;
   expect(stored.state).toBe('inapplicable');
   await owner.transaction('write',async tx=>{
    await startupBinding(tx,contract,'mock-agent');
    await assertOutcomeApplicability(tx,contract,{plugin:'mock-agent',kind:'cluster',outcome:'inapplicable',produced:0,reason:'No applicable document'},stored.evidence[0]!,stored.reason);
   });
   const kept = (await storedApplicability(owner,contract)).find(mark=>mark.kind==='cluster')!;
   expect({state:kept.state,reason:kept.reason,evidence:kept.evidence}).toEqual({state:stored.state,reason:stored.reason,evidence:stored.evidence});
  }

 }finally{await owner.close();rmSync(folder,{recursive:true,force:true});}
},30000);
