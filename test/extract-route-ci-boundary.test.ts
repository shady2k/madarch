import {expect,test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {TreeText} from '../src/extract/operations/source.js';
import {routeListenerPorts,structuralHttpRegistrations} from '../src/extract/operations/route-facts.js';
import type {TreeReader} from '../src/extract/records.js';
import {byCodePoint} from '../src/model/order.js';
import {httpModels,validateHttpModels} from '../src/extract/library-models/http-models.js';
const tree=(files:Readonly<Record<string,string>>):TreeReader=>({paths:Object.keys(files).sort(byCodePoint),read(path){const source=files[path];if(source===undefined)throw new Error(`${import.meta.path}:9: missing fixture ${path}`);return new TextEncoder().encode(source);}});
test('HTTP forwarding descriptors admit only closed request and writer semantics',()=>{
 const handler=httpModels.find(model=>model.effect.kind==='handler');if(handler?.effect.kind!=='handler')throw new Error(`${import.meta.path}:11: missing HTTP handler descriptor`);
 for(const effect of [{...handler.effect,requestPreservingMembers:['CloneUnknown']},{...handler.effect,writerMembers:['FlushUnknown']}])expect(()=>validateHttpModels({schemaVersion:1,models:[{...handler,effect}]})).toThrow();
});
const path='internal/web/transport.go';
const header=`package web
import h "net/http"
func Ready(w h.ResponseWriter,r *h.Request){}
`;
const wrappers=`
func Trace(next h.Handler) h.Handler {
 return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){next.ServeHTTP(w,r)})
}
func Audit(next h.Handler) h.Handler {
 return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){next.ServeHTTP(w,r)})
}
type Layer func(h.Handler) h.Handler
func Compose(layers ...Layer) Layer {
 return func(next h.Handler) h.Handler {
  for i:=len(layers)-1;i>=0;i-- {next=layers[i](next)}
  return next
 }
}
`;
const inputFor=(returned:string,extra='')=>tree({'go.mod':'module example.test/transport\n\ngo 1.23\n',[path]:header+wrappers+extra+`
func Build() h.Handler {mux:=h.NewServeMux();mux.HandleFunc("GET /ready",Ready);return ${returned}}
func Start(){server:=&h.Server{Addr:":7643",Handler:Build()};server.ListenAndServe()}
`});

test.each(['Trace(mux)','Audit(Trace(mux))','Compose(Trace,Audit)(mux)'])('HTTP forwarding retains the receiver through proved wrappers: %s',async(returned)=>{
 const input=inputFor(returned);const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);
 const routes=structuralHttpRegistrations(context);const diagnostic=JSON.stringify({test:import.meta.path,path,returned,routes,gaps:[...context.factGaps.values()],facts:shared.facts},null,2);expect(routes,diagnostic).toHaveLength(1);expect(routes[0]?.ports,diagnostic).toEqual(['7643']);expect(routes[0]?.handler?.key,diagnostic).toBe(`code.symbol:${path}#Ready`);
 const registration=routes[0];if(registration===undefined)throw new Error(`${import.meta.path}:39: missing registration (${path})`);
 expect(new TextDecoder().decode(input.read(path).subarray(registration.span.byteStart,registration.span.byteEnd))).toBe('mux.HandleFunc("GET /ready",Ready)');
 const listener=shared.facts.calls.find(call=>shared.facts.expressions.find(expression=>expression.id===call.callee)?.member==='ListenAndServe');
 if(listener===undefined)throw new Error(`${import.meta.path}:42: missing active listener (${path})`);
 const incomplete=freezeCodeFacts({...shared.facts,calls:shared.facts.calls.filter(call=>call.expression!==listener.expression)});const missing=new TreeText(input,shared.extraction,incomplete);
 expect(routeListenerPorts(missing,registration.span)).toEqual([]);expect([...missing.factGaps.values()].some(gap=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener'))).toBe(true);
});

test.each([
 ['Opaque(mux)','func Opaque(next h.Handler) h.Handler {return h.NewServeMux()}'],
 ['Compose(Trace,Opaque)(mux)','func Opaque(next h.Handler) h.Handler {return h.NewServeMux()}'],
 ['Swapped(mux)','func Swapped(next h.Handler) h.Handler {return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){next.ServeHTTP(nil,r)})}'],
 ['Conditional(mux)','func Conditional(next h.Handler) h.Handler {return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){if r!=nil {next.ServeHTTP(w,r)}})}'],
 ['Drop(mux)','func Drop(next h.Handler) h.Handler {return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){Ready(w,r)})}'],
])('an unproved wrapper does not borrow an unrelated listener: %s',async(returned,extra)=>{
 const input=inputFor(returned,extra);const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);const routes=structuralHttpRegistrations(context);
 expect(routes).toHaveLength(1);expect(routes[0]?.ports).toEqual([]);const registration=routes[0];if(registration===undefined)throw new Error(`${import.meta.path}:58: missing registration (${path})`);
 expect(routeListenerPorts(context,registration.span)).toEqual([]);expect([...context.factGaps.values()].some(gap=>gap.path===path&&gap.reason.includes('receiver/listener'))).toBe(true);
});

const observing=`
type Observer struct{h.ResponseWriter;code int}
func (o *Observer) WriteHeader(code int){o.code=code;o.ResponseWriter.WriteHeader(code)}
func Observe(next h.Handler) h.Handler {
 return h.HandlerFunc(func(w h.ResponseWriter,r *h.Request){
  out:=&Observer{ResponseWriter:w}
  r=r.WithContext(r.Context())
  next.ServeHTTP(out,r)
 })
}
`;
test.each(['Observe(mux)','Compose(Trace,Observe)(mux)'])('a typed embedded writer and imported request copy retain HTTP forwarding: %s',async(returned)=>{
 const input=inputFor(returned,observing);const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);const routes=structuralHttpRegistrations(context);
 expect(routes.map(route=>route.ports),JSON.stringify({test:import.meta.path,path,returned,routes,gaps:[...context.factGaps.values()],facts:shared.facts},null,2)).toEqual([['7643']]);
});
test.each([
 ['o.ResponseWriter.WriteHeader(code)','Ready(nil,nil)'],
 ['ResponseWriter:w','ResponseWriter:nil'],
 ['r=r.WithContext(r.Context())','r=nil'],
 ['h.ResponseWriter;code int','ResponseWriter h.ResponseWriter;code int'],
])('writer/request adapters need structural provenance: %s',async(before,after)=>{
 for(const returned of ['Observe(mux)','Compose(Trace,Observe)(mux)']){
  const input=inputFor(returned,observing.replace(before,after));const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);const routes=structuralHttpRegistrations(context);expect(routes.map(route=>route.ports),JSON.stringify({test:import.meta.path,path,returned,before,after,routes,gaps:[...context.factGaps.values()],facts:shared.facts},null,2)).toEqual([[]]);
  const route=routes[0];if(route===undefined)throw new Error(`${import.meta.path}:89: missing adapted route (${path})`);expect(routeListenerPorts(context,route.span)).toEqual([]);expect([...context.factGaps.values()].some(gap=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener'))).toBe(true);
 }
});

test('an embedded writer needs the exact composite declaration and address operator proofs',async()=>{
 const input=inputFor('Observe(mux)',observing);const shared=await extractCodeWithFacts(input);
 const literal=shared.facts.expressions.find(expression=>expression.syntaxKind==='composite_literal'&&expression.compositeType!==undefined&&shared.facts.expressions.find(type=>type.id===expression.compositeType?.typeExpression)?.name==='Observer');
 const address=literal===undefined?undefined:shared.facts.expressions.find(expression=>expression.syntaxKind==='unary_expression'&&expression.children.includes(literal.id));
 if(literal===undefined||address===undefined)throw new Error(`${import.meta.path}: embedded writer proofs missing (${path})
${JSON.stringify(shared.facts,null,2)}`);
 const variants=[
  shared.facts.expressions.map(expression=>expression.id===address.id?{...expression,operator:'-'}:expression),
  shared.facts.expressions.map(expression=>{if(expression.id!==literal.id)return expression;const {compositeType,...withoutProof}=expression;void compositeType;return withoutProof;}),
 ];
 for(const expressions of variants){
  const facts=freezeCodeFacts({...shared.facts,expressions});const context=new TreeText(input,shared.extraction,facts);const routes=structuralHttpRegistrations(context);
  expect(routes.map(route=>route.ports),JSON.stringify({test:import.meta.path,path,routes,gaps:[...context.factGaps.values()],facts},null,2)).toEqual([[]]);
 }
});

test.each(['Compose(Trace,Audit)(mux)','Compose(Trace,Observe)(mux)'])('a returned closure needs its exact body and parameter proofs despite a shared wrapper span: %s',async(returned)=>{
 const input=inputFor(returned,observing);const shared=await extractCodeWithFacts(input);
 const symbol=shared.facts.symbols.find(symbol=>symbol.callable&&symbol.bodySpan!==undefined&&shared.facts.expressions.some(expression=>expression.syntaxKind==='func_literal'&&expression.path===symbol.path&&expression.span.byteStart===symbol.span.byteStart&&expression.span.byteEnd===symbol.span.byteEnd&&(expression.fields.result??[]).length===1));
 const declaration=symbol===undefined?undefined:shared.facts.expressions.find(expression=>expression.syntaxKind==='func_literal'&&expression.path===symbol.path&&expression.span.byteStart===symbol.span.byteStart&&expression.span.byteEnd===symbol.span.byteEnd);
 const wrapper=declaration===undefined?undefined:shared.facts.expressions.find(expression=>expression.syntaxKind==='expression_list'&&expression.children.length===1&&expression.children[0]===declaration.id&&expression.span.byteStart===declaration.span.byteStart&&expression.span.byteEnd===declaration.span.byteEnd);
 const parameterList=declaration?.fields.parameters?.[0];const body=declaration?.fields.body?.[0];
 const diagnostic=JSON.stringify({test:import.meta.path,path,returned,symbol,declaration,wrapper,facts:shared.facts},null,2);
 if(declaration===undefined||wrapper===undefined||parameterList===undefined||body===undefined)throw new Error(`${import.meta.path}: missing returned closure declaration/body/parameter and same-span wrapper proofs (${path})
${diagnostic}`);
 expect(wrapper.span,diagnostic).toEqual(declaration.span);
 expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts)).map(route=>route.ports),diagnostic).toEqual([['7643']]);
 const variants=[
  shared.facts.expressions.filter(expression=>expression.id!==declaration.id),
  shared.facts.expressions.filter(expression=>expression.id!==body),
  shared.facts.expressions.filter(expression=>expression.id!==parameterList),
  shared.facts.expressions.map(expression=>{if(expression.id!==declaration.id)return expression;const {body,...fields}=expression.fields;void body;return {...expression,fields};}),
 ];
 for(const expressions of variants){
  const facts=freezeCodeFacts({...shared.facts,expressions});const context=new TreeText(input,shared.extraction,facts);const routes=structuralHttpRegistrations(context);
  expect(routes.map(route=>route.ports),JSON.stringify({test:import.meta.path,path,returned,routes,gaps:[...context.factGaps.values()],facts},null,2)).toEqual([[]]);
  const registration=routes[0];if(registration===undefined)throw new Error(`${import.meta.path}: missing route with incomplete returned closure proof (${path})`);
  expect(routeListenerPorts(context,registration.span)).toEqual([]);expect([...context.factGaps.values()].some(gap=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener'))).toBe(true);
 }
 expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts)).map(route=>route.ports),diagnostic).toEqual([['7643']]);
});

