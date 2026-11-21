import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, RequestLog } from '../src/plugin/host.js';
import { PROTOCOL_VERSION } from '../src/plugin/protocol.js';

/** Real wire requests with confinement disabled: these test transport, never sandbox isolation. */
async function operationRun(options: {count?:number; textBytes?:number; maxUnitOutputBytes?:number; fail?:boolean; script?:string; trusted?:boolean; raw?:string; providerDelayMs?:number; planning?:boolean} = {}) {
  const root=mkdtempSync(join(tmpdir(),'madarch-facts-transport-'));
  const outputs={vertices:[{kind:'item',key:['id'],fields:[{name:'text',type:'text',meaning:'fixture text',example:'',required:false}]}],edges:[]};
  writeFileSync(join(root,'plugin.json'),JSON.stringify({name:'transport',version:'1.0.0',entry:'entry.ts',runtime:{name:'bun',version:Bun.version},produces:[{kind:'item',fields:'*'}]}));
  const rights=options.raw===undefined?{network:'none',graph:true,graphReads:['files','value','ownFacts']}:{network:'none'};
  writeFileSync(join(root,'contract.json'),JSON.stringify({id:'transport',version:'1.0.0',outputs,rights}));
  writeFileSync(join(root,'entry.ts'),`import {definePlugin} from 'madarch-plugin-sdk';
await definePlugin({name:'transport',version:'1.0.0',contract:${JSON.stringify(outputs)},${options.planning?"async planOutput(unit,context){ await context.facts.apply('planned',{vertices:[]}); return {partitions:[]}; },":''}async extract(unit,context){
  ${options.script??''}
  for(let id=0;id<${options.count??3};id++){
    await context.facts.apply(String(id),{vertices:[{kind:'item',key:{id:String(id)},values:{text:'x'.repeat(${options.textBytes??400000})}}]});
  }
  return {end:{state:'complete'}};
}});`);
  if(options.raw!==undefined) writeFileSync(join(root,'entry.ts'),`const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.setEncoding('utf8'); let held='';
process.stdin.on('data',chunk=>{held+=chunk;let newline;while((newline=held.indexOf('\\n'))!==-1){const line=held.slice(0,newline);held=held.slice(newline+1);const message=JSON.parse(line);if(message.method==='unit'){${options.raw}}else if(message.method==='stop'){send({jsonrpc:'2.0',id:message.id,result:{stopping:true}});process.exit(0);}}});
send({jsonrpc:'2.0',id:'introduce',method:'introduce',params:{protocol:${JSON.stringify(PROTOCOL_VERSION)},name:'transport',version:'1.0.0',rights:{network:'none'},limits:{},outputs:${JSON.stringify(outputs)}}});`);
  const operations:unknown[]=[];
  const calls:unknown[]=[];
  const requests=new RequestLog();
  let session;
  try {
    session=await new PluginHost({pluginFolder:root,repository:root,workRoot:join(root,'work'),trust:'validation',env:{...process.env,MADARCH_PLUGIN_SANDBOX:'off'},graph:{ownFacts:async()=>({vertices:[],edges:[]}),files:async()=>[],value:async()=>null},requests,...(options.trusted===false?{}:{operations:{async apply(unitId,key,operation,preconditions,contractVersion){calls.push({unitId,key,operation,preconditions,contractVersion});if(options.providerDelayMs)await Bun.sleep(options.providerDelayMs);if(options.fail)throw new Error('fixture admission refused');if (typeof operation !== 'object' || operation === null || !('vertices' in operation)) throw new Error('expected vertices operation');
      operations.push(operation);return {operationUid:key,accepted:true};}}}),limits:{unitMs:3000,...(options.maxUnitOutputBytes===undefined?{}:{maxUnitOutputBytes:options.maxUnitOutputBytes})}}).open();
    if(options.planning){
      let refusal:unknown;
      try{await session.planOutput({unitId:'transport',kind:'item',key:{id:'all'}});}catch(error){refusal=error;}
      const outcome=await session.runUnit({unitId:'transport',kind:'item',key:{id:'all'}});
      return {outcome,operations,requests,calls,refusal};
    }
    const outcome=await session.runUnit({unitId:'transport',kind:'item',key:{id:'all'}});
    return {outcome,operations,requests,calls,refusal:undefined};
  }finally{await session?.close();rmSync(root,{recursive:true,force:true});}
}

