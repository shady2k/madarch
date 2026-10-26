/** Real temporal graph overflow never stops unrelated narrative units or questions. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { createGuideWriter, readGuideGraph, resolveGuideContext } from '../src/writer/guides/writer.js';
import { firstGuideCursor, readGuidePageContext, type GuideContextPage } from '../src/writer/guides/prepared.js';
import { memorySink, runWriter, type UnitAgent } from '../src/writer/run.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { gitEnv } from './git-env.js';

test('complete graph pages retain more than 1200 nodes and guide-only byte overflow leaves narrative and questions running',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'guide-graph-bound-'));const owner=createPGliteDatabaseOwner({btreeGist:true});
 try{
  const repository=join(folder,'code');mkdirSync(repository);const output=join(folder,'product');mkdirSync(output);seedStarterSet(output);
  const env=gitEnv({GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repository,env,encoding:'utf8'}).trim();
  git('init','--quiet','--initial-branch=main');writeFileSync(join(repository,'a.ts'),'export const number = 1;\n');git('add','.');git('-c','commit.gpgsign=false','commit','--quiet','-m','Record source');const commit=git('rev-parse','HEAD');
  const store=createGraphStore(owner);await store.createSchema();
  const filled=await fillGraph({owner,store,repository,extractors:[extractFiles,()=>({producer:'code.fixture',nodes:Array.from({length:1201},(_,index)=>({key:`code.symbol:item-${index}`,kind:'code.symbol',label:`Item ${index}`,properties:{index}})),edges:[],gaps:[]})]});
  const valid=filled.commits[0]!.effectiveTime;
  const snapshots=createGitSnapshotSource([{id:'sample',form:'code',root:repository,commit}]);
  const wiring={owner,store,snapshots,scope:filled.repositoryNode,valid,output,agent:{run:async()=>{}}};
  const context=await resolveGuideContext(wiring);const all=await readGuideGraph(wiring,context);
  expect(all.nodes.filter((row)=>row['kind']==='code.symbol')).toHaveLength(1201);
  const prepared=await(await createGuideWriter(wiring)).prepare('administrator-guide','en');
  let cursor:string|null=firstGuideCursor(prepared)!;const factIds:string[]=[];let pages=0;
  while(cursor!==null){const page:GuideContextPage=readGuidePageContext(prepared,cursor)!;for(const entry of page.entries){const item=entry as {type?:string;value?:{id:string}};if(item.type==='fact')factIds.push(item.value!.id);}cursor=page.next;pages++;}
  expect(pages).toBeGreaterThan(1);expect(factIds).toEqual([...all.nodes,...all.edges].map((row)=>{const id=row['id'];if(typeof id!=='string')throw new Error('actual graph row has no string identity');return id;}));
  // Exceed the independent complete-input byte limit in the real graph, not a mocked short result.
  await store.openNode({kind:'code.symbol',label:'Oversized input',properties:{payload:'z'.repeat(8*1024*1024+1)},validFrom:valid,owner:{producer:'code.fixture',scope:filled.repositoryNode}});
  const guides=await createGuideWriter(wiring); // Construction must not eagerly read the oversized guide input.
  await expect(guides.prepare('administrator-guide','en')).rejects.toThrow('complete graph membership exceeds its byte bound');
  const sink=memorySink();const seen:string[]=[];const key='code.file:a.ts';
  const page=(kind:string,id:string,body:string)=>`---\nid: ${id}\nkind: ${kind}\ntitle: Numbers\nrelates: [${key}]\nproducer: agent\nsources: []\n---\n\n${body}\n\n[^1]: [Source](madarch:${key})\n`;
  const agent:UnitAgent={run:async(request)=>{
   seen.push(request.id);
   if(request.id==='product:numbers'){
    const asked=await request.tools.call('ask_question',{type:'ambiguous-term',title:'Meaning of the computed number',question:'What does the computed number mean to a reader?',why:'The code gives a numeric value but does not explain its business meaning.',sides:[{claim:'The source defines a numeric value.',grounds:[key]}]});expect(asked.isError,JSON.stringify(asked)).toBe(false);
    const written=await request.tools.call('write_page',{markdown:page('product','product:numbers','The product computes a number.[^1]\n\n## Domains\n\n- [Numbers](madarch:domain:numbers) describe the computed number.[^1]'),domains:[{slug:'numbers',title:'Numbers',summary:'Numbers describe the values the source computes.',evidence:[key]}]});expect(written.isError,JSON.stringify(written)).toBe(false);
   }else if(request.id==='domain:numbers'){
    const written=await request.tools.call('write_page',{markdown:page('domain','domain:numbers','The source defines a numeric value.[^1]')});expect(written.isError,JSON.stringify(written)).toBe(false);
   }else throw new Error(`guide overflow must not call the agent: ${request.id}`);
  }};
  const report=await runWriter({owner,store,repository,output,productName:'Numbers',agent,guides,sink});
  expect(report.product.status,JSON.stringify(report,null,2)).toBe('written');expect(report.domains.map((unit)=>unit.status)).toEqual(['written']);expect(report.questions).toHaveLength(1);expect(sink.pages.has('docs/product.md')).toBe(true);expect(sink.pages.has('docs/domains/numbers.md')).toBe(true);
  expect(seen).toEqual(['product:numbers','domain:numbers']);expect(report.guides).toHaveLength(2);expect(report.guides.every((unit)=>unit.status==='failed'&&unit.refusals.some((reason)=>reason.rule==='guide-preparation'))).toBe(true);expect(report.ok).toBe(false);
 }finally{await owner.close();rmSync(folder,{recursive:true,force:true});}
},120_000);