test.each(['Compose(Trace,Audit)(mux)','Compose(Trace,Observe)(mux)'])('composition disambiguates Go call indices only with exact collection and value proofs: %s',async(returned)=>{
 const input=inputFor(returned,observing);const shared=await extractCodeWithFacts(input);
 const parameter=shared.facts.expressions.find(expression=>expression.syntaxKind==='variadic_parameter_declaration');const name=shared.facts.expressions.find(expression=>expression.id===parameter?.fields.name?.[0]);
 const invocation=shared.facts.expressions.find(expression=>expression.syntaxKind==='call_expression'&&(expression.fields.type_arguments??[]).length===1&&shared.facts.expressions.some(callee=>callee.id===expression.callee&&callee.bindingId===name?.bindingId));
 const argumentsOf=shared.facts.expressions.find(expression=>expression.id===invocation?.fields.type_arguments?.[0]);const index=shared.facts.expressions.find(expression=>expression.id===argumentsOf?.children[0]);const callee=shared.facts.expressions.find(expression=>expression.id===invocation?.callee);
 const indexBinding=shared.facts.bindings.find(binding=>binding.id===index?.bindingId);const collectionBinding=shared.facts.bindings.find(binding=>binding.id===callee?.bindingId);const typeBinding=shared.facts.bindings.find(binding=>binding.kind==='type');
 const clause=shared.facts.expressions.find(expression=>expression.syntaxKind==='for_clause'&&expression.fields.initializer?.some(id=>shared.facts.expressions.some(initializer=>initializer.id===id&&initializer.span.byteStart===indexBinding?.declarationSpan?.byteStart&&initializer.span.byteEnd===indexBinding?.declarationSpan?.byteEnd)));
 const diagnostic=JSON.stringify({test:import.meta.path,path,returned,parameter,invocation,argumentsOf,index,indexBinding,collectionBinding,clause,facts:shared.facts},null,2);
 if(parameter===undefined||invocation===undefined||argumentsOf===undefined||index===undefined||callee===undefined||indexBinding===undefined||collectionBinding===undefined||typeBinding===undefined||clause===undefined)throw new Error(`${import.meta.path}: missing Go call-index ambiguity proofs (${path})
${diagnostic}`);
 expect(callee.syntaxKind,diagnostic).toBe('identifier');expect(argumentsOf.syntaxKind,diagnostic).toBe('type_arguments');expect(argumentsOf.children,diagnostic).toEqual([index.id]);expect(index.syntaxKind,diagnostic).toBe('type_identifier');expect(indexBinding.kind,diagnostic).toBe('local');expect(collectionBinding.kind,diagnostic).toBe('parameter');
 expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts)).map(route=>route.ports),diagnostic).toEqual([['7643']]);
 const variants=[
  {label:'missing index node',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.filter(expression=>expression.id!==index.id)})},
  {label:'missing type-arguments edge',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>{if(expression.id!==invocation.id)return expression;const {type_arguments,...fields}=expression.fields;void type_arguments;return {...expression,fields};})})},
  {label:'ambiguous type-arguments edge',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.id===invocation.id?{...expression,fields:{...expression.fields,type_arguments:[argumentsOf.id,argumentsOf.id]}}:expression)})},
  {label:'ambiguous index child',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.id===argumentsOf.id?{...expression,children:[index.id,index.id]}:expression)})},
  {label:'missing index value binding',facts:freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.filter(binding=>binding.id!==indexBinding.id)})},
  {label:'ambiguous index value binding',facts:freezeCodeFacts({...shared.facts,bindings:[...shared.facts.bindings,indexBinding]})},
  {label:'type argument instead of value index',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.id===index.id?{...expression,bindingId:typeBinding.id}:expression)})},
  {label:'missing collection binding',facts:freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.filter(binding=>binding.id!==collectionBinding.id)})},
  {label:'ambiguous collection binding',facts:freezeCodeFacts({...shared.facts,bindings:[...shared.facts.bindings,collectionBinding]})},
  {label:'nonvariadic collection declaration',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression.id===parameter.id?{...expression,syntaxKind:'parameter_declaration'}:expression)})},
  {label:'missing loop initializer edge',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>{if(expression.id!==clause.id)return expression;const {initializer,...fields}=expression.fields;void initializer;return {...expression,fields};})})},
  {label:'wrong index initializer identity',facts:freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.map(binding=>binding.id===indexBinding.id?{...binding,initializer:index.id}:binding)})},
 ];
 for(const {label,facts} of variants){
  const context=new TreeText(input,shared.extraction,facts);const routes=structuralHttpRegistrations(context);const evidence=JSON.stringify({test:import.meta.path,path,returned,label,routes,gaps:[...context.factGaps.values()],facts},null,2);
  expect(routes.map(route=>route.ports),evidence).toEqual([[]]);const route=routes[0];if(route===undefined)throw new Error(`${import.meta.path}: missing route with incomplete Go call-index proof (${path})
${evidence}`);
  expect(routeListenerPorts(context,route.span),evidence).toEqual([]);expect([...context.factGaps.values()].some(gap=>gap.path===path&&gap.reason.includes('line')&&gap.reason.includes('receiver/listener')),evidence).toBe(true);
 }
 expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts)).map(route=>route.ports),diagnostic).toEqual([['7643']]);
});

