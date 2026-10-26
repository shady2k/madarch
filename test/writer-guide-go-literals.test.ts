/** Actual pinned source preparation: Go strings are bytes, JS/TS hex escapes are code units. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { prepareGuideEvidence, resolveGuideContext, guidePacketPolicy } from '../src/writer/guides/writer.js';
import { firstGuideCursor, readGuidePageContext, registerGuidePages, type GuideContextPage } from '../src/writer/guides/prepared.js';
import type { GuidePreparedUnit } from '../src/writer/guides/host-contract.js';
import { guideDigest } from '../src/writer/guides/digest.js';
import { gitEnv } from './git-env.js';

test('pinned Go hex/octet, octal and Unicode escapes match UTF-8 secrets while JS hex retains code-unit semantics',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'guide-go-literal-'));const owner=createPGliteDatabaseOwner({btreeGist:true});
 try{
  const secret='café';
  const text:Record<string,string>={
   'settings.json':JSON.stringify({value:secret}),
   'hex.go':'package example\nconst value = "caf\\xc3\\xa9"\n',
   'octal.go':'package example\nconst value = "caf\\303\\251"\n',
   'unicode.go':'package example\nconst value = "caf\\u00e9"\n',
   'long-unicode.go':'package example\nconst value = "caf\\U000000e9"\n',
   'mixed.go':'package example\nconst value = "café\\xc3\\xa9"\n',
   'raw.go':'package example\nconst value = `ca\rfé`\n',
   'invalid.go':'package example\nconst value = "caf\\xff"\n',
   'javascript.js':'export const value = "caf\\xc3\\xa9";\n',
   'typescript.ts':'export const value = "caf\\xc3\\xa9";\n',
   'unicode.ts':'export const value = "caf\\u00e9";\n',
  };
  for(const [path,value]of Object.entries(text))writeFileSync(join(folder,path),value);
  const env=gitEnv({GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:folder,env,encoding:'utf8'}).trim();
  git('init','--quiet','--initial-branch=main');git('add','.');git('-c','commit.gpgsign=false','commit','--quiet','-m','Record language literal sources');const commit=git('rev-parse','HEAD');
  const store=createGraphStore(owner);await store.createSchema();const filled=await fillGraph({owner,store,repository:folder,extractors:[extractFiles]});
  const snapshots=createGitSnapshotSource([{id:'sample',form:'code',root:folder,commit}]);const wiring={owner,snapshots,scope:filled.repositoryNode,valid:filled.commits[0]!.effectiveTime};
  const context=await resolveGuideContext(wiring);const original=await prepareGuideEvidence(wiring,context);
  for(const path of ['hex.go','octal.go','unicode.go','long-unicode.go','raw.go','unicode.ts'])expect(original.spans.find((span)=>span.ground.path===path)?.sourceLiterals).toContain(secret);
  expect(original.spans.find((span)=>span.ground.path==='mixed.go')?.sourceLiterals).toContain('caféé');
  for(const path of ['javascript.js','typescript.ts'])expect(original.spans.find((span)=>span.ground.path===path)?.sourceLiterals).toContain('cafÃ©');
  expect(original.spans.find((span)=>span.ground.path==='invalid.go')?.literalReadGap).toBe(true);
  const protectedInput=guidePacketPolicy(original,[secret]);
  for(const path of ['hex.go','octal.go','unicode.go','long-unicode.go','mixed.go','raw.go','invalid.go','unicode.ts'])expect(protectedInput.evidence.spans.some((span)=>span.ground.path===path)).toBe(false);
  for(const path of ['javascript.js','typescript.ts'])expect(protectedInput.evidence.spans.some((span)=>span.ground.path===path)).toBe(true);
  expect(protectedInput.evidence.gaps.some((gap)=>gap.includes('source spans'))).toBe(true);
  expect(protectedInput.evidence.spans.every((span)=>span.sourceLiterals===undefined)).toBe(true);
  const prepared={prompt:'',validation:{},publishChecked:async()=>({ok:false,diagnostics:[]})} as unknown as GuidePreparedUnit;
  registerGuidePages(prepared,guideDigest(original),protectedInput.evidence.spans);
  let cursor:string|null=firstGuideCursor(prepared)!;
  while(cursor!==null){const page:GuideContextPage=readGuidePageContext(prepared,cursor)!;for(const entry of page.entries){const span=entry as {ground:{path:string}};expect(['javascript.js','typescript.ts']).toContain(span.ground.path);}cursor=page.next;}
 }finally{await owner.close();rmSync(folder,{recursive:true,force:true});}
},60_000);
