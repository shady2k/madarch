import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stringify} from 'yaml';
import {writeFolderManifest} from './catalog-folder-fixture.js';
import {readKinds} from '../src/product/manifest/kinds.js';
import {graphContractOf} from '../src/fill/stages/plugin-contract.js';
import {closureOf} from '../src/plugin/closure.js';
import {runPluginTurn} from '../src/fill/plugin-turns.js';
import {createTestDatabaseOwner} from './test-database.js';
import {partitioned as gitPartitioned} from '../plugins/git/partition.js';
import {partitioned as diskPartitioned} from '../plugins/disk/partition.js';

const ref=(hash:string)=>({kind:'code.commit',key:{hash}});
const vertex={...ref('parent'),values:{message:'parent'}};
const connecting={kind:'code.parent',from:ref('selected'),to:ref('parent')};
const foreign={kind:'foreign',key:{id:'outside'},values:{message:'foreign'}};
const cases=[
 {name:'permits an ordinary add inside selected partition key',immutable:false,support:false,vertices:[{...ref('selected'),values:{message:'selected'}}],edges:[],allowed:true},
 {name:'permits an ordinary removal inside selected partition key',immutable:false,support:false,vertices:[],edges:[],removals:[ref('selected')],allowed:true},
 {name:'refuses reverse witness from support into selected key',immutable:true,support:true,vertices:[vertex],edges:[{...connecting,from:ref('parent'),to:ref('selected')}],allowed:false},
 {name:'refuses mutable own-kind support after an immutable foreign contract',immutable:false,support:true,foreign:true,foreignSupport:false,firstForeign:true,vertices:[vertex],edges:[connecting],allowed:false},
 {name:'refuses foreign vertex outside partition without support declaration',immutable:true,support:true,foreign:true,foreignSupport:false,vertices:[foreign],edges:[],allowed:false},
 {name:'permits declared foreign support',immutable:true,support:true,foreign:true,foreignSupport:true,vertices:[foreign],edges:[],allowed:true},
 {name:'refuses foreign witness instead of selected source',immutable:true,support:true,foreign:true,foreignSupport:true,vertices:[vertex],edges:[{kind:'foreign-parent',from:{kind:'foreign',key:{id:'witness'}},to:ref('parent')}],allowed:false},
 {name:'refuses unrelated D beside connected B to A',immutable:true,support:true,vertices:[vertex,{...ref('unrelated-D'),values:{message:'unrelated'}}],edges:[connecting],allowed:false},
 {name:'permits connected immutable own-kind support',immutable:true,support:true,vertices:[vertex],edges:[connecting],allowed:true},
 {name:'refuses support without a connecting edge',immutable:true,support:true,vertices:[vertex],edges:[],allowed:false},
 {name:'refuses support without immutable contract',immutable:false,support:true,vertices:[vertex],edges:[connecting],allowed:false},
 {name:'refuses support without own-kind declaration',immutable:true,support:false,vertices:[vertex],edges:[connecting],allowed:false},
 {name:'refuses removal outside the partition',immutable:true,support:true,vertices:[],edges:[connecting],removals:[ref('parent')],allowed:false},
 {name:'refuses an edge from outside the partition',immutable:true,support:true,vertices:[vertex],edges:[{...connecting,from:ref('outside')}],allowed:false},
];
for(const scenario of cases)test(scenario.name,async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-partition-permission-'));
 const owner=await createTestDatabaseOwner();
 try{
  const plugin=join(root,'plugins/history');mkdirSync(plugin,{recursive:true});mkdirSync(join(root,'madarch'),{recursive:true});
  const fields=['hash','message'].map(name=>({name,type:'text',meaning:name,example:name,required:true}));
  const labels={en:{out:'parent',in:'child'},ru:{out:'parent',in:'child'}};
  const outputs={vertices:[{kind:'code.commit',key:['hash'],fields,evidence:{immutable:true,digestField:'hash'}}],edges:[{kind:'code.parent',from:'code.commit',to:'code.commit',cardinality:{from:'many',to:'many'},labels}]};
  if('foreign' in scenario){outputs.vertices.push({kind:'foreign',key:['id'],fields:[{name:'id',type:'text',meaning:'id',example:'outside',required:true},{name:'message',type:'text',meaning:'message',example:'foreign',required:true}],evidence:{immutable:true,digestField:'id'}});outputs.edges.push({kind:'foreign-parent',from:'foreign',to:'code.commit',cardinality:{from:'many',to:'many'},labels});}
  if('firstForeign' in scenario)outputs.vertices.reverse();
  writeFileSync(join(plugin,'plugin.json'),JSON.stringify({name:'history',version:'1.0.0',entry:'main.ts',runtime:{name:'bun',version:Bun.version},produces:[...('foreign' in scenario?[{kind:'foreign',fields:'*',reads:[]}]:[]),{kind:'code.commit',fields:'*',reads:[],partition:'key',...(scenario.support?{support:{vertices:['code.commit',...('foreignSupport' in scenario&&scenario.foreignSupport?['foreign']:[])],edges:('foreignSupport' in scenario&&scenario.foreignSupport?['foreign-parent']:[])}}:{})}]}));
  writeFileSync(join(plugin,'contract.json'),JSON.stringify({id:'history',version:'1.0.0',outputs,rights:{network:'none',graph:true,graphReads:['files','value','ownFacts']}}));
  const operation={vertices:scenario.vertices,edges:scenario.edges,...('removals' in scenario?{removals:scenario.removals}:{})};
  writeFileSync(join(plugin,'main.ts'),`import {definePlugin} from 'madarch-plugin-sdk';await definePlugin({name:'history',version:'1.0.0',contract:${JSON.stringify(outputs)},async extract(unit,context){await context.facts.apply('facts',${JSON.stringify(operation)});return {end:{state:'complete'}};}});`);
  writeFolderManifest(root,stringify({language:'en',kinds:{...('foreign' in scenario?{foreign:{source:'graph',key:['id'],fields:['id','message'].map(name=>({name,type:'text',producers:['history']})),evidence:{immutable:true,digestField:'id'}}}:{}),'code.commit':{source:'graph',key:['hash'],fields:['hash','message'].map(name=>({name,type:'text'})),...(scenario.immutable?{evidence:{immutable:true,digestField:'hash'}}:{})}},edges:[...('foreign' in scenario?[{name:'foreign-parent',from:['foreign'],to:['code.commit'],cardinality:{from:{min:0,max:null},to:{min:0,max:null}},labels}]:[]),{name:'code.parent',from:['code.commit'],to:['code.commit'],cardinality:{from:{min:0,max:null},to:{min:0,max:null}},labels}],plugins:[{id:'history',version:1,path:'plugins/history',inputs:[],outputs:['code.commit',...('foreign' in scenario?['foreign']:[])],closure:['plugins/history/plugin.json','plugins/history/contract.json','plugins/history/main.ts']}]}));
  const closure=closureOf(plugin).hash;
  writeFileSync(join(root,'madarch/plugins.lock'),stringify({plugins:[{id:'history',path:'plugins/history',version:'1.0.0',closure}]}));
  const read=readKinds(root);if(!read.present)throw new Error(`${root}/madarch/catalog.yaml:1: manifest missing`);
  if(read.manifest.findings.length)throw new Error(JSON.stringify(read.manifest.findings));
  if(!scenario.immutable){
   const output=read.manifest.plugins!.get('history')!.contract!.vertices.find(vertex=>vertex.kind==='code.commit')!;
   delete (output as {evidence?:unknown}).evidence;
  }
  let admitted=0;
  const run=runPluginTurn({productFolder:root,manifest:read.manifest,locks:new Map([['history',{id:'history',path:'plugins/history',version:'1.0.0',closure,line:1}]]),owner,snapshots:{pins:async()=>[],open:async()=>{throw new Error('no repository access expected');}},contract:graphContractOf(read.manifest),releaseHashes:[closure],sourceUid:'fixture',executeOperation:async(_unit,key)=>{if(key==='facts')admitted++;return {} as never;}},'history:code.commit',()=>{},undefined,undefined,{files:async()=>[],value:async()=>undefined},undefined,{keys:[{hash:'selected'}]});
  if(scenario.allowed){await run;expect(admitted).toBe(1);}
  else{await expect(run).rejects.toThrow('foreignSupport' in scenario&&!scenario.foreignSupport&&scenario.vertices.some(vertex=>vertex.kind==='foreign')?/plugins\/history\/plugin.json:\d+: vertices\[0\]\.kind: vertices\[0\]\.kind: the plugin declares no vertex kind "foreign"; it declares code\.commit/:/plugins\/history\/plugin.json:\d+: operation writes outside selected partition keys/);expect(admitted).toBe(0);}
 }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
},20_000);