test.each([
 'if i>=0 {next=layers[i](next)}',
 'next=layers[i](next);next=h.NewServeMux()',
])('composition needs an exact single-write loop body: %s',async(body)=>{
 const original=inputFor('Compose(Trace,Audit)(mux)');const source=new TextDecoder().decode(original.read(path)).replace('next=layers[i](next)',body);
 const input=tree({'go.mod':new TextDecoder().decode(original.read('go.mod')),[path]:source});const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);const routes=structuralHttpRegistrations(context);
 expect(routes.map(route=>route.ports),JSON.stringify({test:import.meta.path,path,body,routes,gaps:[...context.factGaps.values()],facts:shared.facts},null,2)).toEqual([[]]);
});

test('a constructor result and active server need exact shared callable sites and matching declared receiver type',async()=>{
 const source=`package web
import h "net/http"
type Endpoint struct{}
type Rival struct{}
func Make() *Endpoint{return &Endpoint{}}
func Other() *Rival{return &Rival{}}
func (e *Endpoint) Routes() h.Handler {mux:=h.NewServeMux();mux.HandleFunc("GET /ready",Ready);return mux}
func Ready(w h.ResponseWriter,r *h.Request){}
func Start(){endpoint:=Make();server:=&h.Server{Addr:":7643",Handler:endpoint.Routes()};server.ListenAndServe()}
`;
 const input=tree({'go.mod':'module example.test/transport\n\ngo 1.23\n',[path]:source});const shared=await extractCodeWithFacts(input);const routes=structuralHttpRegistrations(new TreeText(input,shared.extraction,shared.facts));expect(routes.map(route=>route.ports)).toEqual([['7643']]);
 const invocation=shared.facts.calls.find(call=>shared.facts.expressions.find(expression=>expression.id===call.callee)?.member==='Routes');if(invocation===undefined)throw new Error(`${import.meta.path}:75: missing receiver call (${path})`);
 const callee=shared.facts.expressions.find(expression=>expression.id===invocation.callee);if(callee===undefined)throw new Error(`${import.meta.path}:76: missing receiver callee (${path})`);
 const missing=freezeCodeFacts({...shared.facts,sites:shared.facts.sites.filter(site=>!(site.use==='call'&&site.span.path===path&&callee.span.byteStart<=site.span.byteStart&&site.span.byteEnd<=callee.span.byteEnd))});expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,missing)).map(route=>route.ports)).toEqual([[]]);
 const other=tree({'go.mod':'module example.test/transport\n\ngo 1.23\n',[path]:source.replace('endpoint:=Make()','endpoint:=Other()')});const rival=await extractCodeWithFacts(other);expect(structuralHttpRegistrations(new TreeText(other,rival.extraction,rival.facts)).map(route=>route.ports)).toEqual([[]]);
});

