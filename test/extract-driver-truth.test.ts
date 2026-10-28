import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {createPGliteDatabaseOwner, type DatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore, type GraphStore} from '../src/graph/index.js';
import {fillGraph} from '../src/extract/driver/index.js';
import {extractCode} from '../src/extract/code/index.js';
import {extractFiles} from '../src/extract/driver/files.js';
import {extractOperations} from '../src/extract/operations/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';
let owner: DatabaseOwner;
let store: GraphStore;
let workspace: string;
beforeAll(async () => {workspace = mkdtempSync(path.join(tmpdir(), 'madarch-graph-truth-')); owner = createPGliteDatabaseOwner({btreeGist: true}); store = createGraphStore(owner); await owner.ready; await store.createSchema();}, 60_000);
afterAll(async () => {await owner?.close(); if (workspace !== undefined) rmSync(workspace, {recursive: true, force: true});}, 60_000);
const query = async <T extends object>(sql: string, values?: readonly unknown[]): Promise<T[]> => (await owner.run((tx) => tx.query<T>(sql, values))).rows;
const extraction = (producer: `code.${string}`, own: string, foreign: string, tree: TreeReader): Extraction => ({producer,
 nodes: [{key: own, kind: 'code.symbol', label: own, properties: {}, span: {path: tree.paths[0]!, byteStart: 0, byteEnd: 1, lineStart: 1, lineEnd: 1}}],
 edges: new TextDecoder().decode(tree.read(tree.paths[0]!)).includes('links') ? [{type: 'code.references', from: own, to: foreign, discriminator: '', properties: {}, span: {path: tree.paths[0]!, byteStart: 0, byteEnd: 1, lineStart: 1, lineEnd: 1}}] : [], gaps: []});
