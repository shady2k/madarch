import {expect,test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {TreeText} from '../src/extract/operations/source.js';
import {routeListenerPorts,structuralHttpRegistrations} from '../src/extract/operations/route-facts.js';
import type {TreeReader} from '../src/extract/records.js';
const tree=(files:Readonly<Record<string,string>>):TreeReader=>({paths:Object.keys(files).sort(),read(path){const value=files[path];if(value===undefined)throw new Error(`missing fixture ${path}`);return new TextEncoder().encode(value);}});

test('a typed exported app factory retains its own listener across an unused collaborator',async()=>{
 const path='lib/application.ts';const input=tree({
  [path]:`import express,{Express} from "express";
export function build(collaborator:unknown):Express{
 const app=express();app.get("/ready",(req:unknown,res:any)=>res.send("ok"));return app;
}`,
  'lib/start.ts':'import express from "express";import {build as create} from "./application.js";const unused=unknownDependency();create(unused).listen(7541);const other=express();other.listen(7542);',
 });
 const shared=await extractCodeWithFacts(input);const view=new TreeText(input,shared.extraction,shared.facts);
 const registrations=structuralHttpRegistrations(view);expect(registrations.map(route=>route.ports)).toEqual([['7541']]);
 const registration=registrations[0];if(registration===undefined)throw new Error(`${import.meta.path}:21: missing route (${path})`);
 const first=routeListenerPorts(view,registration.span);first.push('9999');expect(routeListenerPorts(view,registration.span)).toEqual(['7541']);
 const result=await extractContracts(input,shared.extraction,shared.facts);expect(result.nodes.filter(node=>node.kind==='code.route').map(node=>node.properties.ports)).toEqual([['7541']]);
 const parameter=shared.facts.bindings.find(binding=>binding.path===path&&binding.kind==='parameter'&&binding.name==='collaborator');
 const exported=shared.facts.exports?.find(entry=>entry.path===path&&entry.name==='build');
 if(parameter===undefined||exported===undefined)throw new Error(`${import.meta.path}:26: missing factory parameter or export proof (${path})`);
 for(const missing of [
  freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.filter(binding=>binding.id!==parameter.id)}),
  freezeCodeFacts({...shared.facts,exports:shared.facts.exports?.filter(entry=>entry.id!==exported.id)}),
  freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.syntaxKind==='required_parameter'&&expression.path===path?{...expression,fields:{...expression.fields,pattern:[]}}:expression)}),
 ])expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,missing)).map(route=>route.ports)).toEqual([[]]);
});

test('Go local middleware closures retain the canonical dependency method only through typed forwarding',async()=>{
 const path='internal/transport/routes.go';const handlers='internal/transport/endpoints.go';const input=tree({
  'go.mod':'module example.test/endpoints\n\ngo 1.23\n',
  [handlers]:`package transport
import "net/http"
type Endpoint struct{}
func (e *Endpoint) Submit(w http.ResponseWriter,r *http.Request){}
`,
  [path]:`package transport
import "net/http"
type Inputs struct{Endpoint *Endpoint}
type Middleware func(http.Handler) http.Handler
func Sequence(items ...Middleware) Middleware{return func(next http.Handler) http.Handler{for i:=len(items)-1;i>=0;i--{next=items[i](next)};return next}}
func Guard(secret string) Middleware{return func(next http.Handler) http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if r.Header.Get("Authorization")==""{return};next.ServeHTTP(w,r.WithContext(r.Context()))})}}
func Build(deps Inputs){mux:=http.NewServeMux();guarded:=Sequence(Guard("secret"));mux.Handle("POST /submit",guarded(http.HandlerFunc(deps.Endpoint.Submit)));http.ListenAndServe(":7551",mux)}
`,
 });
 const shared=await extractCodeWithFacts(input);const wanted=`code.symbol:${handlers}#Endpoint.Submit`;
 const registrations=structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts));
 expect(registrations.map(route=>({handler:route.handler?.key,ports:route.ports}))).toEqual([{handler:wanted,ports:['7551']}]);
 const result=await extractContracts(input,shared.extraction,shared.facts);expect(result.edges.filter(edge=>edge.type==='code.handled-by').map(edge=>edge.to)).toEqual([wanted]);
 const forward=shared.facts.calls.find(call=>shared.facts.expressions.find(expression=>expression.id===call.callee)?.member==='ServeHTTP');
 const field=shared.facts.fields?.find(field=>field.path===path&&field.name==='Endpoint');
 if(forward===undefined||field===undefined)throw new Error(`${import.meta.path}:57: missing forwarding call or exact dependency field (${path})`);
 for(const missing of [
  freezeCodeFacts({...shared.facts,calls:shared.facts.calls.filter(call=>call.expression!==forward.expression)}),
  freezeCodeFacts({...shared.facts,fields:shared.facts.fields?.filter(entry=>entry.key!==field.key)}),
  freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.id===forward.expression?{...expression,arguments:[...forward.arguments].reverse()}:expression)}),
  freezeCodeFacts({...shared.facts,symbols:shared.facts.symbols.map(symbol=>symbol.key===wanted?{...symbol,bodySpan:undefined}:symbol)}),
 ])expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,missing)).some(route=>route.handler?.key===wanted)).toBe(false);
});

test('an arbitrary handler factory cannot claim its unforwarded argument as the route handler',async()=>{
 const path='transport/routes.go';const input=tree({'go.mod':'module example.test/isolated\n\ngo 1.23\n',[path]:`package transport
import "net/http"
func Original(w http.ResponseWriter,r *http.Request){}
func Replace(next http.Handler) http.Handler{return http.NewServeMux()}
func Build(){mux:=http.NewServeMux();mux.Handle("GET /ready",Replace(http.HandlerFunc(Original)));http.ListenAndServe(":7561",mux)}
`});
 const shared=await extractCodeWithFacts(input);expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts)).map(route=>route.handler?.key)).toEqual([undefined]);
});
