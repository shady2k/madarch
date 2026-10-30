import {mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve, win32} from 'node:path';
import {expect, test} from 'bun:test';
import {containsPath,safeAuditOutput} from '../scripts/extract-truth-safety.js';
import {evidenceError,originEvidence,importReadingEvidence} from '../scripts/extract-truth-evidence.js';
import {extractFiles} from '../src/extract/driver/files.js';
const tree = (text: string) => ({paths: ['README.md'], read: () => new TextEncoder().encode(text)});
test('audit rejects split UTF-8 and wrong lines without rewriting original span', () => {
 const input = tree('é\nx');
 const span = {path: 'README.md', byteStart: 1, byteEnd: 2, lineStart: 1, lineEnd: 1};
 expect(evidenceError(input, span)).toContain('UTF-8'); expect(span.byteStart).toBe(1);
 expect(evidenceError(input, {...span, byteStart: 3, byteEnd: 4})).toContain('disagree');
 expect(evidenceError(input, {...span, byteStart: 3, byteEnd: 4, lineStart: 2, lineEnd: 2})).toBeNull();
});
test('Markdown sections ignore comments and require a real closing fence', () => {
 const input = tree('<!--\n# hidden\n-->\n# visible\n```ts\n```not-a-close\n# fenced\n```\n## visible child\n');
 const sections = extractFiles(input).nodes.filter((node) => node.kind === 'code.document-section');
 expect(sections.map((node) => node.properties.heading)).toEqual(['visible', 'visible child']);
 expect(sections.map((node) => node.span?.lineStart)).toEqual([4, 9]);
});

