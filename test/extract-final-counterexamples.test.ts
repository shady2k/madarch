import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
// Test-only CodeFacts fixture owns one shared code pass for each immutable tree.
import {extractCode} from './extract-code-facts-fixture.js';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import {extractOperations} from './extract-code-facts-fixture.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {linkExtractions} from '../src/extract/driver/links.js';
import {edgeEvidenceError} from '../scripts/extract-truth-evidence.js';
import type {Extraction,SourceSpan,TreeReader} from '../src/extract/records.js';
const path='services/api/main.ts';
const tree=(source:string,extra:Record<string,string>={}):TreeReader=>{const files:Record<string,string>={[path]:source,...extra};return {paths:Object.keys(files).sort(),read:(p)=>{if(files[p]===undefined)throw new Error(`missing fixture ${p}`);return new TextEncoder().encode(files[p]);}};};
const sym=(name:string)=>`code.symbol:${path}#${name}`;
const slice=(t:TreeReader,s:SourceSpan|undefined)=>s===undefined?undefined:new TextDecoder().decode(t.read(s.path).subarray(s.byteStart,s.byteEnd));
const normalized=(...ex:Extraction[])=>linkExtractions(ex,{}).extractions.flatMap((e)=>e.edges);
const api='openapi: 3.0.0\ninfo: {title: API, version: 1.0.0}\nservers: [{url: "https://outside.example"}]\npaths:\n /healthz:\n  get: {operationId: health}\n';
const route='import express from "express";\nfunction health(req:any,res:any){res.send("ok");}\nexport function setup(){const app=express();app.get("/healthz",health);';
test('review 1: anonymous SQL access belongs exactly to canonical callback',async()=>{
 const source='export function setup(db: {query(sql: string): unknown}) {\n setTimeout(() => db.query("SELECT id FROM entries"), 0);\n}\n';const t=tree(source,{'services/api/migrations/001.sql':'CREATE TABLE entries (id integer PRIMARY KEY);'});const code=await extractCode(t);const dataReader: (tree: TreeReader, code?: Extraction) => Promise<Extraction> = extractDataModel; const ex=await dataReader(t,code);
 const cb=sym(`setup.callback@2:${source.indexOf('() =>')}`);const target='code.table:api/public.entries';
 expect(code.nodes.find((n)=>n.key===cb)).toBeDefined();
 for(const edges of [ex.edges,normalized(code,ex)]) {expect(edges.filter((e)=>e.type==='code.reads-table'&&e.to===target).map((e)=>e.from)).toEqual([cb]);expect(edges.some((e)=>e.type==='code.reads-table'&&e.from===sym('setup'))).toBe(false);}
 expect(slice(t,ex.edges.find((e)=>e.from===cb&&e.type==='code.reads-table')?.span)).toContain('SELECT id FROM entries');
});
test('review 2: promoted named function locals never become outer-function reads',async()=>{
 const source='export function outer() { function inner() { const value = 1; return value; } return inner(); }';const ex=await extractCode(tree(source));
 expect(ex.nodes.find((n)=>n.key===sym('outer.inner'))).toBeDefined();expect(ex.edges.filter((e)=>e.from===sym('outer.inner')&&e.to===sym('outer')&&['code.occurrence','code.references','code.reads'].includes(e.type))).toEqual([]);
 expect(ex.edges.find((e)=>e.type==='code.calls'&&e.from===sym('outer')&&e.to===sym('outer.inner'))).toBeDefined();
});
test('review 3: destructured pino parameter is not imported logger factory',async()=>{
 const t=tree('import pino from "pino";\nconst actual=pino();\nexport function unrelated({pino}: {pino: () => number}) { const fake=pino(); return fake; }');const ex=await extractOperations(t);
 expect(ex.nodes.filter((n)=>n.kind==='code.logger').map((n)=>n.key)).toEqual([`code.logger:${path}#actual`]);
});
test('review 4: callback does not bypass enclosing logger parameter shadow',async()=>{
 const t=tree('import pino from "pino";\nconst logger=pino();\nexport function setup(logger: {info(s: string): void}) { setTimeout(() => logger.info("other"), 0); }\nexport function positive(){logger.info("real");}');const code=await extractCode(t);const ex=await extractOperations(t,code);
 const uses=ex.edges.filter((e)=>e.type==='code.uses-logger');expect(uses).toHaveLength(2);expect(uses.filter((e)=>e.to.startsWith('code.symbol:')).map((e)=>e.to)).toEqual([sym('positive')]);expect(uses.every((e)=>slice(t,e.span)==='logger.info(')).toBe(true);
});
test('review 5: arbitrary cache get is not HTTP; grounded route remains',async()=>{
 const t=tree('export function read(cache: {get(k:string,f:()=>number):number}) {return cache.get("/healthz",()=>1);}');const code=await extractCode(t);const ex=await extractOperations(t,code);
 expect(ex.nodes.filter((n)=>n.kind==='code.health-endpoint')).toEqual([]);expect(normalized(code,ex).filter((e)=>e.properties.role==='handler')).toEqual([]);
 const yes=tree(route+'app.listen(8080);}');expect((await extractOperations(yes,await extractCode(yes))).nodes.filter((n)=>n.kind==='code.health-endpoint')).toHaveLength(1);
 const combined=tree((route+'app.listen(8080);}').replace('import express from', 'import express, {Express} from'));expect((await extractOperations(combined,await extractCode(combined))).nodes.filter((n)=>n.kind==='code.health-endpoint')).toHaveLength(1);
});
test('review 6: ordinary addr metadata is not listener proof for any probe join',async()=>{
 const t=tree(route+'const metadata={addr:":8080"};}',{'docker-compose.yml':'services:\n api:\n  image: api:1\n  healthcheck:\n   test: ["CMD", "curl", "http://localhost:8080/healthz"]\n'});const code=await extractCode(t);const ex=await extractOperations(t,code);const contracts=await extractContracts(t,code);
 expect(ex.nodes.filter((n)=>n.kind==='code.health-endpoint').map((n)=>n.properties.ports)).toEqual([[]]);expect(ex.edges.filter((e)=>e.type==='code.probes')).toEqual([]);expect(normalized(code,ex,contracts).filter((e)=>e.type==='code.probes')).toEqual([]);
});
test('review 7: actual top-level metric options exclude comments strings and nested properties',async()=>{
 const constructor='const requests = new Counter({ /* name: "removed_total", labelNames: ["obsolete"] */ nested: {name:"nested_total",labelNames:["nested"]}, help: "name: \\\"string_total\\\"", name: "requests_total", labelNames: ["method"] })';const t=tree('import {Counter} from "prom-client";\nexport '+constructor+';');const ex=await extractOperations(t);const metrics=ex.nodes.filter((n)=>n.kind==='code.metric');expect(metrics.map((n)=>n.key)).toEqual([`code.metric:${path}#requests_total`]);expect(metrics[0]?.properties.labels).toEqual(['method']);expect(slice(t,metrics[0]?.span)?.trim()).toBe(constructor);
});
test('review 8: constructing Go message proves no publish; writer invocation does',async()=>{
 const goPath='services/api/messages.go';const source=readFileSync(new URL('./fixtures/go-kafka/messages.go',import.meta.url),'utf8');const t=tree('',{[goPath]:source,'services/api/go.mod':readFileSync(new URL('./fixtures/go-kafka/go.mod',import.meta.url),'utf8'),'contracts/asyncapi/events.yaml':'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n events:\n  publish: {message: {name: Changed}}\n'});const ex=await extractContracts(t,await extractCode(t));
 expect(ex.edges.filter((e)=>e.type==='code.publishes'&&e.from===`code.symbol:${goPath}#Build`)).toEqual([]);expect(ex.edges.filter((e)=>e.type==='code.publishes'&&e.from===`code.symbol:${goPath}#Publish`).map((e)=>e.to)).toEqual(['code.channel:events']);
 const only=tree('',{[goPath]:source.slice(0,source.indexOf('func Publish')),'contracts/asyncapi/events.yaml':'asyncapi: 2.6.0\nchannels:\n events:\n  publish: {message: {name: Changed}}\n'});expect((await extractContracts(only)).edges.filter((e)=>e.type==='code.publishes')).toEqual([]);
});
test('review 9: external OpenAPI authority never falls back to sole local route',async()=>{
 const t=tree(route+'app.listen(8080);}',{'contracts/openapi/api.yaml':api});const ex=await extractContracts(t,await extractCode(t));expect(ex.nodes.filter((n)=>n.kind==='code.route')).toHaveLength(1);expect(ex.edges.filter((e)=>e.type==='code.serves')).toEqual([]);expect(ex.gaps.some((g)=>g.path==='contracts/openapi/api.yaml'&&g.reason.includes('line')&&g.reason.includes('server'))).toBe(true);
 const yes=tree(route+'app.listen(8080);}',{'contracts/openapi/api.yaml':api.replace('https://outside.example','http://api:8080')});expect((await extractContracts(yes)).edges.filter((e)=>e.type==='code.serves')).toHaveLength(1);
});
test('review 10: all database evidence contributes exact raw and normalized spans',async()=>{
 const t=tree('import pg from "pg";\nexport const url=process.env.DATABASE_URL;\n',{'services/api/package.json':'{"name":"api","dependencies":{"pg":"8.13.0"}}','services/api/migrations/001.sql':'CREATE TABLE entries (id integer PRIMARY KEY);'});const ex=await extractDataModel(t);const ops=await extractOperations(t);const raw=ex.edges.filter((e)=>e.type==='code.uses-database');expect(raw).toHaveLength(1);for(const edge of raw)expect(edgeEvidenceError(t,{type:edge.type,evidence:edge.span??null,properties:edge.properties})).toBeNull();
 const readings=raw[0]?.properties.origins;expect(Array.isArray(readings)).toBe(true);if(!Array.isArray(readings))throw new Error('missing raw storage readings');expect(readings.length).toBeGreaterThanOrEqual(4);for(const reading of readings){if(reading===null||typeof reading!=='object'||Array.isArray(reading))throw new Error('invalid storage origin');expect(edgeEvidenceError(t,{type:'code.uses-database',evidence:reading.sourceSpan,properties:{}})).toBeNull();}
 const edges=normalized(ex,ops).filter((e)=>e.type==='code.uses-database');expect(edges).toHaveLength(1);expect(JSON.stringify(edges[0]?.properties)).toContain(JSON.stringify(readings));
});

test('inline argument callback is a reference value, never a parent call',async()=>{
 const source='function retry(f:()=>void){f();} function target(){} export function outer(){retry(()=>target());}';
 const t=tree(source);const ex=await extractCode(t);const byte=source.indexOf('()=>target()');const callback=sym(`outer.callback@1:${byte}`);
 const reference=ex.edges.find((e)=>e.type==='code.references'&&e.from===sym('outer')&&e.to===callback);expect(reference?.properties.role).toBe('callback-value');expect(slice(t,reference?.span)).toBe('()=>target()');
 expect(ex.edges.find((e)=>e.type==='code.calls'&&e.from===callback&&e.to===sym('target'))).toBeDefined();expect(ex.edges.some((e)=>e.type==='code.calls'&&e.from===sym('outer')&&e.to===sym('target'))).toBe(false);
});
