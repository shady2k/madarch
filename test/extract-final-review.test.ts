import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {extractCode} from '../src/extract/code/index.js';
import {extractOperations} from '../src/extract/operations/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {edgeEvidenceError} from '../scripts/extract-truth-evidence.js';
import {endpointRelations} from '../src/extract/driver/relationships.js';
import type {Extraction, SourceSpan, TreeReader} from '../src/extract/records.js';
const path='services/api/main.ts';
const enc=new TextEncoder();
const tree=(files:Record<string,string>):TreeReader=>({paths:Object.keys(files).sort(),read:(p)=>{if(files[p]===undefined)throw new Error(`missing fixture ${p}`);return enc.encode(files[p]);}});
const read=(source:string,extra:Record<string,string>={})=>tree({[path]:source,...extra});
const slice=(input:TreeReader,span:SourceSpan|undefined)=>span===undefined?undefined:new TextDecoder().decode(input.read(span.path).subarray(span.byteStart,span.byteEnd));
const symbol=(name:string)=>`code.symbol:${path}#${name}`;
const calls=(ex:Extraction,from:string,to:string)=>ex.edges.filter((e)=>e.type==='code.calls'&&e.from===from&&e.to===to);
describe('final graph review negative counterexamples',()=>{
 test('timer callbacks and nested route callbacks are the actual callers',async()=>{
  const source='import express from "express";\nfunction target() {}\nexport function setup() {\n setTimeout(() => target(), 0);\n const app = express();\n app.get("/healthz", () => { setTimeout(() => target(), 0); });\n}\n';
  const input=read(source);const ex=await extractCode(input);
  const firstAt=source.indexOf('() => target()');const secondAt=source.lastIndexOf('() => target()');
  const routeAt=source.indexOf('() => {');
  const route=symbol(`setup.callback@6:${routeAt}`);
  const first=symbol(`setup.callback@4:${firstAt}`);const second=symbol(`setup.callback@6:${routeAt}.callback@6:${secondAt}`);
  expect(calls(ex,symbol('setup'),symbol('target'))).toEqual([]);expect(calls(ex,route,symbol('target'))).toEqual([]);
  for(const from of [first,second]) {expect(calls(ex,from,symbol('target'))).toHaveLength(1);expect(slice(input,ex.nodes.find((n)=>n.key===from)?.span)).toBe('() => target()');}
  expect(ex.nodes.find((n)=>n.key===first)?.label).toBe('setup callback (line 4)');
 });
 test('health callback owns metric updates and logger uses, not its outer factory',async()=>{
  const source='import express from "express";\nimport {Counter} from "prom-client";\nimport pino from "pino";\nconst requests = new Counter({name: "requests_total", help: "Requests"});\nconst logger = pino();\nexport function start() {\n const app = express();\n app.get("/healthz", () => { requests.inc(); logger.info("ready"); });\n}\n';
  const input=read(source);const code=await extractCode(input);const ex=extractOperations(input,code);
  const at=source.indexOf('() => {');const callback=symbol(`start.callback@8:${at}`);
  expect(code.nodes.find((n)=>n.key===callback)).toBeDefined();
  const update=ex.edges.filter((e)=>e.type==='code.updates-metric');expect(update.map((e)=>e.from)).toEqual([callback]);expect(slice(input,update[0]?.span)).toBe('requests.inc(');
  const uses=ex.edges.filter((e)=>e.type==='code.uses-logger'&&e.to.startsWith('code.symbol:'));expect(uses.map((e)=>e.to)).toEqual([callback]);
  const handlers=ex.edges.filter((e)=>e.type==='code.served-by'&&e.properties.role==='handler');expect(handlers.map((e)=>e.to)).toEqual([callback]);
  expect(ex.edges.some((e)=>(e.type==='code.updates-metric'&&e.from===symbol('start'))||(e.type==='code.uses-logger'&&e.to===symbol('start'))||(e.properties.role==='handler'&&e.to===symbol('start')))).toBe(false);
 });
 test('adjacent semicolon-free constructors retain their own exact options and bytes',()=>{
  const source='import {Counter, Histogram} from "prom-client"\nexport const requests = new Counter({name: "requests_total", help: "Requests"})\nexport const latency = new Histogram({\n name: "latency", help: "Latency", labelNames: ["method"]\n})\n';
  const input=read(source);const ex=extractOperations(input);const counter=ex.nodes.find((n)=>n.key===`code.metric:${path}#requests_total`);expect(counter).toBeDefined();expect(counter?.properties.labels).toEqual([]);expect(slice(input,counter?.span)?.trim()).toBe('const requests = new Counter({name: "requests_total", help: "Requests"})');
  const histogram=ex.nodes.find((n)=>n.key===`code.metric:${path}#latency`);expect(histogram?.properties.labels).toEqual(['method']);expect(slice(input,histogram?.span)?.trim()).toBe('const latency = new Histogram({\n name: "latency", help: "Latency", labelNames: ["method"]\n})');
 });
 test.each([
  'const registry = {metrics: () => ""};\napp.get("/metrics", async (_req, res) => res.end(await registry.metrics()));',
  '// app.get("/metrics", (_req, res) => res.end(register.metrics()));',
  'function fake(register: any) { app.get("/metrics", (_req, res) => res.end(register.metrics())); }',
 ])('unrelated, commented and shadowed registry exposure is absent: %s',(registration)=>{
  const input=read('import {Counter, register} from "prom-client";\nconst requests = new Counter({name:"requests_total",help:"Requests"});\n'+registration+'\n');const ex=extractOperations(input);expect(ex.nodes.filter((n)=>n.kind==='code.metric')).toHaveLength(1);expect(ex.edges.filter((e)=>e.type==='code.exposes-metric')).toEqual([]);
 });
 test.each([
  'export function unrelated(pino: () => number) { const fake = pino(); return fake; }',
  'export function unrelated() { const pino = () => 1; const fake = pino(); return fake; }',
 ])('shadowed logger factory emits no invented logger: %s',(body)=>{const ex=extractOperations(read('import pino from "pino";\n'+body));expect(ex.nodes.filter((n)=>n.kind==='code.logger')).toEqual([]);});
 test('remote compose health target does not probe its containing service',async()=>{
  const input=read('import express from "express";\nfunction health(req:any,res:any){res.send("ok");}\nfunction start(){const app=express();app.get("/healthz",health);app.listen(8080);}',{'docker-compose.yml':'services:\n  api:\n    image: api:1\n    healthcheck:\n      test: ["CMD", "curl", "http://peer:8080/healthz"]\n'});
  const operations=extractOperations(input);const code=await extractCode(input);const contracts=await extractContracts(input,code);
  expect(operations.nodes.some((n)=>n.kind==='code.healthcheck')).toBe(true);
  expect(operations.edges.filter((e)=>e.type==='code.probes')).toEqual([]);
  expect(endpointRelations([operations,contracts]).flatMap((e)=>e.edges).filter((e)=>e.type==='code.probes')).toEqual([]);
 });
 test('route-operation semantic link carries the real matching registration evidence',async()=>{
  const source='import express from "express";\nfunction health(req:any,res:any){res.send("ok");}\nfunction start(){const app=express();app.get("/healthz",health);app.listen(8080);}';
  const input=read(source,{'contracts/openapi/api.yaml':'openapi: 3.0.0\ninfo: {title: API, version: 1.0.0}\nservers: [{url: "http://api:8080"}]\npaths:\n  /healthz:\n    get: {operationId: health}\n'});
  const ex=await extractContracts(input,await extractCode(input));const link=ex.edges.find((e)=>e.type==='code.serves');expect(link).toBeDefined();expect(slice(input,link?.span)).toBe('app.get("/healthz",health)');
 });
});

