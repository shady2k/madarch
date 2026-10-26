/** A complete named-setting catalogue is consumed in bounded production packets, never put in one coverage row. */
import { expect,test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPGliteDatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore} from '../src/graph/index.js';
import {fillGraph} from '../src/extract/driver/index.js';
import {extractFiles} from '../src/extract/driver/files.js';
import {createGitSnapshotSource} from '../src/fill/snapshot.js';
import {createGuideWriter,guidePacketPolicy,prepareGuideEvidence,resolveGuideContext} from '../src/writer/guides/writer.js';
import {firstGuideCursor,readGuidePageContext,guidePagesComplete,GUIDE_PACKET_BYTES,type GuideContextPage} from '../src/writer/guides/prepared.js';
import {guideDigest} from '../src/writer/guides/digest.js';
import {seedStarterSet} from '../src/knowledge/seed.js';
import {gitEnv} from './git-env.js';
import {byCodePoint} from '../src/model/order.js';

test('actual prepared guide paginates every named configuration reference with complete digest and no private values',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'guide-reference-pages-'));const owner=createPGliteDatabaseOwner({btreeGist:true});
 try{
  const configuration=Object.fromEntries(Array.from({length:1000},(_,index)=>[`ordinary_setting_${index}`,'Ready']));
  const expected=Object.keys(configuration).map((name)=>`‹value of settings.json:$document[0].${name}›`).sort(byCodePoint);
  writeFileSync(join(folder,'settings.json'),JSON.stringify(configuration,null,2));
  writeFileSync(join(folder,'README.md'),'# Readiness\n\nRead the public status from the repository root\n');
  const env=gitEnv({GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:folder,env,encoding:'utf8'}).trim();
  git('init','--quiet','--initial-branch=main');git('add','.');git('-c','commit.gpgsign=false','commit','--quiet','-m','Record named settings');const commit=git('rev-parse','HEAD');
  seedStarterSet(folder);
  const store=createGraphStore(owner);await store.createSchema();const filled=await fillGraph({owner,store,repository:folder,extractors:[extractFiles]});
  const snapshots=createGitSnapshotSource([{id:'sample',form:'code',root:folder,commit}]);
  const wiring={owner,store,snapshots,scope:filled.repositoryNode,valid:filled.commits[0]!.effectiveTime,output:folder,agent:{run:async()=>{throw new Error('preparation does not call the agent');}}};
  const context=await resolveGuideContext(wiring);const complete=await prepareGuideEvidence(wiring,context);
  expect(guidePacketPolicy(complete).evidence.policy.references).toEqual(expected);
  expect(expected).toHaveLength(1000);expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(GUIDE_PACKET_BYTES);
  const writer=await createGuideWriter(wiring);const unit=await writer.prepare('administrator-guide','en');
  expect(guidePagesComplete(unit)).toBe(false);let cursor:string|null=firstGuideCursor(unit)!;const references:string[]=[];let count=0;let coverage:Record<string,unknown>|undefined;
  while(cursor!==null){
   const packet:GuideContextPage=readGuidePageContext(unit,cursor)!;expect(Buffer.byteLength(JSON.stringify(packet.entries))).toBeLessThanOrEqual(GUIDE_PACKET_BYTES);
   for(const value of packet.entries){
    expect(JSON.stringify(value)).not.toContain('Ready');
    const entry=value as Record<string,unknown>;
    if(entry['type']==='setting-reference'){const reference=entry['reference'];if(typeof reference!=='string')throw new Error('setting reference entry has no text');references.push(reference);}
    if(entry['type']==='coverage'){if(entry['policy']===null||typeof entry['policy']!=='object')throw new Error('coverage has no policy');coverage=entry['policy'] as Record<string,unknown>;}
   }
   cursor=packet.next;count++;
  }
  expect(count).toBeGreaterThan(1);expect(guidePagesComplete(unit)).toBe(true);expect(references).toEqual(expected);expect(new Set(references).size).toBe(1000);
  expect(coverage).toBeDefined();expect(coverage?.['references']).toBeUndefined();expect(coverage?.['referenceCount']).toBe(1000);expect(coverage?.['referenceSetDigest']).toBe(guideDigest(expected));
  // The private preparation and public durable proof still account for the entire input, not just the first packet.
  expect(complete.configReferences).toHaveLength(1000);expect(guideDigest(guidePacketPolicy(complete).evidence.policy.references)).toBe(guideDigest(references));
 }finally{await owner.close();rmSync(folder,{recursive:true,force:true});}
},60_000);