const a = (tree: TreeReader) => extraction('code.extract.a', `code.symbol:${tree.paths[0]}#a`, `code.symbol:${tree.paths[0]}#b`, tree);
const b = (tree: TreeReader) => extraction('code.extract.b', `code.symbol:${tree.paths[0]}#b`, `code.symbol:${tree.paths[0]}#a`, tree);
function git(repository: string, ...args: string[]): string {return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {cwd: repository, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'Example Author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_NAME: 'Example Author', GIT_COMMITTER_EMAIL: 'author@example.test'}}).trim();}
function commit(repository: string, message: string, date: string): string {git(repository, 'add', '.'); execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], {cwd: repository, env: {...process.env, GIT_AUTHOR_NAME: 'Example Author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_NAME: 'Example Author', GIT_COMMITTER_EMAIL: 'author@example.test', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date}}); return git(repository, 'rev-parse', 'HEAD');}
test('cyclic-owning-producers: actual endpoints, bounded snapshot, rename identity, removed links and unchanged refill', async () => {
 const repository = path.join(workspace, 'repo'); git(workspace, 'init', '-q', '-b', 'main', repository);
 writeFileSync(path.join(repository, 'old.ts'), 'links one'); const first = commit(repository, 'One', '2025-01-01T00:00:00Z');
 writeFileSync(path.join(repository, 'old.ts'), 'links two'); commit(repository, 'Two', '2025-01-02T00:00:00Z');
 const options = {owner, store, repository, extractors: [a, b], owners: {'code.symbol': 'code.extract.a'}};
 await fillGraph({...options, points: [first]});
 const nodes = await query<{key: string | null; id: string; kind: string}>(`SELECT v.properties->>'recordKey' AS key, v.node_id::text AS id, k.key AS kind FROM node_version v JOIN node_kind k ON k.id=v.kind_id WHERE v.scope_id IN (SELECT node_id FROM node_version WHERE properties->>'path' = $1) AND v.recorded_to = 'infinity'`, [repository]);
 const scopeRows = nodes.filter((row) => row.kind === 'code.repository');
 const symbolRows = nodes.filter((row) => row.kind === 'code.symbol');
 expect(scopeRows).toHaveLength(1); expect(scopeRows[0]?.key).toBeNull();
 expect(new Set(symbolRows.map((row) => row.id)).size).toBe(2);
 expect(new Set(nodes.map((row) => row.id)).size).toBe(3);
 expect(nodes.every((row) => row.kind === 'code.repository' || (row.kind === 'code.symbol' && row.key?.startsWith('code.symbol:old.ts#')))).toBe(true);
 const edges = await query<{producer: string; until: string}>(`SELECT producer, valid_to::text AS until FROM edge_version WHERE recorded_to = 'infinity'`);
 expect(edges.filter((row) => row.until !== 'infinity')).toHaveLength(2);
 expect(edges.every((row) => row.producer === 'code.extract.links')).toBe(true);
 const before = await query<{n: string}>(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`);
 expect((await fillGraph({...options, points: [first]})).commits[0]?.publications).toBe(0);
 expect(await query(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`)).toEqual(before);
 git(repository, 'mv', 'old.ts', 'new.ts'); commit(repository, 'Rename', '2025-01-03T00:00:00Z'); await fillGraph(options);
 const renamed = await query<{id: string}>(`SELECT node_id::text AS id FROM node_version WHERE properties->>'recordKey' LIKE 'code.symbol:new.ts#%' AND recorded_to = 'infinity' AND valid_to = 'infinity'`);
 expect(renamed.map((row) => row.id).sort()).toEqual([...new Set(symbolRows.map((row) => row.id))].sort());
 writeFileSync(path.join(repository, 'new.ts'), 'without relationships'); commit(repository, 'Remove links', '2025-01-04T00:00:00Z'); await fillGraph(options);
 expect(await query(`SELECT edge_id FROM edge_version WHERE recorded_to = 'infinity' AND valid_to = 'infinity'`)).toEqual([]);
}, 60_000);


// The rejected incremental expansion fixture and its diagnostic are retained in the task's evidence.
// Changed extractor catalogs now rebuild at the persistent fill boundary (0029).

test('real inline callback rename preserves identity and unchanged refill writes nothing', async () => {
 const repository = path.join(workspace,'callbacks'); git(workspace,'init','-q','-b','main',repository);
 writeFileSync(path.join(repository,'old.ts'),'// карта\nimport express from "express"; function helper() {return 1;} export function start() {const app=express(); app.get("/",()=>helper()); helper();}');
 commit(repository,'Callback','2025-03-01T00:00:00Z');
 const options = {owner,store,repository,extractors:[extractCode,extractContracts],owners:{'code.symbol':'code.extract.code','code.file':'code.extract.code'}};
 const first = await fillGraph(options);
 const callback = await query<{id:string;key:string}>(`SELECT node_id::text AS id, properties->>'recordKey' AS key FROM node_version WHERE scope_id=$1::bigint AND properties->>'inline'='true' AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode]);
 expect(callback).toHaveLength(1);
 git(repository,'mv','old.ts','new.ts'); commit(repository,'Rename callback file','2025-03-02T00:00:00Z'); await fillGraph(options);
 const moved = await query<{id:string;key:string}>(`SELECT node_id::text AS id, properties->>'recordKey' AS key FROM node_version WHERE scope_id=$1::bigint AND properties->>'inline'='true' AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode]);
 expect(moved).toHaveLength(1); expect(moved[0]?.id).toBe(callback[0]?.id); expect(moved[0]?.key).toContain('code.symbol:new.ts#');
 const before = await query(`SELECT (SELECT count(*) FROM node_version) AS nodes, (SELECT count(*) FROM edge_version) AS edges, (SELECT count(*) FROM work_item) AS work`);
 expect((await fillGraph(options)).commits.every((entry) => entry.publications === 0)).toBe(true);
 expect(await query(`SELECT (SELECT count(*) FROM node_version) AS nodes, (SELECT count(*) FROM edge_version) AS edges, (SELECT count(*) FROM work_item) AS work`)).toEqual(before);
},60_000);


test('fresh store publishes shared semantic and positioned origins once, preserving exact evidence',async()=>{
 const repository=path.join(workspace,'origins');git(workspace,'init','-q','-b','main',repository);
 writeFileSync(path.join(repository,'main.ts'),'first\nsecond');commit(repository,'Origins','2025-04-01T00:00:00Z');
 const spanA={path:'main.ts',byteStart:0,byteEnd:5,lineStart:1,lineEnd:1};const spanB={path:'main.ts',byteStart:6,byteEnd:12,lineStart:2,lineEnd:2};
 const first:Extraction={producer:'code.extract.origina',nodes:[{key:'code.symbol:main.ts#a',kind:'code.symbol',label:'a',properties:{}},{key:'code.symbol:main.ts#b',kind:'code.symbol',label:'b',properties:{}}],edges:[{type:'code.references',from:'code.symbol:main.ts#a',to:'code.symbol:main.ts#b',discriminator:'',properties:{meaning:'same'},span:spanA},{type:'code.occurrence',from:'code.symbol:main.ts#a',to:'code.symbol:main.ts#b',discriminator:'origin-a',properties:{use:'call'},span:spanA}],gaps:[]};
 const second:Extraction={producer:'code.extract.originb',nodes:[],edges:[{...first.edges[0]!,span:spanB},{...first.edges[1]!,discriminator:'origin-b'}],gaps:[]};
 const report=await fillGraph({owner,store,repository,extractors:[()=>first,()=>second]});
 const rows=await query<{type:string;properties:{origins:{sourceProducer:string;sourceSpan:typeof spanA;originalDiscriminator:string}[]};start:string|null}>(`SELECT r.key AS type,e.properties,e.byte_start::text AS start FROM edge_version e JOIN relation_type r ON r.id=e.relation_type_id WHERE e.scope_id=$1::bigint AND e.recorded_to='infinity' AND e.valid_to='infinity' ORDER BY r.key`,[report.repositoryNode]);
 expect(rows).toHaveLength(2);for(const row of rows){expect(row.properties.origins.map((origin)=>origin.sourceProducer)).toEqual(['code.extract.origina','code.extract.originb']);}
 expect(rows.find((row)=>row.type==='code.references')?.properties.origins.map((origin)=>origin.sourceSpan.lineStart)).toEqual([1,2]);
 expect(rows.find((row)=>row.type==='code.occurrence')?.start).toBe('0');
 expect(rows.find((row)=>row.type==='code.occurrence')?.properties.origins.map((origin)=>origin.originalDiscriminator)).toEqual(['origin-a','origin-b']);
},60000);


test('same catalog duplicate origin appears and disappears across tips without changing relation owner',async()=>{
 const repository=path.join(workspace,'origin-tips');git(workspace,'init','-q','-b','main',repository);
 writeFileSync(path.join(repository,'main.ts'),'one');commit(repository,'One','2025-05-01T00:00:00Z');
 const shared=(producer:'code.a'|'code.b',tree:TreeReader):Extraction=>({producer,nodes:producer==='code.a'?[{key:'code.symbol:x',kind:'code.symbol',label:'x',properties:{}},{key:'code.symbol:y',kind:'code.symbol',label:'y',properties:{}}]:[],edges:producer==='code.a'||new TextDecoder().decode(tree.read('main.ts')).includes('two')?[{type:'code.references',from:'code.symbol:x',to:'code.symbol:y',discriminator:'',properties:{},span:{path:'main.ts',byteStart:0,byteEnd:3,lineStart:1,lineEnd:1}}]:[],gaps:[]});
 const a=(tree:TreeReader)=>shared('code.a',tree);const b=(tree:TreeReader)=>shared('code.b',tree);const options={owner,store,repository,extractors:[a,b]};
 const first=await fillGraph(options);
 writeFileSync(path.join(repository,'main.ts'),'two');commit(repository,'Two','2025-05-02T00:00:00Z');await fillGraph(options);
 const rows=await query<{producer:string;properties:{origins:{sourceProducer:string}[]}}>(`SELECT producer,properties FROM edge_version WHERE scope_id=$1::bigint AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode]);
 expect(rows).toHaveLength(1);expect(rows[0]?.producer).toBe('code.a');expect(rows[0]?.properties.origins.map((origin)=>origin.sourceProducer)).toEqual(['code.a','code.b']);
 writeFileSync(path.join(repository,'main.ts'),'three');commit(repository,'Three','2025-05-03T00:00:00Z');await fillGraph(options);
 expect((await query<{producer:string}>(`SELECT producer FROM edge_version WHERE scope_id=$1::bigint AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode])).map((row)=>row.producer)).toEqual(['code.a']);
 const before=await query(`SELECT (SELECT count(*) FROM node_version) AS nodes,(SELECT count(*) FROM edge_version) AS edges,(SELECT count(*) FROM work_item) AS work`);
 expect((await fillGraph(options)).commits[0]?.publications).toBe(0);expect(await query(`SELECT (SELECT count(*) FROM node_version) AS nodes,(SELECT count(*) FROM edge_version) AS edges,(SELECT count(*) FROM work_item) AS work`)).toEqual(before);
},60000);


