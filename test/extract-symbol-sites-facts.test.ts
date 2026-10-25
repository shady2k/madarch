import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import type {CodeFacts} from '../src/extract/code/facts.js';
import {Records} from '../src/extract/operations/accumulate.js';
import {TreeText} from '../src/extract/operations/source.js';
import {functionAt, functionNode, functionsOf} from '../src/extract/operations/symbol-sites.js';
import type {TreeReader} from '../src/extract/records.js';

const treeOf = (files: Readonly<Record<string,string>>): TreeReader => ({paths:Object.keys(files).sort(),read:(path)=>{
  const source=files[path]; if(source===undefined)throw new Error(`missing fixture ${path}`); return new TextEncoder().encode(source);
}});

test('canonical callable sites preserve named, method, expression arrow and innermost callback identities', async()=>{
  const path='lib/work.ts';
  const source='const label="éλ"; export function outer(){ const short=()=>1; setTimeout(()=>{consume(label)},0); } export class Unit { method(){return 2;} }';
  const tree=treeOf({[path]:source}); const code=await extractCodeWithFacts(tree); const context=new TreeText(tree,code.extraction,code.facts);
  const sites=functionsOf(context,path); expect(sites.length).toBeGreaterThanOrEqual(4);
  const arrow=sites.find((site)=>source.slice(site.bodyStart,site.end)==='1');
  expect(arrow?.bodySyntaxKind).toBe('number');
  const outer=sites.find((site)=>site.qualifiedName==='outer'); expect(outer).toBeDefined();
  const callback=functionAt(context,path,source.indexOf('consume(label)'));
  expect(callback).toBeDefined(); expect(callback?.key).not.toBe(outer?.key);
  const call=code.facts.calls.find((call)=>new TextDecoder().decode(tree.read(path).subarray(call.span.byteStart,call.span.byteEnd))==='consume(label)');
  expect(callback?.key).toBe(call?.holder);
  for(const site of sites){
    const symbol=code.facts.symbols.find((symbol)=>symbol.key===site.key)!;
    expect(site.span).toEqual(symbol.span); expect(site.symbolKind).toBe(symbol.symbolKind);
    expect(source.slice(site.start,site.end)).toBe(new TextDecoder().decode(tree.read(path).subarray(site.span.byteStart,site.span.byteEnd)));
    const records=new Records(context); expect(functionNode(records,site)).toBe(symbol.key);
    expect(records.nodes.find((node)=>node.key===symbol.key)?.properties.symbolKind).toBe(symbol.symbolKind);
    expect(records.nodes.find((node)=>node.key===symbol.key)?.properties.language).toBe('typescript');
  }
  expect(context.factGaps.size).toBe(0);
});

test('Go pointer receiver metadata comes from its exact AST binding, not qualified-name spelling',async()=>{
  const path='engine/server.go'; const source='package engine\ntype Unit struct {}\nfunc (service *Unit) Serve(){ consume() }';
  const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);const context=new TreeText(tree,code.extraction,code.facts);
  const method=functionsOf(context,path).find((site)=>site.name==='Serve');
  expect(method?.receiver).toBe('service');expect(method?.receiverType).toBe('Unit');expect(method?.symbolKind).toBe('method');
  const symbol=code.facts.symbols.find((symbol)=>symbol.key===method?.key);const receiver=code.facts.bindings.find((binding)=>binding.id===symbol?.receiver?.bindingId);
  expect(receiver?.name).toBe('service');expect(receiver?.span.path).toBe(path);
});