test('immediate atomic operations preserve complete payloads above one message in total',async()=>{
  const {outcome,operations}=await operationRun();
  expect(outcome.state).toBe('extracted');
  expect(outcome.bytes).toBeGreaterThan(1_048_576);
  expect(operations).toEqual(['0','1','2'].map(id=>({vertices:[{kind:'item',key:{id},values:{text:'x'.repeat(400000)}}]})));
  if(outcome.state==='extracted')expect(outcome.result).toEqual({unitId:'transport',end:{state:'complete'}});
},15_000);

test('one operation above the message bound refuses instead of silently fragmenting it',async()=>{
  const {outcome,operations}=await operationRun({count:1,textBytes:1_200_000});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.code).toBe('message-too-large');
  expect(operations).toEqual([]);
},15_000);

test('immediate writes cannot bypass the per-unit output cap',async()=>{
  const {outcome,operations}=await operationRun({maxUnitOutputBytes:1_048_576});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.code).toBe('unit-output-too-large');
  expect(operations).toHaveLength(2);
},15_000);

test('trusted admission failure refuses the unit without accepting an operation',async()=>{
  const {outcome,operations}=await operationRun({count:1,textBytes:10,fail:true});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.message).toContain('fixture admission refused');
  expect(operations).toEqual([]);
},15_000);

test('a writing plugin cannot apply facts without a trusted operation provider',async()=>{
  const {outcome,operations}=await operationRun({count:1,textBytes:10,trusted:false});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.message).toContain('trusted operation host');
  expect(operations).toEqual([]);
},15_000);

test('an empty idempotency key is refused before reaching the trusted provider',async()=>{
  const {outcome,operations}=await operationRun({count:0,script:"await context.facts.apply('',{vertices:[]});"});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.code).toBe('malformed-message');
  expect(operations).toEqual([]);
},15_000);

test('facts in a final unit summary are refused rather than published',async()=>{
  const {outcome,operations}=await operationRun({raw:"send({jsonrpc:'2.0',id:message.id,result:{unitId:message.params.unit.unitId,vertices:[{kind:'item',key:{id:'late'},values:{text:'forbidden'}}],end:{state:'complete'}}});"});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.code).toBe('malformed-result');
  expect(operations).toEqual([]);
},15_000);

test('facts.apply cannot name a unit that is not active',async()=>{
  const {outcome,operations,requests}=await operationRun({raw:"send({jsonrpc:'2.0',id:'write',method:'facts.apply',params:{unitId:'inactive',key:'one',operation:{vertices:[]}}});send({jsonrpc:'2.0',id:message.id,result:{unitId:message.params.unit.unitId,end:{state:'complete'}}});"});
  expect(outcome.state).toBe('extracted');
  expect(operations).toEqual([]);
  expect(requests.finish()).toContainEqual(expect.objectContaining({method:'facts.apply',outcome:'refused',cause:'operation-not-bound'}));
},15_000);

test('completion cannot overtake an unanswered atomic operation',async()=>{
  const {outcome}=await operationRun({providerDelayMs:100,raw:"send({jsonrpc:'2.0',id:'write',method:'facts.apply',params:{unitId:message.params.unit.unitId,key:'one',operation:{vertices:[]}}});send({jsonrpc:'2.0',id:message.id,result:{unitId:message.params.unit.unitId,end:{state:'complete'}}});"});
  expect(outcome.state).toBe('not-extracted');
  if(outcome.state==='not-extracted')expect(outcome.cause.code).toBe('operation-pending');
},15_000);

test('operation keys and revision preconditions reach trusted admission unchanged',async()=>{
  const preconditions=[{uid:'01934a22-0000-7000-8000-000000000001',recordedSequence:'42'}];
  const operation={vertices:[]};
  const {outcome,calls}=await operationRun({count:0,script:`await context.facts.apply('stable-item',${JSON.stringify(operation)},{preconditions:${JSON.stringify(preconditions)},contractVersion:'pinned-v1'});`});
  expect(outcome.state).toBe('extracted');
  expect(calls).toEqual([{unitId:'transport',key:'stable-item',operation,preconditions,contractVersion:'pinned-v1'}]);
},15_000);

test('output planning cannot admit facts before extraction starts',async()=>{
  const {refusal,operations,requests}=await operationRun({count:0,planning:true});
  expect(refusal).toBeDefined();
  expect(operations).toEqual([]);
  expect(requests.finish()).toContainEqual(expect.objectContaining({method:'facts.apply',outcome:'refused',cause:'operation-not-bound'}));
},15_000);
