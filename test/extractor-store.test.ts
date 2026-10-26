import {execFileSync} from 'node:child_process';
import {renameSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'bun:test';
import {extractorManifest,prepareExtractorStore} from '../src/knowledge/extractor-store.js';
import {createPGliteDatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore} from '../src/graph/index.js';
import {fillGraph,type TreeExtractor} from '../src/extract/driver/index.js';
const catalog=(names:string[],version=1)=>extractorManifest(names.map((name)=>({name,version})));
test('changed catalog rebuilds real persistent index, same catalog writes no rows, Markdown stays exact',async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-extractor-store-')); const graph=join(root,'state','graph'); const repository=join(root,'repo');mkdirSync(repository);
 const markdown=join(root,'product.md');writeFileSync(markdown,'# Person\n\nUnchanged é.\n');const before=readFileSync(markdown);
 const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repository,env:{...process.env,GIT_AUTHOR_NAME:'Example',GIT_AUTHOR_EMAIL:'example@example.test',GIT_COMMITTER_NAME:'Example',GIT_COMMITTER_EMAIL:'example@example.test'}});
 git('init','-q','-b','main');writeFileSync(join(repository,'main.ts'),'const a=1;');git('add','.');git('commit','-qm','Initial');
 const a:TreeExtractor=()=>({producer:'code.extract.a',nodes:[{key:'code.symbol:a',kind:'code.symbol',label:'a',properties:{}}],edges:[],gaps:[]});
 const b:TreeExtractor=()=>({producer:'code.extract.b',nodes:[{key:'code.symbol:b',kind:'code.symbol',label:'b',properties:{}}],edges:[{type:'code.references',from:'code.symbol:b',to:'code.symbol:a',discriminator:'',properties:{},span:{path:'main.ts',byteStart:0,byteEnd:1,lineStart:1,lineEnd:1}}],gaps:[]});
 const run=async(names:string[],extractors:TreeExtractor[],version=1)=>{
  const prepared=prepareExtractorStore(graph,catalog(names,version));const owner=createPGliteDatabaseOwner({path:prepared.path,btreeGist:true});
  try {await owner.ready;const store=createGraphStore(owner);await store.createSchema();const report=await fillGraph({owner,store,repository,extractors});
   const rows=await owner.run((tx)=>tx.query(`SELECT (SELECT count(*) FROM node_version)::text AS nodes,(SELECT count(*) FROM edge_version)::text AS edges,(SELECT count(*) FROM work_item)::text AS work`));
   const links=await owner.run((tx)=>tx.query(`SELECT properties FROM edge_version WHERE producer='code.extract.links' AND recorded_to='infinity' AND valid_to='infinity'`));
   await owner.close();prepared.commit();return {rebuilt:prepared.rebuilt,rows:rows.rows,links:links.rows,report};
  } finally {await owner.close().catch(()=>undefined);prepared.abort();}
 };
 try {expect((await run(['A'],[a])).rebuilt).toBe(true);
  const oldManifest=readFileSync(join(graph,'extractors.json'));
  let failed=false;
  try {await run(['A','B'],[a,()=>{throw new Error('injected extractor failure');}]);} catch {failed=true;}
  expect(failed).toBe(true);expect(readFileSync(join(graph,'extractors.json'))).toEqual(oldManifest);expect(readFileSync(markdown)).toEqual(before);
  const expanded=await run(['A','B'],[a,b]);expect(expanded.rebuilt).toBe(true);expect(expanded.links).toHaveLength(1);
  const repeat=await run(['A','B'],[a,b]);expect(repeat.rebuilt).toBe(false);expect(repeat.rows).toEqual(expanded.rows);expect(repeat.report.commits[0]?.publications).toBe(0);
  expect((await run(['A','B'],[a,b],2)).rebuilt).toBe(true);expect(readFileSync(markdown)).toEqual(before);
 } finally {rmSync(root,{recursive:true,force:true});}
},60000);
test('legacy and failed promotion recover graph/digest together and never touch Markdown',()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-extractor-crash-'));const graph=join(root,'graph');const markdown=join(root,'page.md');writeFileSync(markdown,'# Kept\né');const before=readFileSync(markdown);
 try {mkdirSync(graph);writeFileSync(join(graph,'payload'),'legacy');expect(prepareExtractorStore(graph,catalog(['A'])).rebuilt).toBe(true);
  for(const step of ['before-rename','between-renames','after-promotion'] as const){
   const prepared=prepareExtractorStore(graph,catalog([step]),(at)=>{if(at===step)throw new Error(`injected ${step}`);});writeFileSync(join(prepared.path,'payload'),step);
   expect(()=>prepared.commit()).toThrow('injected');prepared.abort();
   const recovery=prepareExtractorStore(graph,catalog([step]));
   if(step==='after-promotion'){expect(recovery.rebuilt).toBe(false);expect(readFileSync(join(graph,'payload'),'utf8')).toBe(step);}
   else {expect(recovery.rebuilt).toBe(true);expect(readFileSync(join(graph,'payload'),'utf8')).toBe('legacy');}
   recovery.abort();expect(readFileSync(markdown)).toEqual(before);
  }
  // Simulate a process dying between renames: the next prepare restores the closed prior graph.
  renameSync(graph,`${graph}.previous`);
  const recovered=prepareExtractorStore(graph,catalog(['after-promotion']));expect(recovered.rebuilt).toBe(false);expect(existsSync(graph)).toBe(true);
  expect(()=>prepareExtractorStore(join(root,'..','outside'),catalog(['A']))).toThrow('derived graph');
  const other=join(root,'other');mkdirSync(other);const linked=join(root,'linked');mkdirSync(linked);symlinkSync(other,join(linked,'graph'));
  expect(()=>prepareExtractorStore(join(linked,'graph'),catalog(['A']))).toThrow('symbolic link');expect(existsSync(other)).toBe(true);
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('extractor catalog uses explicit unique names and positive versions, never function spelling alone',()=>{
 expect(()=>extractorManifest([{name:'reader',version:0}])).toThrow('invalid');
 expect(()=>extractorManifest([{name:'reader',version:1},{name:'reader',version:2}])).toThrow('duplicate');
 expect(catalog(['A']).digest).not.toBe(catalog(['A'],2).digest);
 expect(catalog(['A']).digest).not.toBe(catalog(['A','B']).digest);
});


test('callback ownership, metric bindings, target matching and semantic evidence advance the persistent extractor interpretation', async () => {
 const {EXTRACTOR_VERSIONS}=await import('../src/extract/driver/extractors.js');
 expect(EXTRACTOR_VERSIONS.find((entry)=>entry.name==='extractCode')?.version).toBe(13);
 expect(EXTRACTOR_VERSIONS.find((entry)=>entry.name==='extractOperations')?.version).toBe(14);
 expect(EXTRACTOR_VERSIONS.find((entry)=>entry.name==='extractContracts')?.version).toBe(13);
 expect(EXTRACTOR_VERSIONS.find((entry)=>entry.name==='driver-and-link-normalization')?.version).toBe(7);
 expect(EXTRACTOR_VERSIONS.find((entry)=>entry.name==='extractDataModel')?.version).toBe(7);
 for (const name of ['http-model-data','http-model-source-bytes','metric-semantic-model-data','metric-semantic-model-source-bytes','messaging-model-data','messaging-model-source-bytes','environment-model-data','environment-model-source-bytes','shell-command-model-data','shell-command-model-source-bytes','outbox-model-data','outbox-model-source-bytes','grpc-deadline-model-data','grpc-deadline-model-source-bytes']) {
  const asset=EXTRACTOR_VERSIONS.find((entry)=>entry.name===name);
  expect(asset?.version).toBe(1);
  expect(asset!==undefined && 'contentDigest' in asset && typeof asset.contentDigest==='string' && asset.contentDigest.length===64).toBe(true);
  expect(extractorManifest(EXTRACTOR_VERSIONS.filter((entry)=>entry.name!==name)).digest).not.toBe(extractorManifest(EXTRACTOR_VERSIONS).digest);
 }
 const prior=EXTRACTOR_VERSIONS.map((entry)=>entry.name==='extractCode'||entry.name==='driver-and-link-normalization'?{...entry,version:5}:entry.name==='extractOperations'||entry.name==='extractContracts'?{...entry,version:2}:entry);
 const current=extractorManifest(EXTRACTOR_VERSIONS);
 expect(current.digest).not.toBe(extractorManifest(prior).digest);
 console.info('extractor-catalog',JSON.stringify(current));
});


test('interpretation asset digests are retained, validated and independent of catalogue order', () => {
 const a = 'a'.repeat(64); const b = 'b'.repeat(64);
 const before = extractorManifest([{name:'reader',version:1},{name:'queries',version:1,contentDigest:a}]);
 expect(before.extractors.find((entry)=>entry.name==='queries')?.contentDigest).toBe(a);
 expect(before.digest).toBe(extractorManifest([{name:'queries',version:1,contentDigest:a},{name:'reader',version:1}]).digest);
 expect(before.digest).not.toBe(extractorManifest([{name:'reader',version:1},{name:'queries',version:1,contentDigest:b}]).digest);
 for (const invalid of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) expect(()=>extractorManifest([{name:'reader',version:1,contentDigest:invalid}])).toThrow('content digest');
});

test('known query and model byte changes invalidate a derived graph without changing Markdown', async () => {
 const {codeQueryDigest} = await import('../src/extract/code/query.js');
 const {libraryRegistry,libraryRegistryDigest} = await import('../src/extract/library-models/validate.js');
 const root=mkdtempSync(join(tmpdir(),'madarch-parser-assets-'));const graph=join(root,'graph');
 const markdown=join(root,'page.md');writeFileSync(markdown,'# Reader\n\nKept λ.\n');const bytes=readFileSync(markdown);
 const queries=[{path:'one.scm',source:'(identifier) @name\n'}];
 const digest=codeQueryDigest(queries);
 const same=codeQueryDigest([...queries]);
 const changed=codeQueryDigest([{...queries[0]!,source:'(identifier) @binding\n'}]);
 expect(digest).toBe(same);expect(changed).not.toBe(digest);
 const model=structuredClone(libraryRegistry);
 const changedModel={...model,models:model.models.map((entry,index)=>index===0?{...entry,reference:entry.reference+'#known-change'}:entry)};
 expect(libraryRegistryDigest(model)).not.toBe(libraryRegistryDigest(changedModel));
 const manifest=(contentDigest:string)=>extractorManifest([{name:'reader',version:1,contentDigest}]);
 try {
  const first=prepareExtractorStore(graph,manifest(digest));expect(first.rebuilt).toBe(true);first.commit();
  const repeat=prepareExtractorStore(graph,manifest(same));expect(repeat.rebuilt).toBe(false);repeat.abort();
  const next=prepareExtractorStore(graph,manifest(changed));expect(next.rebuilt).toBe(true);next.commit();
  expect(prepareExtractorStore(graph,manifest(changed)).rebuilt).toBe(false);
  expect(readFileSync(markdown)).toEqual(bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});
