import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {writeFolderManifest} from './catalog-folder-fixture.js';
import {validateProductManifests,publishValidatedManifests} from '../src/graph/manifest-publication.js';
import {amendmentFixture} from './dispute-amendment-fixture.js';
import {fixture as mergeFixture,contract as mergeContract} from './dispute-merge-fixture.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {resolveDuplicate,unmerge} from '../src/graph/merges.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';

import {loadAssertions} from '../src/graph/assertion-read.js';

test('unmerge reconciles existence anchors on its members',async()=>{
 const f=await mergeFixture();try{
  const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,mergeContract,f.r,f.input));
  const question=crypto.randomUUID();
  await f.owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,mergeContract);
   const anchor=(await loadAssertions(tx,'vertex','sample',['$exists'],[f.rows[0]!.id]))[0]!;
   const q={kind:'system.dispute-question',uid:question,key:{}};
   await publishGraphDrafts(tx,mergeContract,{vertices:[{...q,values:{property:'$exists',language:null,segment_from:anchor.validFrom,segment_to:null,state:'OPEN'},validFrom:anchor.validFrom,producer:'fixture',producerVersion:'1'}],edges:[{kind:'system.dispute-anchor',from:q,to:{kind:'system.assertion',uid:anchor.id,key:{}},discriminator:anchor.id,validFrom:anchor.validFrom,producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  await f.execute(f.r,tx=>unmerge(tx,mergeContract,f.r,{mergeUid:merged.uid,reason:'Separate after review',evidence:f.input.evidence}));
  await f.owner.transaction('snapshot',async tx=>{const states=await loadAssertions(tx,'vertex','system.dispute-question',['state']);expect(states.some(row=>row.subject.type==='vertex'&&row.subject.uid===question&&row.value==='DISMISSED')).toBe(true);});
 }finally{await f.owner.close();}
},30000);

test('manifest publication reconciles all after evidence-support declaration',async()=>{
 const f=await amendmentFixture(true,false);const folder=mkdtempSync(join(tmpdir(),'dispute-publication-'));
 try{
  await f.retireSupport(true);await f.resolve();
  const decision=(await f.rows()).find(row=>row.selected)!;
  expect((await f.view(new Date().toISOString()))?.state).toBe('RESOLVED');
  mkdirSync(join(folder,'madarch'));
  writeFolderManifest(folder,'kinds: {}');
  execFileSync('git',['init','-q',folder]);
  execFileSync('git',['-C',folder,'add','-A']);
  execFileSync('git',['-C',folder,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','fixture']);
  const validated=validateProductManifests(folder);
  if(!validated.ok||validated.value===undefined)throw new Error(JSON.stringify(validated));
  const role={kind:'system.content-snapshot',fields:{},line:1,edges:{about:{kind:'justifies',direction:'from' as const,line:1}}};
  const manifest={...validated.value.manifest,semanticBindings:new Map([['evidence-support',role]])};
  // The catalogue stores the parser's exact tagged Map representation.
  const vertices=validated.value.vertices.map(vertex=>vertex.kind==='manifest.catalogue'?{...vertex,validFrom:'2020-01-01T00:00:00Z',values:{...vertex.values,declaration:JSON.stringify(manifest,(_key,value)=>value instanceof Map?{$map:[...value]}:value)}}:vertex);
  await publishValidatedManifests(f.owner,{...validated.value,manifest,vertices},{...f.contract,vertex:f.contract.vertex.filter(kind=>!kind.name.startsWith('system.')&&!kind.name.startsWith('manifest.')),edge:f.contract.edge.filter(kind=>!kind.name.startsWith('system.')&&!kind.name.startsWith('manifest.'))});
  const view=await f.view(new Date().toISOString());
  expect(view?.state).toBe('OPEN');
  expect((await f.rows(new Date().toISOString())).some(row=>row.source===decision.source&&row.operation==='retract')).toBe(true);
 }finally{await f.owner.close();rmSync(folder,{recursive:true,force:true});}
},30000);
