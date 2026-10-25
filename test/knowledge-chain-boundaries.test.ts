import {expect, test} from 'bun:test';
import {createPGliteDatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore,type GraphId} from '../src/graph/index.js';
import {GraphReader} from '../src/knowledge/graph-read.js';
import {ChainBuilder} from '../src/knowledge/diagrams.js';
import type {RenderContext} from '../src/knowledge/blocks.js';
import {parseKinds} from '../src/knowledge/kinds.js';
import {Resolver} from '../src/knowledge/resolve.js';

test('final 1: route entry uses actual handled-by; callback references stay unordered with a range',async()=>{
 const owner=createPGliteDatabaseOwner({btreeGist:true});await owner.ready;
 try {
  const store=createGraphStore(owner,{now:()=>new Date('2026-06-01T00:00:00Z')});await store.createSchema();
  await store.registerCodeSchema({kinds:['code.route'],relations:[{key:'code.handled-by'},{key:'code.references',discriminated:true}]});
  const scope=await store.newNode();const owned={producer:'code.extract.code',scope};const time='2026-01-01T00:00:00Z';
  const span={path:'services/api/main.ts',byteStart:0,byteEnd:100,lineStart:1,lineEnd:10};
  const add=async(key:string,kind:string,label:string,start=0,end=100,file=span.path)=>store.openNode({kind,label,properties:{recordKey:key,symbolKind:'function',qualifiedName:label,span:{...span,path:file,byteStart:start,byteEnd:end}},validFrom:time,owner:owned});
  const registrar=await add('code.symbol:services/api/main.ts#setup','code.symbol','setup');
  const callback=await add('code.symbol:services/api/main.ts#callback','code.symbol','callback',20,80);
  const target=await add('code.symbol:services/api/helper.ts#target','code.symbol','target',0,100,'services/api/helper.ts');
  const unrelated=await add('code.symbol:services/api/main.ts#unrelated','code.symbol','unrelated',90,95);
  const route=await add('code.route:services/api/main.ts#GET:/healthz','code.route','GET /healthz',10,85);
  const link=async(relation:string,from:GraphId,to:GraphId,properties:Record<string,unknown>={},discriminator?:string)=>store.openEdge({relation,src:from,dst:to,properties:{...properties,span:{...span,byteStart:20,byteEnd:80}},validFrom:time,owner:owned,...(discriminator===undefined?{}:{discriminator})});
  await link('code.handled-by',route.nodeId,callback.nodeId);
  await link('code.references',registrar.nodeId,callback.nodeId,{role:'callback-value'},'20');
  await link('code.references',registrar.nodeId,unrelated.nodeId,{},'90');
  await link('code.calls',callback.nodeId,target.nodeId);
  const graph=new GraphReader(owner,()=> '2026-06-01T00:00:00Z');const manifest=parseKinds('kinds: {}','kinds.yaml','.');
  const ctx:RenderContext={productFolder:'.',manifest,graph,markdown:new Map(),docEntities:new Map(),localizedSources:new Map(),language:'en',documents:[],repositories:[],commitOf:()=>null,repoOfScope:()=>undefined,readSource:async()=>undefined,resolver:new Resolver({graph,markdown:new Map(),declared:()=>true,readDocument:async()=>undefined,repositories:()=>[],locate:()=>undefined})};
  const [registered]=await graph.find('code.route:services/api/main.ts#GET:/healthz');const [setup]=await graph.find('code.symbol:services/api/main.ts#setup');if(registered===undefined||setup===undefined)throw new Error('missing declared fixture');
  const routeChain=new ChainBuilder(ctx,{limit:50,depth:5});expect((await routeChain.handlersOf(registered)).map((entity)=>entity.label)).toEqual(['callback']);await routeChain.enterRoute(registered,5);await routeChain.finish(4);expect(routeChain.steps.some((step)=>step.label==='callback'&&step.order==='source')).toBe(false);expect(routeChain.steps.some((step)=>step.label==='unrelated')).toBe(false);expect(routeChain.steps.some((step)=>step.label==='target')).toBe(true);
  for(const ranged of [false,true]){const builder=new ChainBuilder(ctx,{limit:50,depth:5});await builder.visit(setup,5,ranged?{lineStart:1,lineEnd:10}:undefined);await builder.finish(4);expect(builder.steps.filter((step)=>step.label==='callback').map((step)=>step.order)).toEqual(['unordered']);expect(builder.steps.some((step)=>step.label==='unrelated')).toBe(false);expect(builder.steps.filter((step)=>step.label==='target').map((step)=>step.order)).toEqual(['unordered']);}
 }finally{await owner.close();}
},20_000);
