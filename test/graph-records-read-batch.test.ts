import {expect,test} from 'bun:test';
import {assertionValueTableName} from '../src/graph/contract.js';
import {readKindAssertions,readKindsAssertions} from '../src/graph/records.js';
import type {SqlExecutor} from '../src/sql-driver.js';

// A typed assertion read is recognised by the frame assertionSelectionSql gives it, its typed
// attachment table, and a typed value table of the requested kind and property (decision 0039,
// item 25). These names belong to the read itself, so renaming an alias or reordering FROM and
// JOIN leaves the identification intact.
const typedReadOf=(sql:string,kind:string,properties:readonly string[]):boolean=>
 sql.includes('WITH RECURSIVE context_path')&&sql.includes('assertion_vertex_subject')&&
 properties.some(property=>sql.includes(`"${assertionValueTableName(kind,'vertex',property)}"`));

test('record identities do not conceal a missing typed storage table',async()=>{
 const now=new Date('2026-01-01T00:00:00.000Z');
 const tx={query:async(sql:string)=>{
  if(typedReadOf(sql,'system.run',['$exists','state']))throw new Error('missing typed table');
  if(sql==='SELECT transaction_timestamp() AS now')return {rows:[{now}]};
  return {rows:[{request_index:0,id:1,uid:'00000000-0000-4000-8000-000000000001',key:{},read_at:now}]};
 }} as SqlExecutor;
 await expect(readKindAssertions(tx,'vertex','system.run',['state'])).rejects.toThrow('missing typed table');
});


test('overlapping record requests share typed reads and canonical arbitration without sharing projections',async()=>{
 const now='2026-01-01T00:00:00.000Z';
 const uid='00000000-0000-4000-8000-000000000001';
 const queries:string[]=[];
 const assertion=(request_index:number,property:string,value:unknown,sequence:number)=>({request_index,id:`00000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,subject_id:1,subject_uid:uid,property,value,value_type:typeof value==='boolean'?'boolean':'text',context_id:1,language:null,operation:'assert',valid_from:'2020-01-01T00:00:00.000Z',valid_to:null,recorded_at:'2020-01-01T00:00:00.000Z',recorded_sequence:String(sequence),source:uid,author:uid,unit:null,operation_uid:uid,evidence:[],selected:true,active:true});
 const tx={query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('WITH anchors AS'))return {rows:[]};
  if(sql==='SELECT transaction_timestamp() AS now')return {rows:[{now}]};
  if(typedReadOf(sql,'example.item',['$exists','left','right']))return {rows:[assertion(0,'$exists',true,2),assertion(0,'left','L',3),assertion(1,'$exists',true,2),assertion(1,'right','R',4)]};
  return {rows:[0,1].map(request_index=>({request_index,id:1,uid,key:{},from_node:null,to_node:null,discriminator:null,read_at:now}))};
 }} as SqlExecutor;
 const contract={vertex:[],edge:[],dictionary:[]};
 const rows=await readKindsAssertions(tx,[{sort:'vertex',kind:'example.item',fields:['left']},{sort:'vertex',kind:'example.item',fields:['right']}],{contract});
 expect(rows.map(group=>group.map(row=>row.values))).toEqual([[{$exists:true,left:'L'}],[{$exists:true,right:'R'}]]);
 const count = (needle: string) => queries.filter(sql => sql.includes(needle)).length;
 // Both requests share one identity read, one typed assertion read, one arbitration pass and one instant read.
 expect(count('n.id,n.uid::text,n.key')).toBe(1);
 const recordReads=queries.filter(sql=>typedReadOf(sql,'example.item',['$exists','left','right']));
 expect(recordReads).toHaveLength(1);
 expect(recordReads[0]).toContain(`"${assertionValueTableName('example.item','vertex','left')}"`);
 expect(recordReads[0]).toContain(`"${assertionValueTableName('example.item','vertex','right')}"`);
 expect(count('WITH anchors AS')).toBe(1);
 expect(count('transaction_timestamp() AS now')).toBe(1);
});
