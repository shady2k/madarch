import { describe, expect, test } from 'bun:test';
import { UnitTools, type UnitSpec } from '../src/writer/tools.js';
import { memorySink } from '../src/writer/run.js';
import type { GraphView } from '../src/writer/view.js';
import { GUIDE_OUTPUTS, type GuidePreparedUnit } from '../src/writer/guides/host-contract.js';
import { GUIDE_SCHEMA } from '../src/writer/guides/model.js';
import { guideDigest } from '../src/writer/guides/digest.js';
import { guidePrompt } from '../src/writer/prompts.js';

const context = {valid:'2026-04-01T00:00:00Z',known:'2026-04-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
function input(kind:'administrator-guide'|'user-guide') {
 return {schema:GUIDE_SCHEMA,id:GUIDE_OUTPUTS[kind].id,kind,locale:'en',title:'Guide',context,unitVersion:'1',inputDigest:guideDigest(context),prerequisites:[],gaps:['No frontend evidence.'],procedures:[{id:'check',title:'Check',goal:'Read status',role:'Reader',prerequisites:[],steps:[{id:'status',title:'Read status',cwd:'.',environment:'isolated',inputs:[],instruction:{kind:'http',content:'GET /status'},expected:{status:200,observation:'Status is ready'},grounds:[{repository:'sample',commit:'a'.repeat(40),path:'api.yaml',line:1,endLine:2}]}]}]};
}
function prepared(kind:'administrator-guide'|'user-guide',publish:GuidePreparedUnit['publishChecked']):GuidePreparedUnit {
 return {prompt:'bounded evidence',validation:{file:`/product/${GUIDE_OUTPUTS[kind].path}`,expectedContext:context,expectedInputDigest:guideDigest(context),expectedUnitVersion:'1',containsSecret:(text)=>text.includes('private-value'),verifyStep:async()=>[]},publishChecked:publish};
}
function tools(kind:'administrator-guide'|'user-guide',host:GuidePreparedUnit) {
 const output=GUIDE_OUTPUTS[kind];const sink=memorySink();
 const spec:UnitSpec={kind,id:output.id,path:output.path,prepared:host};
 return {session:new UnitTools({} as GraphView,spec,sink),sink};
}
describe('two checked guide writer units',()=>{
 test('both types expose only structured guide write and never bypass the publisher',async()=>{
  for(const kind of ['administrator-guide','user-guide'] as const){
   let calls=0;const host=prepared(kind,async(request)=>{calls++;expect(request.guide.id).toBe(GUIDE_OUTPUTS[kind].id);expect(request.artifact).toContain('Not walked');return {ok:true,path:GUIDE_OUTPUTS[kind].path,unchanged:false};});
   const {session,sink}=tools(kind,host);
   expect(session.tools.map(x=>x.name)).toEqual(['write_guide']);
   expect((await session.call('write_page',{markdown:'```sh\nfalse\n```'})).isError).toBe(true);
   expect((await session.call('read_file',{path:'api.yaml'})).isError).toBe(true);
   expect((await session.call('write_guide',{guide:input(kind)})).isError).toBe(false);
   expect(calls).toBe(1);expect(sink.pages.size).toBe(0);expect(session.outcome().status).toBe('written');
   expect((await session.call('write_guide',{guide:input(kind)})).isError).toBe(true);expect(calls).toBe(1);
  }
 });
 test('publication refusal, altered expected result, and secrets never certify output',async()=>{
  const kind='administrator-guide';let calls=0;
  const host=prepared(kind,async()=>{calls++;return {ok:false,diagnostics:[{file:'/product/docs/guides/administrator.md',line:1,path:'$.publication',code:'fence',message:'/product/docs/guides/administrator.md:1: stale fence'}]};});
  const {session,sink}=tools(kind,host);expect((await session.call('write_guide',{guide:input(kind)})).isError).toBe(true);expect(session.outcome().status).toBe('failed');expect(sink.pages.size).toBe(0);
  const secret={...input(kind),title:'private-value'};const answer=await session.call('write_guide',{guide:secret});expect(answer.isError).toBe(true);expect(JSON.stringify(answer)).not.toContain('private-value');expect(calls).toBe(1);
  const strict={...host,validation:{...host.validation,verifyStep:async()=>['unsupported observation']}};expect((await tools(kind,strict).session.call('write_guide',{guide:input(kind)})).isError).toBe(true);expect(calls).toBe(1);
 });
 test('prepared guide errors suppress sensitive host exception details',async()=>{
  const kind='user-guide';const host=prepared(kind,async()=>{throw new Error('private-value');});const {session}=tools(kind,host);const answer=await session.call('write_guide',{guide:input(kind)});expect(answer.isError).toBe(true);expect(JSON.stringify(answer)).not.toContain('private-value');
 });
 test('guide instructions are separate from ordinary narrative format',()=>{expect(guidePrompt('user-guide','ru','source packet')).toContain('Russian');expect(guidePrompt('administrator-guide','en','source packet')).toContain('write_guide');});
});