test('cross-owner semantic and positioned relations retain stable aggregate owner as duplicate source changes',async()=>{
 const repository=path.join(workspace,'cross-origin-tips');git(workspace,'init','-q','-b','main',repository);
 writeFileSync(path.join(repository,'main.ts'),'one');commit(repository,'One','2025-06-01T00:00:00Z');
 const span={path:'main.ts',byteStart:0,byteEnd:3,lineStart:1,lineEnd:1};
 const a=(tree:TreeReader):Extraction=>({producer:'code.cross.a',nodes:[{key:'code.symbol:x',kind:'code.symbol',label:'x',properties:{}}],edges:[{type:'code.references',from:'code.symbol:x',to:'code.symbol:y',discriminator:'',properties:{},span},{type:'code.occurrence',from:'code.symbol:x',to:'code.symbol:y',discriminator:'original-a',properties:{},span}],gaps:[]});
 const b=(tree:TreeReader):Extraction=>({producer:'code.cross.b',nodes:[{key:'code.symbol:y',kind:'code.symbol',label:'y',properties:{}}],edges:new TextDecoder().decode(tree.read('main.ts'))==='two'?[{type:'code.references',from:'code.symbol:x',to:'code.symbol:y',discriminator:'',properties:{},span},{type:'code.occurrence',from:'code.symbol:x',to:'code.symbol:y',discriminator:'original-b',properties:{},span}]:[],gaps:[]});
 const options={owner,store,repository,extractors:[a,b]};const first=await fillGraph(options);
 for(const [index,text] of ['two','three'].entries()){writeFileSync(path.join(repository,'main.ts'),text);commit(repository,text,`2025-06-0${index+2}T00:00:00Z`);await fillGraph(options);
  const rows=await query<{producer:string;properties:{origins:unknown[]}}>(`SELECT producer,properties FROM edge_version WHERE scope_id=$1::bigint AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode]);expect(rows).toHaveLength(2);expect(rows.every((row)=>row.producer==='code.extract.links')).toBe(true);expect(rows.every((row)=>row.properties.origins.length===(text==='two'?2:1))).toBe(true);
 }
 expect((await fillGraph(options)).commits[0]?.publications).toBe(0);
},60000);


test('single owned positioned occurrence retains original discriminator and full span across duplicate origin tips',async()=>{
 const repository=path.join(workspace,'owned-occurrence');git(workspace,'init','-q','-b','main',repository);writeFileSync(path.join(repository,'main.ts'),'one');commit(repository,'One','2025-07-01T00:00:00Z');
 const span={path:'main.ts',byteStart:0,byteEnd:3,lineStart:1,lineEnd:1};
 const a=(tree:TreeReader):Extraction=>({producer:'code.owned.a',nodes:[{key:'code.symbol:x',kind:'code.symbol',label:'x',properties:{}},{key:'code.symbol:y',kind:'code.symbol',label:'y',properties:{}}],edges:[{type:'code.occurrence',from:'code.symbol:x',to:'code.symbol:y',discriminator:'original-a',properties:{use:'call'},span}],gaps:[]});
 const b=(tree:TreeReader):Extraction=>({producer:'code.owned.b',nodes:[],edges:new TextDecoder().decode(tree.read('main.ts'))==='two'?[{type:'code.occurrence',from:'code.symbol:x',to:'code.symbol:y',discriminator:'original-b',properties:{use:'call'},span}]:[],gaps:[]});
 const options={owner,store,repository,extractors:[a,b]};let scope='';
 for(const [index,text] of ['one','two','three'].entries()){
  if(index>0){writeFileSync(path.join(repository,'main.ts'),text);commit(repository,text,`2025-07-0${index+1}T00:00:00Z`);}
  scope=(await fillGraph(options)).repositoryNode;
  const rows=await query<{producer:string;properties:{origins:{sourceProducer:string;originalDiscriminator:string;sourceSpan:typeof span;properties:{use:string}}[]}}>(`SELECT producer,properties FROM edge_version WHERE scope_id=$1::bigint AND recorded_to='infinity' AND valid_to='infinity'`,[scope]);expect(rows).toHaveLength(1);expect(rows[0]?.producer).toBe('code.owned.a');expect(rows[0]?.properties.origins[0]).toEqual({sourceProducer:'code.owned.a',originalDiscriminator:'original-a',sourceSpan:span,properties:{use:'call'}});expect(rows[0]?.properties.origins).toHaveLength(text==='two'?2:1);
 }
 expect((await fillGraph(options)).commits[0]?.publications).toBe(0);
},60000);


test('real external import sites aggregate endpoint identity with exact readings and unchanged refill',async()=>{
 const repository=path.join(workspace,'imports');git(workspace,'init','-q','-b','main',repository);
 const source=`import renamed, {join as alias} from 'some-package/one';\nimport {two} from 'some-package/two';\nimport {three} from 'some-package/one';\nimport {randomUUID} from 'node:crypto';\nexport const value = alias(renamed, two, three, randomUUID());\n`;
 writeFileSync(path.join(repository,'main.ts'),source);writeFileSync(path.join(repository,'package.json'),JSON.stringify({name:'example',dependencies:{'some-package':'1.0.0'}}));writeFileSync(path.join(repository,'go.mod'),'module example.test/demo\ngo 1.23\n');writeFileSync(path.join(repository,'main.go'),'package main\nimport alias "fmt"\nfunc main(){alias.Println("ok")}\n');commit(repository,'Imports','2025-08-01T00:00:00Z');
 const options={owner,store,repository,extractors:[extractFiles,extractCode,extractOperations],owners:{'code.file':'code.extract.files','code.dependency':'code.extract.operations'}};const report=await fillGraph(options);
 const rows=await query<{properties:{count:number;specifier:string;specifiers:string[];importReadings:{specifier:string;span:{path:string;byteStart:number;byteEnd:number}}[]}}>(`SELECT e.properties FROM edge_version e JOIN relation_type r ON r.id=e.relation_type_id WHERE e.scope_id=$1::bigint AND r.key='code.imports' AND e.recorded_to='infinity' AND e.valid_to='infinity'`,[report.repositoryNode]);
 const dependency=rows.find((row)=>row.properties.specifiers.includes('some-package/one'))!;expect(dependency.properties.count).toBe(3);expect(dependency.properties.specifiers).toEqual(['some-package/one','some-package/two']);expect(dependency.properties.importReadings.map((reading)=>reading.specifier)).toEqual(['some-package/one','some-package/two','some-package/one']);
 for(const reading of dependency.properties.importReadings)expect(new TextDecoder().decode(new TextEncoder().encode(source).subarray(reading.span.byteStart,reading.span.byteEnd))).toBe(`'${reading.specifier}'`);
 expect(rows.find((row)=>row.properties.specifier==='node:crypto')?.properties.count).toBe(1);expect(rows.find((row)=>row.properties.specifier==='fmt')?.properties.count).toBe(1);
 const before=await query(`SELECT (SELECT count(*) FROM edge_version) AS edges,(SELECT count(*) FROM work_item) AS work`);expect((await fillGraph(options)).commits[0]?.publications).toBe(0);expect(await query(`SELECT (SELECT count(*) FROM edge_version) AS edges,(SELECT count(*) FROM work_item) AS work`)).toEqual(before);
},60000);


test('never-used empty aggregate opens no work item, but removing its last real relation still sweeps',async()=>{
 const repository=path.join(workspace,'empty-aggregate');git(workspace,'init','-q','-b','main',repository);writeFileSync(path.join(repository,'main.ts'),'none');commit(repository,'None','2025-09-01T00:00:00Z');
 const a=(tree:TreeReader):Extraction=>({producer:'code.empty.a',nodes:[{key:'code.symbol:x',kind:'code.symbol',label:'x',properties:{}}],edges:new TextDecoder().decode(tree.read('main.ts'))==='links'?[{type:'code.references',from:'code.symbol:x',to:'code.symbol:y',discriminator:'',properties:{},span:{path:'main.ts',byteStart:0,byteEnd:5,lineStart:1,lineEnd:1}}]:[],gaps:[]});
 const b=():Extraction=>({producer:'code.empty.b',nodes:[{key:'code.symbol:y',kind:'code.symbol',label:'y',properties:{}}],edges:[],gaps:[]});const options={owner,store,repository,extractors:[a,b]};const first=await fillGraph(options);expect(first.commits[0]?.publications).toBe(2);
 const works=()=>query<{generation:string}>(`SELECT generation::text FROM work_item WHERE scope_id=$1::bigint AND producer='code.extract.links' AND published_at IS NOT NULL ORDER BY generation`,[first.repositoryNode]);expect(await works()).toEqual([]);
 writeFileSync(path.join(repository,'main.ts'),'links');commit(repository,'Links','2025-09-02T00:00:00Z');await fillGraph(options);expect(await works()).toHaveLength(1);
 writeFileSync(path.join(repository,'main.ts'),'none');commit(repository,'None again','2025-09-03T00:00:00Z');await fillGraph(options);expect(await works()).toHaveLength(2);expect(await query(`SELECT edge_id FROM edge_version WHERE scope_id=$1::bigint AND producer='code.extract.links' AND recorded_to='infinity' AND valid_to='infinity'`,[first.repositoryNode])).toEqual([]);expect((await fillGraph(options)).commits[0]?.publications).toBe(0);expect(await works()).toHaveLength(2);
},60000);
