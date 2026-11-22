import {expect,test} from 'bun:test';
import type {DatabaseOwner} from '../src/adapters/database-owner.js';
import {assertionValueTableName} from '../src/graph/contract.js';
import type {SqlExecutor} from '../src/sql-driver.js';
import {commitFacts,fileFacts,listFiles,repositoryFacts} from '../src/graph/records.js';
import {repositoryManifest} from './repository-contract-fixture.js';

// The published manifest is also a typed assertion read. It is recognised by the frame
// assertionSelectionSql gives it, its typed attachment table, and the generated value table of
// manifest.catalogue.declaration (decision 0039, item 25); no alias or join order is part of it.
const typedManifestRead=(sql:string):boolean=>
 sql.includes('WITH RECURSIVE context_path')&&sql.includes('assertion_vertex_subject')&&
 sql.includes(`"${assertionValueTableName('manifest.catalogue','vertex','declaration')}"`);

function encode(value:unknown):unknown {
 if(value instanceof Map)return {$map:[...value].map(([key,held])=>[key,encode(held)])};
 if(Array.isArray(value))return value.map(encode);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,held])=>[key,encode(held)]));
 return value;
}

/** Only the manifest is present; the requested repository or commit has no identity. */
function missingParentOwner(role:'repository'|'commit'):DatabaseOwner {
 const binding=repositoryManifest.semanticBindings!.get(role)!;
 const manifest={...repositoryManifest,semanticBindings:new Map([[role,{...binding,edges:undefined}]])};
 const declaration=JSON.stringify(encode(manifest));
 const now='2026-01-01T00:00:00.000Z';
 const uid='00000000-0000-4000-8000-000000000001';
 const tx={query:async(sql:string,parameters?:readonly unknown[])=>{
  if(sql.includes('WITH anchors AS'))return {rows:[]};
  if(sql.includes("k.name='system.merge'"))return {rows:[{present:false}]};
  if(sql==='SELECT transaction_timestamp() AS now')return {rows:[{now}]};
  if(parameters?.[0]!=='manifest.catalogue')return {rows:[]};
  if(sql.includes('FROM node n'))return {rows:[{request_index:0,id:1,uid,key:{name:'product'},read_at:now}]};
  if(typedManifestRead(sql))return {rows:[['$exists',true],['declaration',declaration]].map(([property,value],index)=>({
   request_index:0,id:`00000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`,
   subject_id:1,subject_uid:uid,property,value,value_type:typeof value==='boolean'?'boolean':'text',
   context_id:1,language:null,source:uid,author:uid,unit:null,operation_uid:uid,evidence:[],
   operation:'assert',valid_from:'2020-01-01T00:00:00.000Z',valid_to:null,
   recorded_at:'2020-01-01T00:00:00.000Z',recorded_sequence:String(index+1),
   selected:true,active:true,
  }))};
  throw new Error(`unexpected query: ${sql}`);
 }} as SqlExecutor;
 return {transaction:async(_mode:unknown,work:(tx:SqlExecutor)=>Promise<unknown>)=>await work(tx)} as DatabaseOwner;
}

test('missing repository returns empty results without requiring dependent semantic bindings',async()=>{
 const owner=missingParentOwner('repository');
 expect(await repositoryFacts(owner,'missing')).toBeNull();
 expect(await listFiles(owner,{repository:'missing',limit:10})).toEqual({rows:[],next:null});
 expect(await fileFacts(owner,'missing','file.txt')).toBeNull();
});

test('missing commit returns null without requiring parent or author bindings',async()=>{
 expect(await commitFacts(missingParentOwner('commit'),'repository','missing')).toBeNull();
});