const endpointPath='internal/web/endpoint.go';
const endpointInput=(returned:string)=>tree({
 'go.mod':'module example.test/transport\n\ngo 1.23\n',
 [endpointPath]:`package web
import h "net/http"
type Endpoint struct{}
type Rival struct{}
func Make() *Endpoint {return &Endpoint{}}
func (e *Endpoint) Create(w h.ResponseWriter,r *h.Request){}
func (e *Endpoint) Export(w h.ResponseWriter,r *h.Request){}
`,
 [path]:header+wrappers+`
type Deps struct{Orders *Endpoint}
func Routes(deps Deps) h.Handler {
 mux:=h.NewServeMux()
 mux.HandleFunc("POST /submit",deps.Orders.Create)
 mux.HandleFunc("GET /download",deps.Orders.Export)
 mux.HandleFunc("GET /direct",Make().Export)
 return ${returned}
}
func Start(){server:=&h.Server{Addr:":7643",Handler:Routes(Deps{})};server.ListenAndServe()}
`,
});

test.each(['mux','Compose(Trace,Audit)(mux)'])('cross-file declared field method values retain exact handler owners: %s',async(returned)=>{
 const input=endpointInput(returned);const shared=await extractCodeWithFacts(input);const context=new TreeText(input,shared.extraction,shared.facts);const routes=structuralHttpRegistrations(context);
 const diagnostic=JSON.stringify({test:import.meta.path,path,endpointPath,returned,routes,gaps:[...context.factGaps.values()],facts:shared.facts},null,2);
 expect(routes.map(route=>route.handler?.key),diagnostic).toEqual([`code.symbol:${endpointPath}#Endpoint.Create`,`code.symbol:${endpointPath}#Endpoint.Export`,`code.symbol:${endpointPath}#Endpoint.Export`]);
 expect(routes.map(route=>route.ports),diagnostic).toEqual([['7643'],['7643'],['7643']]);
 for(const route of routes){const handler=route.handler;if(handler===undefined)throw new Error(`${import.meta.path}: missing canonical method-value handler (${path})\n${diagnostic}`);expect(handler.path,diagnostic).toBe(endpointPath);expect(shared.facts.symbols.some(symbol=>symbol.callable&&symbol.key===handler.key&&symbol.span.byteStart===handler.span.byteStart&&symbol.span.byteEnd===handler.span.byteEnd),diagnostic).toBe(true);}
 const field=shared.facts.fields?.find(field=>field.path===path&&field.name==='Orders');const pointer=shared.facts.expressions.find(expression=>expression.id===field?.typeExpression);const type=shared.facts.expressions.find(expression=>expression.id===pointer?.children[0]);
 const site=type===undefined?undefined:shared.facts.sites.find(site=>site.use==='type'&&site.path===path&&site.span.byteStart===type.span.byteStart&&site.span.byteEnd===type.span.byteEnd);
 const symbol=site===undefined?undefined:shared.facts.symbols.find(symbol=>symbol.key===site.to&&!symbol.callable);
 const binding=symbol===undefined?undefined:shared.facts.bindings.find(binding=>binding.kind==='type'&&binding.path===symbol.path&&binding.typeDeclaration?.declarationSpan.byteStart===symbol.span.byteStart&&binding.typeDeclaration.declarationSpan.byteEnd===symbol.span.byteEnd);
 const declaration=shared.facts.expressions.find(expression=>expression.id===binding?.typeDeclaration?.expression);const name=shared.facts.expressions.find(expression=>expression.id===binding?.typeDeclaration?.nameExpression);
 const receiver=shared.facts.symbols.find(symbol=>symbol.key===routes[0]?.handler?.key)?.receiver;
 const rival=shared.facts.bindings.find(binding=>binding.path===endpointPath&&binding.kind==='type'&&binding.name==='Rival');
 const clause=shared.facts.expressions.find(expression=>expression.path===endpointPath&&expression.syntaxKind==='package_clause');const packageName=shared.facts.expressions.find(expression=>expression.id===clause?.children[0]);
 if(type===undefined||site===undefined||symbol===undefined||binding===undefined||declaration===undefined||name===undefined||receiver===undefined||rival===undefined||packageName===undefined)throw new Error(`${import.meta.path}: missing cross-file method-value proofs (${path}, ${endpointPath})
${diagnostic}`);
 expect(type.bindingId,diagnostic).toBeUndefined();expect(symbol.path,diagnostic).toBe(endpointPath);expect(pointer?.syntaxKind,diagnostic).toBe('pointer_type');
 const variants=[
  {label:'missing exact type-use site',facts:freezeCodeFacts({...shared.facts,sites:shared.facts.sites.filter(entry=>entry!==site)})},
  {label:'ambiguous exact type-use site',facts:freezeCodeFacts({...shared.facts,sites:[...shared.facts.sites,site]})},
  {label:'missing canonical type symbol',facts:freezeCodeFacts({...shared.facts,symbols:shared.facts.symbols.filter(entry=>entry!==symbol)})},
  {label:'ambiguous canonical type symbol',facts:freezeCodeFacts({...shared.facts,symbols:[...shared.facts.symbols,symbol]})},
  {label:'missing direct type binding',facts:freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.filter(entry=>entry!==binding)})},
  {label:'ambiguous direct type binding',facts:freezeCodeFacts({...shared.facts,bindings:[...shared.facts.bindings,binding]})},
  {label:'missing type declaration',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.filter(entry=>entry!==declaration)})},
  {label:'missing declaration-name identity',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(entry=>{if(entry!==name)return entry;const {bindingId,...rest}=entry;void bindingId;return rest;})})},
  {label:'explicit missing binding cannot borrow type site',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(entry=>entry===type?{...entry,bindingId:'missing-type-binding'}:entry)})},
  {label:'explicit wrong binding cannot borrow type site',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(entry=>entry===type?{...entry,bindingId:rival.id}:entry)})},
  {label:'conflicting package-clause identity',facts:freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(entry=>entry===packageName?{...entry,name:'other'}:entry)})},
 ];
 for(const {label,facts} of variants){
  const changed=structuralHttpRegistrations(new TreeText(input,shared.extraction,facts));const evidence=JSON.stringify({test:import.meta.path,path,endpointPath,returned,label,routes:changed,facts},null,2);
  expect(changed, evidence).toHaveLength(3);expect(changed.slice(0,2).map(route=>route.handler?.key),evidence).toEqual([undefined,undefined]);
  expect(changed.map(route=>route.ports),evidence).toEqual([['7643'],['7643'],['7643']]);
 }
 const missingReceiver=freezeCodeFacts({...shared.facts,bindings:shared.facts.bindings.filter(binding=>binding.id!==receiver.bindingId)});
 expect(structuralHttpRegistrations(new TreeText(input,shared.extraction,missingReceiver)).slice(0,2).map(route=>route.handler?.key),diagnostic).toEqual([undefined,`code.symbol:${endpointPath}#Endpoint.Export`]);
 const constructor=shared.facts.calls.find(call=>call.path===path&&shared.facts.expressions.some(expression=>expression.id===call.callee&&expression.name==='Make'));
 const callee=shared.facts.expressions.find(expression=>expression.id===constructor?.callee);const constructorSite=callee===undefined?undefined:shared.facts.sites.find(site=>site.use==='call'&&site.path===path&&site.span.byteStart===callee.span.byteStart&&site.span.byteEnd===callee.span.byteEnd);
 const constructorDeclaration=constructorSite===undefined?undefined:shared.facts.symbols.find(symbol=>symbol.key===constructorSite.to&&symbol.callable);
 const result=shared.facts.expressions.find(expression=>expression.syntaxKind==='unary_expression'&&expression.path===endpointPath&&constructorDeclaration!==undefined&&constructorDeclaration.span.byteStart<=expression.span.byteStart&&expression.span.byteEnd<=constructorDeclaration.span.byteEnd);
 if(constructorSite===undefined||result===undefined)throw new Error(`${import.meta.path}: missing direct constructor method-value proofs (${path}, ${endpointPath})\n${diagnostic}`);
 const constructorVariants=[
  freezeCodeFacts({...shared.facts,sites:shared.facts.sites.filter(site=>site!==constructorSite)}),
  freezeCodeFacts({...shared.facts,expressions:shared.facts.expressions.map(expression=>expression===result?{...expression,operator:'-'}:expression)}),
 ];
 for(const facts of constructorVariants){const changed=structuralHttpRegistrations(new TreeText(input,shared.extraction,facts));expect(changed.map(route=>route.handler?.key),JSON.stringify({test:import.meta.path,path,endpointPath,returned,routes:changed,facts},null,2)).toEqual([`code.symbol:${endpointPath}#Endpoint.Create`,`code.symbol:${endpointPath}#Endpoint.Export`,undefined]);}
});