test('audit import and raw-extractor failures always leave unique run identity and structured failure', async () => {
 const root = mkdtempSync(join(tmpdir(), 'madarch-audit-failure-'));
 try {
  const engine = join(root,'engine'); const repository = join(root,'repository'); const out = join(root,'out');
  mkdirSync(join(engine,'src/extract/driver'),{recursive:true}); mkdirSync(repository,{recursive:true});
  writeFileSync(join(repository,'fixture.ts'),'é\nx');
  writeFileSync(join(engine,'src/extract/driver/git.ts'),`export const walkDefaultBranch = () => [{hash:'fixture-head',effectiveTime:'2025-01-01T00:00:00Z'}]; export const commitTree = () => ({paths:['fixture.ts'],read:() => new TextEncoder().encode('é\\nx')});`);
  const first = {producer:'code.fixture.first',nodes:[{key:'code.symbol:fixture.ts#first',kind:'code.symbol',label:'first',properties:{},span:{path:'fixture.ts',byteStart:0,byteEnd:2,lineStart:1,lineEnd:1}}],edges:[],gaps:[]};
  for (const phase of ['imports','raw-extractor-0','raw-extractor-1','history-extraction']) {
   const module = phase === 'imports' ? 'throw new Error("fixture import failure");'
    : phase === 'raw-extractor-0' ? 'export const TREE_EXTRACTORS = [() => {throw new Error("fixture extractor failure");}]; export const OWNERS = {}; export const HISTORY_EXTRACTOR = () => ({});'
    : phase === 'raw-extractor-1' ? `export const TREE_EXTRACTORS = [() => (${JSON.stringify(first)}), () => {throw new Error("fixture second extractor failure");}]; export const OWNERS = {}; export const HISTORY_EXTRACTOR = () => ({});`
    : `export const TREE_EXTRACTORS = [() => (${JSON.stringify(first)})]; export const OWNERS = {}; export const HISTORY_EXTRACTOR = () => {throw new Error("fixture history failure");};`;
   writeFileSync(join(engine,'src/extract/driver/extractors.ts'),module);
   const child = Bun.spawn([process.execPath, resolve(import.meta.dir,'../scripts/extract-truth-audit.ts'),'--engine',engine,'--repository',repository,'--out',out],{stdout:'pipe',stderr:'pipe'});
   const [exit] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect(exit).not.toBe(0);
  }
  const runs = readdirSync(out); expect(runs).toHaveLength(4);
  const failures = runs.map((run) => JSON.parse(readFileSync(join(out,run,'failure.json'),'utf8')));
  expect(failures.map((failure) => failure.phase).sort()).toEqual(['history-extraction','imports','raw-extractor-0','raw-extractor-1']);
  expect(new Set(failures.map((failure) => failure.runId)).size).toBe(4);
  for (const run of runs) {
   const identity = JSON.parse(readFileSync(join(out,run,'identity.json'),'utf8'));
   expect(identity.runtimeFiles.map((file:{path:string})=>file.path.split('/').at(-1))).toEqual(['extract-truth-audit.ts','extract-truth-evidence.ts','extract-truth-json.ts','extract-truth-safety.ts','order.ts'].sort());expect(identity.runtimeDigest).toHaveLength(64);expect(JSON.parse(readFileSync(join(out,run,'failure.json'),'utf8')).runtimeUnchanged).toBe(true);expect(identity.runtimeFiles.every((file:{sha256:string})=>file.sha256.length===64)).toBe(true);
   expect(identity.engineFiles.length).toBe(2); expect(identity.fixtureFiles[0].sha256).toHaveLength(64);
   expect(readdirSync(join(out,run))).not.toContain('completion.json');
   const failure = JSON.parse(readFileSync(join(out,run,'failure.json'),'utf8'));
   if (['raw-extractor-1','history-extraction'].includes(failure.phase)) {
    const partial = JSON.parse(readFileSync(join(out,run,'raw-extractions-partial.json'),'utf8'));
    expect(partial).toMatchObject({complete: false, file: 'raw-extractions-partial.jsonl'});
    expect(partial.producers.map((entry: {index: number; producer: string}) => [entry.index, entry.producer])).toEqual([[0, first.producer]]);
    const lines = readFileSync(join(out,run,'raw-extractions-partial.jsonl'),'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({complete: false, index: 0, producer: first.producer, extraction: first});
   }
  }
 } finally {rmSync(root,{recursive:true,force:true});}
}, 20_000);


test('audit exact multiline, empty spans, newline conventions and full-file UTF8 validity', () => {
 const input = tree('é\nx\ny');
 const span = {path:'README.md',byteStart:0,byteEnd:4,lineStart:1,lineEnd:2};
 expect(evidenceError(input,span)).toBeNull();
 expect(evidenceError(input,{...span,lineEnd:3})).toContain('disagree');
 expect(evidenceError(input,{...span,byteStart:3,byteEnd:3,lineStart:2,lineEnd:2})).toBeNull();
 expect(evidenceError(input,{...span,byteStart:0,byteEnd:3,lineEnd:1})).toBeNull();
 expect(evidenceError(input,{...span,byteStart:0,byteEnd:3,lineEnd:2})).toBeNull();
 expect(evidenceError(input,{...span,byteStart:5,byteEnd:6,lineStart:3,lineEnd:3})).toBeNull();
 const invalid = {paths:['README.md'],read:() => new Uint8Array([0x78,0xff])};
 expect(evidenceError(invalid,{...span,byteEnd:1,lineEnd:1})).toContain('UTF-8');
});


test('audit validates every origin independently with original bytes/discriminator retained',()=>{
 const input=tree('é\nx');const origins=[{sourceProducer:'code.a',originalDiscriminator:'one',sourceSpan:{path:'README.md',byteStart:0,byteEnd:2,lineStart:1,lineEnd:1},properties:{meaning:'same'}},{sourceProducer:'code.b',originalDiscriminator:'two',sourceSpan:{path:'README.md',byteStart:1,byteEnd:2,lineStart:2,lineEnd:2},properties:{meaning:'same'}}];
 const rows=originEvidence(input,{origins,span:null});expect(rows).toHaveLength(2);expect(rows[0]?.error).toBeNull();expect(rows[1]?.error).toContain('UTF-8');expect(rows[1]?.origin).toEqual(origins[1]);
});


test('audit refuses physical output under inputs before creating output and handles native Windows paths',()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-audit-path-'));
 try {const fixture=join(root,'fixture');mkdirSync(fixture);const alias=join(root,'outside');symlinkSync(fixture,alias);
  expect(()=>safeAuditOutput(join(alias,'audit','new'),[fixture])).toThrow('inside input');expect(existsSync(join(fixture,'audit'))).toBe(false);
  expect(()=>safeAuditOutput(join(fixture,'audit'),[fixture])).toThrow('inside input');expect(safeAuditOutput(join(root,'fixture-other','audit'),[fixture])).toBe(join(root,'fixture-other','audit'));
  expect(containsPath('C:\\fixture','C:\\fixture\\audit',win32)).toBe(true);expect(containsPath('C:\\fixture','C:\\fixture-other\\audit',win32)).toBe(false);expect(containsPath('C:\\fixture','D:\\audit',win32)).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('all exact import readings are validated, including readings nested in original producer properties',()=>{
 const input=tree('é\nx');const first={specifier:'one',span:{path:'README.md',byteStart:0,byteEnd:2,lineStart:1,lineEnd:1}};const bad={specifier:'two',span:{...first.span,byteStart:1}};
 const readings=importReadingEvidence(input,{importReadings:[first,bad],origins:[{properties:{importReadings:[first]}}]});expect(readings).toHaveLength(3);expect(readings[0]?.error).toBeNull();expect(readings[1]?.error).toContain('UTF-8');expect(readings[1]?.reading).toEqual(bad);expect(readings[2]?.source).toBe('origin:0');
});


test('external audit runner records and rechecks its own helper hashes independently of selected engine',async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-audit-runtime-'));
 try {
  const runner=join(root,'runner');const engine=join(root,'engine');const repository=join(root,'repository');const output=join(root,'out');mkdirSync(join(runner,'scripts'),{recursive:true});mkdirSync(join(runner,'src/model'),{recursive:true});mkdirSync(join(engine,'src/extract/driver'),{recursive:true});mkdirSync(repository);
  for(const relative of ['scripts/extract-truth-audit.ts','scripts/extract-truth-evidence.ts','scripts/extract-truth-json.ts','scripts/extract-truth-safety.ts','src/model/order.ts'])cpSync(resolve(import.meta.dir,'..',relative),join(runner,relative));
  const helper=join(runner,'scripts/extract-truth-evidence.ts');const original=readFileSync(helper,'utf8');writeFileSync(join(repository,'source.ts'),'exact');
  writeFileSync(join(engine,'src/extract/driver/git.ts'),`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(helper)},'\\n// injected runtime mutation\\n');throw new Error('fixture changes only external executing helper');`);
  const child=Bun.spawn([process.execPath,join(runner,'scripts/extract-truth-audit.ts'),'--engine',engine,'--repository',repository,'--out',output],{stdout:'pipe',stderr:'pipe'});const [exit]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit).not.toBe(0);
  const run=join(output,readdirSync(output)[0]!);const identity=JSON.parse(readFileSync(join(run,'identity.json'),'utf8'));expect(identity.runtimeFiles).toHaveLength(5);expect(identity.runtimeFiles.every((file:{path:string})=>file.path.startsWith(runner))).toBe(true);expect(identity.engineFiles.every((file:{path:string})=>!file.path.includes('evidence'))).toBe(true);expect(readFileSync(helper,'utf8')).not.toBe(original);const recorded=identity.runtimeFiles.find((file:{path:string})=>file.path===helper);expect(recorded.sha256).toBe(createHash('sha256').update(original).digest('hex'));expect(recorded.sha256).not.toBe(createHash('sha256').update(readFileSync(helper)).digest('hex'));expect(JSON.parse(readFileSync(join(run,'failure.json'),'utf8')).runtimeUnchanged).toBe(false);expect(existsSync(join(run,'completion.json'))).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
},20000);

test('historical renamed file shows only explicit readable same-scope successor, never old HEAD bytes',async()=>{
 const {sourceBlock}=await import('../src/knowledge/blocks.js');type Context=import('../src/knowledge/blocks.js').RenderContext;
 const span={path:'old.ts',byteStart:0,byteEnd:0,lineStart:1,lineEnd:1};const old={key:'code.file:old.ts',kind:'code.file',label:'old.ts',properties:{},nodeIds:['1'],scope:'scope-a',span};const next={...old,key:'code.file:new.ts',label:'new.ts',span:{...span,path:'new.ts'}};let rows=[{other:next}];const reads:string[]=[];
 const ctx={language:'en',manifest:{kinds:new Map([['code.file',{}]])},repoOfScope:()=> 'fixture',readSource:async(_repo:string|null,path:string)=>{reads.push(path);return path==='new.ts'?'actual successor bytes':undefined;},graph:{edgesOf:async(entity:unknown,relation:string,direction:string)=>{expect(entity).toBe(old);expect(relation).toBe('code.renamed-to');expect(direction).toBe('out');return{total:rows.length,rows};}}} as unknown as Context;
 const result=await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3);expect(result.type).toBe('refs');if(result.type==='refs'){expect(result.total).toBe(1);expect(result.rows[0]?.entity.id).toBe(next.key);expect(result.rows[0]?.entity.location?.path).toBe('new.ts');expect(result.title).toContain('original path is absent');}expect(reads).toEqual(['old.ts','new.ts']);expect(JSON.stringify(result)).not.toContain('actual successor bytes');
 rows=[{other:{...next,scope:'scope-b'}}];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');rows=[];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');rows=[{other:{...next,span:{...span,path:'missing.ts'}}}];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');
});