for(const [name,partitioned] of [['git',gitPartitioned],['disk',diskPartitioned]] as const)test(`${name} includes full same-kind endpoint support`,async()=>{
 const output=partitioned(async()=>({end:{state:'complete'},vertices:[{...ref('selected'),values:{message:'selected'}},vertex],edges:[connecting]}));
 const unused=async():Promise<never>=>{throw new Error('partition helper must not call host');};
 const context:Parameters<Parameters<typeof gitPartitioned>[0]>[1]={signal:new AbortController().signal,progress:()=>{},heartbeat:()=>{},facts:{apply:unused},reconcile:unused,agent:unused,read:unused,graph:{ownFacts:unused,files:unused,value:unused,removedEnds:unused,unevidenced:unused}};
 const selected=await output.extract({unitId:'commits',kind:'code.commit',key:{},inputs:{keys:[{hash:'selected'}]}},context);
 expect(selected.vertices).toEqual([{...ref('selected'),values:{message:'selected'}},vertex]);
 expect(selected.edges).toEqual([connecting]);
});

for(const [name,partitioned] of [['git',gitPartitioned],['disk',diskPartitioned]] as const)test(`${name} excludes a foreign endpoint that is not evidence support`,async()=>{
 const foreign={kind:'foreign',key:{id:'endpoint'},values:{message:'not evidence'}};
 const edge={kind:'foreign-link',from:ref('selected'),to:{kind:'foreign',key:{id:'endpoint'}}};
 const output=partitioned(async()=>({end:{state:'complete'},vertices:[{...ref('selected'),values:{message:'selected'}},foreign],edges:[edge]}));
 const unused=async():Promise<never>=>{throw new Error('partition helper must not call host');};
 const context:Parameters<Parameters<typeof gitPartitioned>[0]>[1]={signal:new AbortController().signal,progress:()=>{},heartbeat:()=>{},facts:{apply:unused},reconcile:unused,agent:unused,read:unused,graph:{ownFacts:unused,files:unused,value:unused,removedEnds:unused,unevidenced:unused}};
 const selected=await output.extract({unitId:'commits',kind:'code.commit',key:{},inputs:{keys:[{hash:'selected'}]}},context);
 expect(selected.vertices).toEqual([{...ref('selected'),values:{message:'selected'}}]);
 expect(selected.edges).toEqual([edge]);
});
