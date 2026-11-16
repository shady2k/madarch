import { callProductTool } from '../src/mcp/authored.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { generatedTableName, graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { developmentTools, readDevelopmentTool } from '../src/graph/development-read.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { readKindAssertions } from '../src/graph/records.js';

const vertex = (name: string) => ({name,table:generatedTableName(name,'vertex'),key:['name'],fields:[{name:'name',type:'text' as const},{name:'synonyms',type:'json' as const,nullable:true,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',items:{type:'string'}}}],capability:'fixture'});
const edge = (name:string, role:'containment'|'dependency'|'reference'|'implementation', direction:'in'|'out') => ({name,role,direction,from:['file','folder','module','component','domain'],to:['file','folder','module','component','domain'],repeats:false,cardinality:{from:'many' as const,to:'many' as const},labels:{en:{out:'links',in:'linked by'},ru:{out:'связано',in:'связано'}},fields:[],capability:'fixture'});
// Deliberately opaque names and reversed physical orientation exercise catalogue semantics.
const contract: GraphContract = {vertex:['file','folder','module','component','domain'].map(vertex),edge:[edge('r1','containment','in'),edge('r2','dependency','out'),edge('r3','reference','out'),edge('r4','implementation','in')],dictionary:[]};
const manifest = { language:'en', kinds:new Map(contract.vertex.map(kind=>[kind.name,{name:kind.name,title:'name',labels:{en:{one:kind.name,many:kind.name}}}])) } as unknown as KindsManifest;
const producer = {producer:'fixture',producerVersion:'1'};
const ref = (kind:string,name:string) => ({kind,key:{name}});
async function fixture() {
 const owner = await createTestDatabaseOwner({graphContract:contract});
 await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[['file','leaf'],['file','caller'],['file','outside'],['folder','src'],['module','Payments'],['component','Payments'],['domain','commerce'],['domain','unrelated']].map(([kind,name])=>({kind:kind!,key:{name:name!},values:{synonyms:name==='Payments'?['billing']:[]},...producer})),edges:[['r2','file','outside','file','leaf'],['r2','file','caller','file','leaf'],['r1','folder','src','file','leaf'],['r1','module','Payments','folder','src'],['r4','component','Payments','module','Payments'],['r4','domain','commerce','component','Payments'],['r2','file','leaf','file','caller'],['r3','file','leaf','domain','unrelated']].map(([kind,fk,fn,tk,tn])=>({kind:kind!,from:ref(fk!,fn!),to:ref(tk!,tn!),...producer})),removals:[]}));
 const leaf = await owner.transaction('snapshot',async tx=>(await readKindAssertions(tx,'vertex','file',[],{contract})).find(row=>row.key['name']==='leaf')!.uid);
 const call = async (name:string,args:unknown) => await owner.transaction('snapshot',tx=>readDevelopmentTool(tx,manifest,contract,name,args));
 const outside = await owner.transaction('snapshot',async tx=>(await readKindAssertions(tx,'vertex','file',[],{contract})).find(row=>row.key['name']==='outside')!.uid);
 return {owner,leaf,outside,call};
}
const envelope = {contractVersion:graphContractVersion(contract)};
function body(result:Awaited<ReturnType<typeof readDevelopmentTool>>) { expect(result.isError).toBe(false); return result.answer as {groups:{kind:string;entities:{uid:string;kindLabel:string;assertions:{source:{uid:string;kind:string};recordedAt:string}[]}[]}[];links:unknown[];cut:{depth:boolean;count:boolean}}; }

test('0039.6,14: search retains synonym homonyms, kind labels and recorded sources',async()=>{
 const f=await fixture();try {
 const answer=body(await f.call('search',{...envelope,text:'billing'}));
 expect(answer.groups.map(group=>group.kind)).toEqual(['component','module']);
 for(const group of answer.groups) {expect(group.entities[0]!.kindLabel).toBe(group.kind);expect(group.entities[0]!.assertions.length).toBeGreaterThan(0);for(const assertion of group.entities[0]!.assertions){expect(assertion.source.uid.length).toBe(36);expect(assertion.source.kind.length).toBeGreaterThan(0);expect(Number.isNaN(Date.parse(assertion.recordedAt))).toBe(false);}}
 expect(body(await f.call('search',{...envelope,text:'Payments',limit:1})).cut.count).toBe(true);
 }finally{await f.owner.close();}
}, 15000);
for(const name of ['dependencies','dependants','impact','owner']) test(`0039.1,25,30: ${name} uses declared roles by default, with bounds and cycles`,async()=>{
 const f=await fixture();try {
 const product={developmentRead:f.call} as unknown as KnowledgeProduct;
 const one=body(await callProductTool(product,{producer:'fixture',version:'1'},name,{...envelope,entity:f.leaf,depth:1}));
 const owns=name==='owner'||name==='impact';
 expect(one.groups.map(group=>group.kind)).toEqual(name==='owner'?['folder']:name==='impact'?['file','folder']:['file']);
 expect(one.cut.depth).toBe(owns);
 const all=body(await f.call(name,{...envelope,entity:f.leaf,depth:10}));
 expect(all.groups.map(group=>group.kind)).toEqual(name==='owner'?['component','domain','folder','module']:name==='impact'?['component','domain','file','folder','module']:['file']);
 expect(all.cut).toEqual({depth:false,count:false});
 expect(all.groups.flatMap(group=>group.entities).some(entity=>entity.uid===f.outside)).toBe(name==='impact'||name==='dependants');
 expect(all.groups.flatMap(group=>group.entities).some(entity=>entity.uid===f.leaf)).toBe(false);
 if(owns) expect(body(await f.call(name,{...envelope,entity:f.leaf,depth:10,limit:1})).cut.count).toBe(true);
 if(name==='impact') {
 const narrow=body(await f.call(name,{...envelope,entity:f.leaf,relations:[{kind:'r2',direction:'in'}],depth:10}));
 expect(narrow.groups.map(group=>group.kind)).toEqual(['file']);
 }
 const wrong=await f.call(name,{...envelope,entity:f.leaf,relations:[{kind:'r3',direction:'out'}]});
 expect(wrong.isError).toBe(true);
 }finally{await f.owner.close();}
}, 15000);
test('0039.7,30: every development door refuses malformed inputs and contract drift with a code',async()=>{
 const f=await fixture();try{
 for(const name of ['dependencies','dependants','impact','owner','search']) {
 for(const input of [null,[],{},name==='search'?{...envelope,text:'x',limit:0}:{...envelope,entity:f.leaf,relations:[{kind:'unknown',direction:'in'}]}]) {
 const answer=await f.call(name,input);expect(answer.isError).toBe(true);expect((answer.answer as {error:{code:string}}).error.code).toBe('SCHEMA_INVALID');
 }
 const drift=await f.call(name,{contractVersion:'old'});expect((drift.answer as {error:{code:string}}).error.code).toBe('CONTRACT_CONFLICT');
 }
 const missing=await f.call('owner',{...envelope,entity:'00000000-0000-0000-0000-000000000000'});expect((missing.answer as {error:{code:string}}).error.code).toBe('TARGET_MISSING');
 expect(developmentTools(contract).map(tool=>tool.name)).toEqual(['impact','owner','dependencies','dependants','search']);
 }finally{await f.owner.close();}
}, 15000);

test('0039.25,30: retracted edges no longer traverse, including through MCP dispatch',async()=>{
 const f=await fixture();try{
 await f.owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[],removals:[],edgeRemovals:[{kind:'r1',from:ref('folder','src'),to:ref('file','leaf'),producer:'fixture'},{kind:'r2',from:ref('file','leaf'),to:ref('file','caller'),producer:'fixture'},{kind:'r2',from:ref('file','caller'),to:ref('file','leaf'),producer:'fixture'},{kind:'r2',from:ref('file','outside'),to:ref('file','leaf'),producer:'fixture'}]}));
 const product={developmentRead:f.call} as unknown as KnowledgeProduct;
 for(const name of ['dependencies','dependants','impact','owner','search']) {
 const args=name==='search'?{...envelope,text:'billing'}:{...envelope,entity:f.leaf};
 const answer=await callProductTool(product,{producer:'fixture',version:'1'},name,args);
 const result=body(answer);expect(result.groups.length).toBe(name==='search'?2:0);
 }
 }finally{await f.owner.close();}
}, 15000);

test('0039.7,30: role defaults and selector schemas change with catalogue semantics', () => {
 const schema = developmentTools(contract).find(tool=>tool.name==='impact')!.inputSchema;
 expect(JSON.stringify(schema)).toContain('r1');
 expect(JSON.stringify(schema)).toContain('r2');
 expect(JSON.stringify(schema)).toContain('r4');
 expect(JSON.stringify(schema)).not.toContain('r3');
 const changed={...contract,edge:contract.edge.map(edge=>({...edge,role:'reference' as const}))};
 expect(JSON.stringify(developmentTools(changed).find(tool=>tool.name==='owner')!.inputSchema)).not.toContain('r1');
});
