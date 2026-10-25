import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {extractCode} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {extractOperations} from '../src/extract/operations/index.js';
import {linkExtractions} from '../src/extract/driver/links.js';
import {endpointRelations} from '../src/extract/driver/relationships.js';
import type {TreeReader} from '../src/extract/records.js';
const path = 'services/api/main.ts';
const tree = (files: Record<string,string>): TreeReader => ({paths:Object.keys(files).sort(),read:(file)=>{const source=files[file];if(source===undefined)throw new Error(`missing fixture ${file}`);return new TextEncoder().encode(source);}});
const health = 'function health(req: unknown,res: {send(s:string):void}){res.send("ok");}';
const probe = (port: number) => `services:\n api:\n  image: api:1\n  healthcheck:\n   test: ["CMD", "curl", "http://localhost:${port}/healthz"]\n`;

test('final 2: unrelated real app listener never lends ports to health receiver or route', async()=>{
 const files = {[path]:`import express from "express"; ${health} export function setup(){const app=express();app.get("/healthz",health);app.listen(9090);}`,'services/api/admin.ts':'import express from "express"; const admin=express();admin.listen(8080);','docker-compose.yml':probe(8080)};
 const read=async(input:TreeReader)=>{const code=await extractCode(input);const ops=extractOperations(input,code);const contracts=await extractContracts(input,code);return {ops,contracts,edges:linkExtractions(endpointRelations([code,ops,contracts]),{}).extractions.flatMap((ex)=>ex.edges)};};
 const bad=await read(tree(files));
 expect(bad.ops.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([['9090']]);
 expect(bad.contracts.nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([['9090']]);
 expect(bad.ops.edges.filter((edge)=>edge.type==='code.probes')).toEqual([]);expect(bad.edges.filter((edge)=>edge.type==='code.probes')).toEqual([]);
 const yes=await read(tree({...files,'docker-compose.yml':probe(9090)}));expect(yes.ops.edges.filter((edge)=>edge.type==='code.probes')).toHaveLength(1);expect(yes.edges.some((edge)=>edge.type==='code.probes'&&edge.to.startsWith('code.route:'))).toBe(true);
 const unsupported=await read(tree({...files,[path]:`import express from "express"; ${health} export function setup(){const app=express();app.get("/healthz",health);}`,'docker-compose.yml':probe(8080)}));
 expect(unsupported.edges.filter((edge)=>edge.type==='code.probes')).toEqual([]);expect(unsupported.ops.gaps.some((gap)=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener'))).toBe(true);expect(unsupported.contracts.gaps.some((gap)=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener'))).toBe(true);
});

test('final 2 positives: imported mounted router and Go server Handler retain only actual listener',async()=>{
 const routePath='services/api/routes.ts';
 const t=tree({[routePath]:`import {Router} from "express"; ${health} export function healthRoutes(){const router=Router();router.get("/healthz",health);return router;}`,[path]:'import express from "express";import {healthRoutes} from "./routes.js";const app=express();app.use("/",healthRoutes());app.listen(9090);','services/api/admin.ts':'import express from "express";const admin=express();admin.listen(8080);'});
 const code=await extractCode(t);const ops=extractOperations(t,code);const contracts=await extractContracts(t,code);
 expect(ops.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([['9090']]);expect(contracts.nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([['9090']]);
 const goPath='services/api/router.go';const go=tree({[goPath]:'package api\nimport "net/http"\nfunc NewRouter() http.Handler { mux := http.NewServeMux(); mux.HandleFunc("GET /healthz", Health); return mux }\nfunc Health(w http.ResponseWriter,r *http.Request){}\n','services/api/cmd/main.go':'package main\nimport ("net/http";"example.test/api")\nconst listenAddr = ":9090"\nfunc main(){router:=api.NewRouter();server:=&http.Server{Addr:listenAddr,Handler:router};server.ListenAndServe()}\n','services/api/go.mod':'module example.test/api\n\ngo 1.23\n'});
 const goCode=await extractCode(go);expect(extractOperations(go,goCode).nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([['9090']]);expect((await extractContracts(go,goCode)).nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([['9090']]);
});

test('final 3: cache metrics callback is not HTTP; grounded app retains registry members',()=>{
 const metric='import {Counter,register} from "prom-client";const requests=new Counter({name:"requests_total",help:"Requests"});';
 const bad=extractOperations(tree({[path]:metric+'export function read(cache:{get(k:string,f:()=>Promise<string>):unknown}){return cache.get("/metrics",()=>register.metrics());}'}));
 expect(bad.nodes.filter((node)=>node.kind==='code.metric')).toHaveLength(1);expect(bad.nodes.filter((node)=>node.kind==='code.metrics-endpoint')).toEqual([]);expect(bad.edges.filter((edge)=>edge.type==='code.exposes-metric')).toEqual([]);
 const yes=extractOperations(tree({[path]:'import express from "express";'+metric+'const app=express();app.get("/metrics",()=>register.metrics());'}));expect(yes.nodes.filter((node)=>node.kind==='code.metrics-endpoint')).toHaveLength(1);expect(yes.edges.filter((edge)=>edge.type==='code.exposes-metric').map((edge)=>edge.to)).toEqual([`code.metric:${path}#requests_total`]);
});

test('final 4: local binding sides shadow factory and logger, keys and unrelated scopes do not',async()=>{
 const source='import pino from "pino";const logger=pino();export function fakeFactory(input:{pino:()=>number}){const {pino}=input;const fake=pino();return fake;}export function fakeUse(input:{logger:{info(s:string):void}}){let {logger}=input;logger.info("fake");}export function arrayUse(input:{info(s:string):void}[]){var [logger]=input;logger.info("array");}export function renamed(input:{logger:number}){const {logger:other}=input;logger.info("real");}export function positive(){logger.info("real");}';
 const t=tree({[path]:source});const ex=extractOperations(t,await extractCode(t));expect(ex.nodes.filter((node)=>node.kind==='code.logger').map((node)=>node.key)).toEqual([`code.logger:${path}#logger`]);expect(ex.edges.filter((edge)=>edge.type==='code.uses-logger'&&edge.to.startsWith('code.symbol:')).map((edge)=>edge.to).sort()).toEqual([`code.symbol:${path}#positive`,`code.symbol:${path}#renamed`]);expect(ex.gaps.some((gap)=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('logger factory'))).toBe(true);
 const alias=extractOperations(tree({[path]:'import pino from "pino";function fake(input:{factory:()=>number}){const {factory:pino}=input;const fake=pino();}function nested(input:{nested:{pino:()=>number}}){const {nested:{pino}}=input;const no=pino();}const actual=pino();'}));expect(alias.nodes.filter((node)=>node.kind==='code.logger').map((node)=>node.key)).toEqual([`code.logger:${path}#actual`]);
});

test('final 5: actual Kafka message direct Topic defeats comment string and nested decoys',async()=>{
 const goPath='services/api/messages.go';const t=tree({[goPath]:readFileSync(new URL('./fixtures/go-kafka/messages.go',import.meta.url),'utf8'),'services/api/go.mod':readFileSync(new URL('./fixtures/go-kafka/go.mod',import.meta.url),'utf8'),'contracts/asyncapi/events.yaml':'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n events:\n  publish: {message: {name: Changed}}\n ghost:\n  publish: {message: {name: Ghost}}\n'});
 const ex=await extractContracts(t,await extractCode(t));const edges=ex.edges.filter((edge)=>edge.type==='code.publishes'&&edge.from===`code.symbol:${goPath}#PublishDecoys`);expect(edges.map((edge)=>edge.to)).toEqual(['code.channel:events']);expect(ex.edges.some((edge)=>edge.type==='code.publishes'&&edge.to==='code.channel:ghost')).toBe(false);expect(ex.edges.some((edge)=>edge.type==='code.publishes'&&edge.from===`code.symbol:${goPath}#Publish`&&edge.to==='code.channel:events')).toBe(true);expect(ex.edges.some((edge)=>edge.type==='code.publishes'&&edge.from===`code.symbol:${goPath}#Build`)).toBe(false);const span=edges[0]?.span;expect(span).toBeDefined();if(span===undefined)throw new Error('missing actual invocation span');expect(new TextDecoder().decode(t.read(span.path).subarray(span.byteStart,span.byteEnd))).toStartWith('w.WriteMessages(');
});

test('final 6: combined Express imports keep Router aliases and exact shadow guard',()=>{
 for(const factory of ['Router','makeRouter']){
 const spec=factory==='Router'?'Router':'Router as makeRouter';const t=tree({[path]:`import express,{${spec},Express} from "express";${health}function routes(){const router=${factory}();router.get("/healthz",health);return router;}function shadow(${factory}:()=>{get(p:string,f:unknown):void}){const fake=${factory}();fake.get("/healthz",health);}const app=express();app.get("/readyz",health);`});const ex=extractOperations(t);expect(ex.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.path).sort()).toEqual(['/healthz','/readyz']);
 }
});


test.each([
 'const PORT=9090;createApp().listen(PORT);',
 'const PORT=9090;const app=createApp();app.listen(PORT);',
])('returned imported app proves its own chained or held listener: %s',async(listener)=>{
 const appPath='services/api/app.ts';
 const input=tree({[appPath]:`import express from "express";${health}export function createApp(){const app=express();app.get("/healthz",health);return app;}`,[path]:`import {createApp} from "./app.js";${listener}`,'services/api/admin.ts':'import express from "express";const admin=express();admin.listen(8080);'});
 const code=await extractCode(input);const ops=extractOperations(input,code);const contracts=await extractContracts(input,code);
 expect(ops.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([['9090']]);
 expect(contracts.nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([['9090']]);
 expect(ops.gaps).toEqual([]);expect(contracts.gaps).toEqual([]);
});

test.each([
 'const PORT=9090;function start(createApp:()=>{listen(p:number):void}){createApp().listen(PORT);}',
 'const PORT=9090;const app=createApp();function start(app:{listen(p:number):void}){app.listen(PORT);}',
 'const PORT=9090;const app=createApp();function start(PORT:number){app.listen(PORT);}',
 'const PORT=9090;const other=express();other.listen(PORT);',
 'function unrelated(){const PORT=9090;}createApp().listen(PORT);',
])('returned app never borrows shadowed factory, local, port or unrelated receiver: %s',async(listener)=>{
 const appPath='services/api/app.ts';
 const input=tree({[appPath]:`import express from "express";${health}export function createApp(){const app=express();app.get("/healthz",health);return app;}`,[path]:`import express from "express";import {createApp} from "./app.js";${listener}`});
 const code=await extractCode(input);const ops=extractOperations(input,code);const contracts=await extractContracts(input,code);
 expect(ops.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([[]]);
 expect(contracts.nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([[]]);
 expect(ops.gaps.some((gap)=>gap.path===appPath&&gap.reason.includes('receiver/listener'))).toBe(true);
 expect(contracts.gaps.some((gap)=>gap.path===appPath&&gap.reason.includes('receiver/listener'))).toBe(true);
});

const goListenerCases: [string, string, string[]][] = [
 ['handler:=api.New();server:=&http.Server{Addr:addr,Handler:handler.Routes()};server.ListenAndServe()', 'return mux', ['9090']],
 ['handler:=api.Other();server:=&http.Server{Addr:addr,Handler:handler.Routes()};server.ListenAndServe()', 'return mux', []],
 ['handler:=api.New();server:=&http.Server{Addr:addr,Handler:http.NewServeMux()};server.ListenAndServe()', 'return mux', []],
 ['handler:=api.New();server:=&http.Server{Addr:addr,Handler:handler.Routes()}', 'return mux', []],
 ['handler:=api.New();server:=&http.Server{Addr:addr,Handler:handler.Routes()};server.ListenAndServe()', 'other:=http.NewServeMux();return other', []],
];
test.each(goListenerCases)('returned Go method mux keeps constructor and active Server.Handler proof: %s',async(body,returned,ports)=>{
 const goPath='services/api/handler.go';
 const input=tree({[goPath]:`package api\nimport "net/http"\ntype Handler struct{}\ntype Decoy struct{}\nfunc New() *Handler {return &Handler{}}\nfunc Other() *Decoy {return &Decoy{}}\nfunc (d *Decoy) Routes() http.Handler {return http.NewServeMux()}\nfunc (h *Handler) Routes() http.Handler {mux:=http.NewServeMux();mux.HandleFunc("GET /healthz",Health);${returned}}\nfunc Health(w http.ResponseWriter,r *http.Request){}\n`,'services/api/cmd/main.go':`package main\nimport ("net/http";"example.test/api")\nconst addr=":9090"\nfunc main(){${body}}\n`,'services/api/go.mod':'module example.test/api\n\ngo 1.23\n'});
 const code=await extractCode(input);const ops=extractOperations(input,code);const contracts=await extractContracts(input,code);
 expect(ops.nodes.filter((node)=>node.kind==='code.health-endpoint').map((node)=>node.properties.ports)).toEqual([ports]);
 expect(contracts.nodes.filter((node)=>node.kind==='code.route').map((node)=>node.properties.ports)).toEqual([ports]);
 if(ports.length===0){expect(ops.gaps.some((gap)=>gap.path===goPath&&gap.reason.includes('receiver/listener'))).toBe(true);expect(contracts.gaps.some((gap)=>gap.path===goPath&&gap.reason.includes('receiver/listener'))).toBe(true);}
 else {expect(ops.gaps).toEqual([]);expect(contracts.gaps).toEqual([]);}
});
