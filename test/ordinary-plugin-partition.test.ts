import {expect,test} from 'bun:test';
import type {KeyValues} from 'madarch-plugin-sdk';
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
 const GROUP_BYTES=1_000_000;
 /** The pre-search pass, kept whole as the oracle: the longest run from each key that stays within the bound. */
 const greedy=(vertices:readonly {readonly key:{readonly path:string}}[],sizeOf:(start:number,end:number)=>number)=>{
  const groups:{readonly path:string}[][]=[];
  for(let start=0;start<vertices.length;){
   let end=start;
   while(end+1<vertices.length&&sizeOf(start,end+1)<=GROUP_BYTES)end+=1;
   groups.push(vertices.slice(start,end+1).map(vertex=>vertex.key));
   start=end+1;
  }
  return groups;
 };
 /** Every partition's keys, page by page, as the host reads them. */
 const planned=async(output:ReturnType<typeof partitioned>)=>{
  const groups:KeyValues[][]=[];
  let cursor:string|undefined;
  for(;;){
   const page=await output.planOutput(unit,context,cursor);
   groups.push(...page.partitions.map(partition=>partition.keys));
   cursor=page.next;
   if(cursor===undefined)return groups;
  }
 };
 const sized=(lengths:readonly number[])=>{
  const vertices=lengths.map((length,at)=>({kind:'File',key:{path:`k${String(at).padStart(2,'0')}`},values:{text:'x'.repeat(length)}}));
  const sizeOf=(start:number,end:number)=>Buffer.byteLength(JSON.stringify({end:{state:'complete'},vertices:vertices.slice(start,end+1),edges:[]}));
  return {vertices,sizeOf};
 };
 test(`${name} groups keys of varied sizes exactly as the linear greedy pass does, binary phase included`,async()=>{
  const cycle=[110000,35000,80000,50000,95000,40000,125000,60000,30000,70000];
  const {vertices,sizeOf}=sized([...cycle,...cycle,...cycle]);
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices,edges:[]}));
  const actual=await planned(output);
  expect(actual).toEqual(greedy(vertices,sizeOf));
  expect(actual.length).toBeGreaterThan(1);
  // The exponential phase passes at least one boundary before the binary phase finds it, so this run exercises both.
  let overshoot=false;
  for(let start=0;start<vertices.length;){
   let end=start;
   while(end+1<vertices.length&&sizeOf(start,end+1)<=GROUP_BYTES)end+=1;
   let good=start,step=1;
   while(start+step<vertices.length&&sizeOf(start,start+step)<=GROUP_BYTES){good=start+step;step*=2;}
   if(step>1&&good>start&&end>good)overshoot=true;
   start=end+1;
  }
  expect(overshoot).toBe(true);
 });
 test(`${name} keeps a key whose own group exceeds the bound as a group of one`,async()=>{
  const {vertices,sizeOf}=sized([50000,50000,50000,50000,50000,50000,50000,50000,50000,50000,1400000,45000,45000,45000,45000,45000,45000,45000,45000,45000,45000,45000]);
  const output=partitioned(async()=>({end:{state:'complete' as const},vertices,edges:[]}));
  const actual=await planned(output);
  expect(actual).toEqual(greedy(vertices,sizeOf));
  expect(actual.find(group=>group.some(key=>key.path==='k10'))).toEqual([{path:'k10'}]);
 });
}
