import {expect,test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {extractContracts as fixtureContracts,extractCode as fixtureCode} from './extract-code-facts-fixture.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {TreeText} from '../src/extract/operations/source.js';
import {structuralHttpRegistrations} from '../src/extract/operations/route-facts.js';
import {httpModels,validateHttpModels} from '../src/extract/library-models/http-models.js';
import type {TreeReader} from '../src/extract/records.js';
const tree=(files:Readonly<Record<string,string>>):TreeReader=>({paths:Object.keys(files).sort(),read(path){const value=files[path];if(value===undefined)throw new Error(`missing fixture ${path}`);return new TextEncoder().encode(value);}});
const handler='function status(req:unknown,res:{send(s:string):void}){res.send("ok");}';

test('contracts share the fixture owner and follow a renamed mounted factory without another listener',async()=>{
 const input=tree({'lib/routes.ts':`import {Router as make} from "express";${handler}export function endpoints(){const route=make();route.get("/ready",status);return route;}`,'lib/start.ts':'import express from "express";import {endpoints as routes} from "./routes.js";const front=express();front.use("/",routes());front.listen(7311);','lib/unrelated.ts':'import express from "express";const other=express();other.listen(7412);'});
 const code=await fixtureCode(input);const result=await fixtureContracts(input,code);
 const route=result.nodes.find(node=>node.kind==='code.route');expect(route?.properties.ports).toEqual(['7311']);
 expect(result.edges.some(edge=>edge.type==='code.handled-by'&&edge.to==='code.symbol:lib/routes.ts#status')).toBe(true);
});

test('provided facts are authoritative: removing a listener call cannot trigger a source fallback',async()=>{
 const path='modules/status.ts';const source=`import express from "express";${handler}export function build(){const endpoint=express();endpoint.get("/ready",status);endpoint.listen(7311);}`;const input=tree({[path]:source});
 const shared=await extractCodeWithFacts(input);expect(Object.isFrozen(shared.facts)).toBe(true);
 const registrations=structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts));expect(registrations).toHaveLength(1);expect(registrations[0]?.ports).toEqual(['7311']);expect(registrations[0]?.handler?.key).toBe(`code.symbol:${path}#status`);
 const listener=shared.facts.calls.find(call=>shared.facts.expressions.find(expression=>expression.id===call.callee)?.member==='listen');
 if(listener===undefined)throw new Error(`${import.meta.path}:25: missing real listener proof for ${path}`);
 const missing=freezeCodeFacts({...shared.facts,calls:shared.facts.calls.filter(call=>call.expression!==listener.expression)});
 const result=await extractContracts(input,shared.extraction,missing);expect(result.nodes.filter(node=>node.kind==='code.route').map(node=>node.properties.ports)).toEqual([[]]);
 expect(result.gaps.some(gap=>gap.path===path&&gap.reason.includes('receiver/listener'))).toBe(true);
 const codeOnly=await extractContracts(input,shared.extraction);expect(codeOnly.nodes.filter(node=>node.kind==='code.route').map(node=>node.properties.ports)).toEqual([[]]);expect(codeOnly.gaps.some(gap=>gap.reason.includes('shared resolved code facts'))).toBe(true);
 expect(shared.facts.calls.some(call=>call.expression===listener.expression)).toBe(true);
});

test('a missing innermost callable proof never moves a remote site to its enclosing function',async()=>{
 const path='lib/route.ts';const input=tree({[path]:'import express from "express";export function start(){const app=express();app.get("/ready",async(req:any,res:any)=>{res.send(await fetch("http://local.test/ready"));});}', 'contracts/openapi/local.yaml':'openapi: 3.0.0\ninfo: {title: Local, version: 1.0.0}\nservers: [{url: "http://local.test"}]\npaths:\n /ready:\n  get: {operationId: ready}\n'});
 const shared=await extractCodeWithFacts(input);const inline=shared.facts.symbols.find(symbol=>symbol.callable&&symbol.key!=='code.symbol:lib/route.ts#start');if(inline===undefined)throw new Error(`${import.meta.path}:35: missing real inline callable in ${path}`);
 const missing=freezeCodeFacts({...shared.facts,symbols:shared.facts.symbols.map(symbol=>symbol.key===inline.key?{...symbol,bodySpan:undefined}:symbol)});
 const result=await extractContracts(input,shared.extraction,missing);
 expect(result.edges.filter(edge=>edge.type==='code.calls-remote'&&!edge.properties.summary)).toEqual([]);
 expect(result.nodes.filter(node=>node.kind==='code.symbol')).toEqual([]);
 expect(result.gaps.some(gap=>gap.path===path&&gap.reason.includes('innermost callable'))).toBe(true);
});


test('Go receiver constructor and active Server.Handler keep only the exact listener',async()=>{
 const path='components/http/handler.go';
 const base={
  [path]:'package status\nimport "net/http"\ntype Endpoint struct{}\ntype Other struct{}\nfunc New() *Endpoint{return &Endpoint{}}\nfunc Decoy() *Other{return &Other{}}\nfunc (o *Other) Routes() http.Handler{return http.NewServeMux()}\nfunc (e *Endpoint) Routes() http.Handler{mux:=http.NewServeMux();mux.HandleFunc("GET /ready",Status);return mux}\nfunc Status(w http.ResponseWriter,r *http.Request){}\n',
  'go.mod':'module example.test/status\n\ngo 1.23\n',
 };
 for(const [body,ports] of [
  ['endpoint:=status.New();server:=&http.Server{Addr:":7311",Handler:endpoint.Routes()};server.ListenAndServe()',['7311']],
  ['endpoint:=status.Decoy();server:=&http.Server{Addr:":7311",Handler:endpoint.Routes()};server.ListenAndServe()',[]],
  ['endpoint:=status.New();server:=&http.Server{Addr:":7311",Handler:http.NewServeMux()};server.ListenAndServe()',[]],
  ['endpoint:=status.New();server:=&http.Server{Addr:":7311",Handler:endpoint.Routes()}',[]],
 ] as const){
  const input=tree({...base,'cmd/run/main.go':`package main\nimport ("net/http";"example.test/status/components/http")\nfunc main(){${body}}\n`});
  const shared=await extractCodeWithFacts(input);const result=await extractContracts(input,shared.extraction,shared.facts);
  const registrations=structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts));
  const actual=result.nodes.filter(node=>node.kind==='code.route').map(node=>node.properties.ports);
  if(JSON.stringify(actual)!==JSON.stringify([ports]))throw new Error(`${import.meta.path}:60: immutable listener proof mismatch (${path})\n${JSON.stringify({body,expected:ports,actual,registrations,facts:shared.facts,nodes:result.nodes,edges:result.edges,gaps:result.gaps},null,2)}`);
  expect(actual).toEqual([ports]);expect(registrations.map(route=>route.ports)).toEqual([ports]);
 }
});


test('HTTP descriptors reject executable or unknown vocabulary and freeze all selectors',()=>{
 expect(Object.isFrozen(httpModels)).toBe(true);expect(Object.isFrozen(httpModels[0]?.target)).toBe(true);
 for(const variant of [
  {schemaVersion:1,models:[{...httpModels[0],execute:'source code'}]},
  {schemaVersion:1,models:[{...httpModels[0],effect:{kind:'arbitrary-script'}}]},
  {schemaVersion:1,models:[...httpModels,httpModels[0]]},
  {schemaVersion:1,models:[{...httpModels[0],target:{kind:'member',roles:['application'],members:['madeUp']},effect:{kind:'listen',portArgument:-5,portFormat:'number'}}]},
 ])expect(()=>validateHttpModels(variant)).toThrow();
});