test('audit unwraps the code extractor\'s {extraction, facts} result before it audits raw rows', async () => {
 const root = mkdtempSync(join(tmpdir(), 'madarch-audit-wrapper-'));
 try {
  const engine = join(root,'engine'); const repository = join(root,'repository'); const out = join(root,'out');
  mkdirSync(join(engine,'src/extract/driver'),{recursive:true}); mkdirSync(repository,{recursive:true});
  writeFileSync(join(repository,'fixture.ts'),'é\nx');
  writeFileSync(join(engine,'src/extract/driver/git.ts'),`export const walkDefaultBranch = () => [{hash:'fixture-head',effectiveTime:'2025-01-01T00:00:00Z'}]; export const commitTree = () => ({paths:['fixture.ts'],read:() => new TextEncoder().encode('é\\nx')});`);
  const first = {producer:'code.fixture.first',nodes:[{key:'code.symbol:fixture.ts#first',kind:'code.symbol',label:'first',properties:{},span:{path:'fixture.ts',byteStart:0,byteEnd:2,lineStart:1,lineEnd:1}}],edges:[],gaps:[]};
  // The code extractor returns `{extraction, facts}` (src/extract/code/facts.ts); every other
  // extractor returns the extraction. The audit must read the same two shapes as the driver.
  // The history extractor keeps its own, empty extraction: this case reads the tree pass's rows.
  const history = {producer:'code.fixture.history',nodes:[],edges:[],gaps:[]};
  writeFileSync(join(engine,'src/extract/driver/extractors.ts'),`export const TREE_EXTRACTORS = [() => ({extraction: ${JSON.stringify(first)}, facts: {}})]; export const OWNERS = {}; export const HISTORY_EXTRACTOR = () => (${JSON.stringify(history)});`);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir,'../scripts/extract-truth-audit.ts'),'--engine',engine,'--repository',repository,'--out',out],{stdout:'pipe',stderr:'pipe'});
  await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  const runs = readdirSync(out); expect(runs).toHaveLength(1);
  const run = join(out,runs[0]!);
  // The fixture engine holds no database module, so the run stops when it imports the store —
  // after the raw rows were audited, which is what this case reads. The phase stays
  // 'history-extraction' until 'store-start' is set, so the raw row files are the evidence.
  const failure = JSON.parse(readFileSync(join(run,'failure.json'),'utf8'));
  expect(failure.phase).toBe('history-extraction');
  expect(failure.error.message).toContain('database-owner.ts');
  expect(JSON.parse(readFileSync(join(run,'raw-nodes.json'),'utf8')).map((node:{key:string}) => node.key)).toEqual(['code.symbol:fixture.ts#first']);
  expect(JSON.parse(readFileSync(join(run,'raw-summary.json'),'utf8')).nodes).toBe(1);
  // The streamed writer must produce exactly what the built-in serializer would,
  // byte for byte, so existing audit consumers keep reading the same file.
  const rawExtractions = readFileSync(join(run,'raw-extractions.json'),'utf8');
  expect(rawExtractions).toBe(JSON.stringify(JSON.parse(rawExtractions), null, 2)+'\n');
 } finally {rmSync(root,{recursive:true,force:true});}
}, 20_000);