test('semantic evidence absence is diagnosed, explicit structural membership is classified',()=>{
 const input=read('x');const base={properties:{},evidence:null};
 expect(edgeEvidenceError(input,{...base,type:'code.serves'})).toBe('no source span');
 expect(edgeEvidenceError(input,{...base,type:'code.contains'})).toBeNull();
 expect(edgeEvidenceError(input,{...base,type:'code.calls'})).toBe('no source span');
});
test('imported default registry exposes only default members',()=>{
 const input=read('import {Counter, register} from "prom-client";\nconst requests=new Counter({name:"requests_total",help:"Requests"});\nconst privateCount=new Counter({name:"private_total",help:"Private",registers:[]});\napp.get("/metrics", async (_req,res)=>res.end(await register.metrics()));');
 const ex=extractOperations(input);expect(ex.edges.filter((e)=>e.type==='code.exposes-metric').map((e)=>e.to)).toEqual([`code.metric:${path}#requests_total`]);
});
test('health targets preserve local listener port and explicit HTTP method',async()=>{
 const source='import express from "express";\nfunction health(req:any,res:any){res.send("ok");}\nfunction start(){const app=express();app.get("/healthz",health);app.post("/healthz",health);app.listen(8080);}';
 for(const [command,method] of [['curl http://localhost:8080/healthz','GET'],['curl -X POST http://localhost:8080/healthz','POST'],['curl http://localhost:9090/healthz',null]] as const) {
  const input=read(source,{'docker-compose.yml':`services:\n  api:\n    image: api:1\n    healthcheck:\n      test: ["CMD-SHELL", "${command}"]\n`});
  const operations=extractOperations(input);const contracts=await extractContracts(input,await extractCode(input));
  const probes=endpointRelations([operations,contracts]).flatMap((entry)=>entry.edges).filter((e)=>e.type==='code.probes'&&e.discriminator==='route');
  expect(probes.map((e)=>e.to)).toEqual(method===null?[]:[`code.route:${path}#${method}:/healthz`]);
 }
});

