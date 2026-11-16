import {expect,test} from 'bun:test';
import {partitioned as disk} from '../plugins/disk/partition.js';
import {partitioned as git} from '../plugins/git/partition.js';

for(const [name,partitioned] of [['disk',disk],['git',git]] as const){
 const file=(path:string)=>({kind:'File',key:{path}});
 const blob=(digest:string)=>({kind:'Support',key:{digest}});
 const repository={kind:'Repository',key:{name:'fixture'}};
 const unused=async():Promise<never>=>{throw new Error('partition helper must not call the host');};
 const context:Parameters<Parameters<typeof disk>[0]>[1]={signal:new AbortController().signal,progress:()=>{},heartbeat:()=>{},facts:{apply:unused},reconcile:unused,agent:unused,read:unused,graph:{ownFacts:unused,files:unused,value:unused,removedEnds:unused,unevidenced:unused}};
 const unit:Parameters<Parameters<typeof disk>[0]>[0]={unitId:'files',kind:'File',key:{},inputs:{}};
 const fixture=()=>({end:{state:'complete' as const},vertices:[{...file('a'),evidence:{target:blob('a')}},{...file('b'),evidence:{target:blob('b')}},{...blob('a'),values:{content:'a'}},{...blob('b'),values:{content:'b'}},{...blob('inventory'),values:{content:'inventory'}}],edges:[{kind:'contains',from:repository,to:file('a'),evidence:{target:blob('inventory')}},{kind:'contains',from:repository,to:file('b'),evidence:{target:blob('inventory')}},{kind:'about',from:blob('inventory'),to:repository},{kind:'about',from:blob('a'),to:file('a')},{kind:'about',from:blob('b'),to:file('b')}]});
 test(`${name} partitions only output keys and carries referenced evidence support`,async()=>{
  const output=partitioned(async()=>fixture());
  expect((await output.planOutput(unit,context)).partitions).toEqual([{keys:[{path:'a'},{path:'b'}]}]);
  const selected=await output.extract({...unit,inputs:{keys:[{path:'a'}]}},context);
  expect(selected.vertices?.map(vertex=>[vertex.kind,vertex.key])).toEqual([['File',{path:'a'}],['Support',{digest:'a'}],['Support',{digest:'inventory'}]]);
  expect(selected.edges?.map(edge=>[edge.kind,edge.from.key,edge.to.key])).toEqual([['contains',{name:'fixture'},{path:'a'}],['about',{digest:'inventory'},{name:'fixture'}],['about',{digest:'a'},{path:'a'}]]);
 });
 test(`${name} refuses an ordinary edge without output or referenced support`,async()=>{
  const output=partitioned(async()=>({...fixture(),edges:[...fixture().edges,{kind:'unrelated',from:repository,to:{kind:'Other',key:{id:'outside'}}}]}));
  await expect(output.planOutput(unit,context)).rejects.toThrow('no output identity or referenced support');
 });
 test(`${name} counts required support bytes in each bounded group`,async()=>{
  const shared=blob('shared');
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices:[{...file('a'),values:{text:'a'.repeat(300000)},evidence:{target:shared}},{...file('b'),values:{text:'b'.repeat(300000)},evidence:{target:shared}},{...shared,values:{content:'s'.repeat(600000)}}],edges:[]}));
  expect((await output.planOutput(unit,context)).partitions).toEqual([{keys:[{path:'a'}]},{keys:[{path:'b'}]}]);
 });
}
