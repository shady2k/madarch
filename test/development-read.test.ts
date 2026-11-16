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
const contract: GraphContract = {vertex:['file','folder','module','component','domain'].map(vertex),edge:[{name:'uses',from:['file','folder','module','component','domain'],to:['file','folder','module','component','domain'],repeats:false,cardinality:{from:'many',to:'many'},labels:{en:{out:'uses',in:'used by'},ru:{out:'использует',in:'используется'}},fields:[],capability:'fixture'}],dictionary:[]};
const manifest = { language:'en', kinds:new Map(contract.vertex.map(kind=>[kind.name,{name:kind.name,title:'name',labels:{en:{one:kind.name,many:kind.name}}}])) } as unknown as KindsManifest;
const producer = {producer:'fixture',producerVersion:'1'};
const ref = (kind:string,name:string) => ({kind,key:{name}});
async function fixture() {
 const owner = await createTestDatabaseOwner({graphContract:contract});
 await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[['file','leaf'],['file','caller'],['folder','src'],['module','Payments'],['component','Payments'],['domain','commerce']].map(([kind,name])=>({kind:kind!,key:{name:name!},values:{synonyms:name==='Payments'?['billing']:[]},...producer})),edges:[['file','caller','file','leaf'],['file','leaf','folder','src'],['folder','src','module','Payments'],['module','Payments','component','Payments'],['component','Payments','domain','commerce'],['domain','commerce','file','leaf']].map(([fk,fn,tk,tn])=>({kind:'uses',from:ref(fk!,fn!),to:ref(tk!,tn!),...producer})),removals:[]}));
 const leaf = await owner.transaction('snapshot',async tx=>(await readKindAssertions(tx,'vertex','file',[],{contract})).find(row=>row.key['name']==='leaf')!.uid);
 const call = async (name:string,args:unknown) => await owner.transaction('snapshot',tx=>readDevelopmentTool(tx,manifest,contract,name,args));
 return {owner,leaf,call};
}
const envelope = {contractVersion:graphContractVersion(contract)};
const relations = (direction:'in'|'out')=>[{kind:'uses',direction}];
function body(result:Awaited<ReturnType<typeof readDevelopmentTool>>) { expect(result.isError).toBe(false); return result.answer as {groups:{kind:string;entities:{uid:string;kindLabel:string;assertions:{source:{uid:string;kind:string};recordedAt:string}[]}[]}[];links:unknown[];cut:{depth:boolean;count:boolean}}; }

test('0039.6,14: search retains synonym homonyms, kind labels and recorded sources',async()=>{
 const f=await fixture();try {
 const answer=body(await f.call('search',{...envelope,text:'billing'}));
 expect(answer.groups.map(group=>group.kind)).toEqual(['component','module']);
 for(const group of answer.groups) {expect(group.entities[0]!.kindLabel).toBe(group.kind);expect(group.entities[0]!.assertions.length).toBeGreaterThan(0);for(const assertion of group.entities[0]!.assertions){expect(assertion.source.uid.length).toBe(36);expect(assertion.source.kind.length).toBeGreaterThan(0);expect(Number.isNaN(Date.parse(assertion.recordedAt))).toBe(false);}}
 expect(body(await f.call('search',{...envelope,text:'Payments',limit:1})).cut.count).toBe(true);
 }finally{await f.owner.close();}
});
for(const name of ['dependencies','dependants','impact','owner']) test(`0039.1,25,30: ${name} traverses active edges with explicit bounds and cycles`,async()=>{
 const f=await fixture();try {
 const direction=name==='dependants'||name==='impact'?'in':'out';
 const one=body(await f.call(name,{...envelope,entity:f.leaf,relations:relations(direction),depth:1}));
 expect(one.groups.map(group=>group.kind)).toEqual(direction==='in'?['domain','file']:['folder']);expect(one.cut.depth).toBe(true);expect(one.links.length).toBe(direction==='in'?2:1);
 const all=body(await f.call(name,{...envelope,entity:f.leaf,relations:relations(direction),depth:10}));expect(all.cut).toEqual({depth:false,count:false});expect(all.groups.flatMap(group=>group.entities).some(entity=>entity.uid===f.leaf)).toBe(false);
 expect(body(await f.call(name,{...envelope,entity:f.leaf,relations:relations(direction),depth:10,limit:1})).cut.count).toBe(true);
 }finally{await f.owner.close();}
});
test('0039.7,30: every development door refuses malformed inputs and contract drift with a code',async()=>{
 const f=await fixture();try{
 for(const name of ['dependencies','dependants','impact','owner','search']) {
 for(const input of [null,[],{},name==='search'?{...envelope,text:'x',limit:0}:{...envelope,entity:f.leaf,relations:[{kind:'unknown',direction:'in'}]}]) {
 const answer=await f.call(name,input);expect(answer.isError).toBe(true);expect((answer.answer as {error:{code:string}}).error.code).toBe('SCHEMA_INVALID');
 }
 const drift=await f.call(name,{contractVersion:'old'});expect((drift.answer as {error:{code:string}}).error.code).toBe('CONTRACT_CONFLICT');
 }
 const missing=await f.call('owner',{...envelope,entity:'00000000-0000-0000-0000-000000000000',relations:relations('out')});expect((missing.answer as {error:{code:string}}).error.code).toBe('TARGET_MISSING');
 expect(developmentTools(contract).map(tool=>tool.name)).toEqual(['impact','owner','dependencies','dependants','search']);
 }finally{await f.owner.close();}
});

test('0039.25,30: retracted edges no longer traverse, including through MCP dispatch',async()=>{
 const f=await fixture();try{
 await f.owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[],removals:[],edgeRemovals:[{kind:'uses',from:ref('file','leaf'),to:ref('folder','src'),producer:'fixture'}]}));
 const product={developmentRead:f.call} as unknown as KnowledgeProduct;
 for(const name of ['dependencies','dependants','impact','owner','search']) {
 const args=name==='search'?{...envelope,text:'billing'}:{...envelope,entity:f.leaf,relations:relations('out')};
 const answer=await callProductTool(product,{producer:'fixture',version:'1'},name,args);
 const result=body(answer);expect(result.groups.length).toBe(name==='search'?2:0);
 }
 }finally{await f.owner.close();}
});