test('no listener proof, unknown health method and remote Kubernetes host cannot produce route joins',async()=>{
 const input=read('import express from "express"; function h(req:any,res:any){} function start(){const app=express();app.get("/healthz",h);}',{'docker-compose.yml':'services:\n  api:\n    image: api:1\n    healthcheck:\n      test: ["CMD", "curl", "http://localhost:8080/healthz"]\n'});
 const operations=extractOperations(input);const contracts=await extractContracts(input,await extractCode(input));
 expect(endpointRelations([operations,contracts]).flatMap((ex)=>ex.edges).filter((e)=>e.type==='code.probes'&&e.discriminator==='route')).toEqual([]);
 const route=contracts.nodes.find((n)=>n.kind==='code.route')!;
 const probes:Extraction={producer:'code.extract.operations',nodes:[
  {key:'code.probe:remote',kind:'code.probe',label:'remote',properties:{service:'api',host:'peer',path:'/healthz',port:8080}},
  {key:'code.health-endpoint:unknown',kind:'code.health-endpoint',label:'unknown',properties:{service:'api',path:'/healthz'}},
  {key:'code.probe:unresolved-name',kind:'code.probe',label:'unknown named port',properties:{service:'api',path:'/healthz',port:'web',resolvedPort:null}},
 ],edges:[],gaps:[]};
 const listeners={...contracts,nodes:[{...route,properties:{...route.properties,ports:['8080']}}]};
 expect(endpointRelations([probes,listeners])[0]?.edges).toEqual([]);
});
test('Go adjacent constructors never borrow later namespace labels or spans',()=>{
 const goPath='services/api/metrics.go';const source=readFileSync(new URL('./fixtures/go-prometheus/adjacent.go',import.meta.url),'utf8');
 const input=tree({[goPath]:source});const ex=extractOperations(input);const counter=ex.nodes.find((n)=>n.key===`code.metric:${goPath}#requests_total`);expect(counter?.properties.labels).toEqual([]);expect(slice(input,counter?.span)?.trim()).toBe('var requests = prom.NewCounter(prom.CounterOpts{Name:"requests_total"})');
 expect(ex.nodes.find((n)=>n.key===`code.metric:${goPath}#other_sub_latency`)?.properties.labels).toEqual(['method']);
});