test('missing facts, abstract/overload bodies, malformed receiver and UTF-8 boundaries gap without source fallback',async()=>{
  const path='lib/work.ts';const tree=treeOf({[path]:'const label="éλ"; export function actual(){return 1;}'});const code=await extractCodeWithFacts(tree);
  const absent=new TreeText(tree,code.extraction);expect(functionsOf(absent,path)).toEqual([]);expect(absent.factGaps.size).toBe(1);
  const symbol=code.facts.symbols.find((entry)=>entry.name==='actual')!;expect(symbol.bodySpan).toBeDefined();
  const variants:CodeFacts[]=[
    {...code.facts,symbols:code.facts.symbols.map((entry)=>entry.key===symbol.key?{...entry,bodySpan:undefined}:entry)},
    {...code.facts,symbols:code.facts.symbols.map((entry)=>entry.key===symbol.key?{...entry,receiver:{bindingId:'missing',name:'fake'}}:entry)},
    {...code.facts,symbols:[...code.facts.symbols,symbol]},
    {...code.facts,symbols:code.facts.symbols.map((entry)=>entry.key===symbol.key?{...entry,span:{...entry.span,byteStart:14}}:entry)},
  ];
  for(const facts of variants){const context=new TreeText(tree,code.extraction,facts);expect(functionsOf(context,path)).toEqual([]);expect(context.factGaps.size).toBeGreaterThan(0);}
  const declarationTree=treeOf({'lib/shapes.ts':'export function overload(value:string):string; export function overload(value:string){return value;} export abstract class Base { abstract run():void; }'});
  const declarations=await extractCodeWithFacts(declarationTree);const context=new TreeText(declarationTree,declarations.extraction,declarations.facts);
  functionsOf(context,'lib/shapes.ts');expect([...context.factGaps.values(),...declarations.facts.gaps].some((gap)=>gap.reason.includes('no proved body')||gap.reason.includes('duplicate callable')||gap.reason.includes('no body'))).toBe(true);
});


test('unsupported inner callables remain ownership tombstones instead of lending their bodies to an outer function',async()=>{
  const path='lib/nested.ts';const source='export function outer(){ setTimeout(()=>{consume()},0); }';const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);
  const at=source.indexOf('consume()');const valid=new TreeText(tree,code.extraction,code.facts);const inner=functionAt(valid,path,at)!;expect(inner).toBeDefined();
  const variants:CodeFacts[]=[
    {...code.facts,symbols:code.facts.symbols.map((symbol)=>symbol.key===inner.key?{...symbol,bodySpan:undefined}:symbol)},
    {...code.facts,symbols:[...code.facts.symbols,...code.facts.symbols.filter((symbol)=>symbol.key===inner.key)]},
    {...code.facts,symbols:code.facts.symbols.map((symbol)=>symbol.key===inner.key?{...symbol,receiver:{bindingId:'missing',name:'no'}}:symbol)},
  ];
  for(const facts of variants){const context=new TreeText(tree,code.extraction,facts);expect(functionAt(context,path,at)).toBeUndefined();expect(context.factGaps.size).toBeGreaterThan(0);}
  expect(functionAt(valid,path,source.indexOf('outer'))).toBeUndefined();
  expect(functionAt(valid,path,-1)).toBeUndefined();expect(functionAt(valid,path,source.length)).toBeUndefined();
});

test('duplicate or out-of-scope receiver binding facts cannot prove method ownership',async()=>{
  const path='engine/owner.go';const source='package owner\ntype Unit struct{}\nfunc (unit *Unit) Run(){consume()}';const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);
  const symbol=code.facts.symbols.find((entry)=>entry.name==='Run')!;const binding=code.facts.bindings.find((entry)=>entry.id===symbol.receiver?.bindingId)!;expect(binding).toBeDefined();
  const variants:CodeFacts[]=[
    {...code.facts,bindings:[...code.facts.bindings,binding]},
    {...code.facts,bindings:code.facts.bindings.map((entry)=>entry.id===binding.id?{...entry,scope:{...entry.scope,byteEnd:entry.scope.byteStart}}:entry)},
  ];
  for(const facts of variants){const context=new TreeText(tree,code.extraction,facts);expect(functionAt(context,path,source.indexOf('consume()'))).toBeUndefined();expect(context.factGaps.size).toBeGreaterThan(0);}
});