test('audit hands the code pass resolved facts to every later extractor, as the fill driver does', async () => {
 const root = mkdtempSync(join(tmpdir(), 'madarch-audit-facts-'));
 try {
  const engine = join(root,'engine'); const repository = join(root,'repository'); const out = join(root,'out');
  mkdirSync(join(engine,'src/extract/driver'),{recursive:true}); mkdirSync(repository,{recursive:true});
  writeFileSync(join(repository,'fixture.ts'),'const value = 1;');
  writeFileSync(join(engine,'src/extract/driver/git.ts'),`export const walkDefaultBranch = () => [{hash:'fixture-head',effectiveTime:'2025-01-01T00:00:00Z'}]; export const commitTree = () => ({paths:['fixture.ts'],read: () => new TextEncoder().encode('const value = 1;')});`);
  const first = {producer:'code.extract.code',nodes:[],edges:[],gaps:[]};
  const second = {producer:'code.fixture.second',nodes:[],edges:[],gaps:[]};
  writeFileSync(join(engine,'src/extract/driver/extractors.ts'),`export const TREE_EXTRACTORS = [
   () => ({extraction: ${JSON.stringify(first)}, facts: {marker: 'shared'}}),
   (_tree, code, facts) => { if (code === undefined || facts?.marker !== 'shared') throw new Error('the code pass facts were not passed to the later extractor'); return ${JSON.stringify(second)}; },
  ]; export const OWNERS = {}; export const HISTORY_EXTRACTOR = () => {throw new Error('stop after raw extraction');};`);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir,'../scripts/extract-truth-audit.ts'),'--engine',engine,'--repository',repository,'--out',out],{stdout:'pipe',stderr:'pipe'});
  const [exit] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(exit).not.toBe(0);
  const run = join(out, readdirSync(out)[0]!);
  const failure = JSON.parse(readFileSync(join(run,'failure.json'),'utf8'));
  expect(failure.phase).toBe('history-extraction');
  const lines = readFileSync(join(run,'raw-extractions-partial.jsonl'),'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines.map((line:{producer:string}) => line.producer)).toEqual(['code.extract.code','code.fixture.second']);
 } finally {rmSync(root,{recursive:true,force:true});}
}, 20_000);

