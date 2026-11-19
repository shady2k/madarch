import {expect,test} from 'bun:test';
import {readKindAssertions,readKindsAssertions} from '../src/graph/records.js';
import type {SqlExecutor} from '../src/sql-driver.js';

test('record identities do not conceal a missing typed storage table',async()=>{
 const now=new Date('2026-01-01T00:00:00.000Z');
 const tx={query:async(sql:string)=>{
  if(sql.includes('FROM assertion a'))throw new Error('missing typed table');
  if(sql==='SELECT transaction_timestamp() AS now')return {rows:[{now}]};
  return {rows:[{request_index:0,id:1,uid:'00000000-0000-4000-8000-000000000001',key:{},read_at:now}]};
 }} as SqlExecutor;
 await expect(readKindAssertions(tx,'vertex','system.run',['state'])).rejects.toThrow('missing typed table');
});


test('overlapping record requests share typed reads and canonical arbitration without sharing projections',async()=>{
 const now='2026-01-01T00:00:00.000Z';
 const uid='00000000-0000-4000-8000-000000000001';
 const queries:string[]=[];
 const assertion=(request_index:number,property:string,value:unknown,sequence:number)=>({request_index,id:`00000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,subject_id:1,subject_uid:uid,property,value,value_type:typeof value==='boolean'?'boolean':'text',context_id:1,language:null,operation:'assert',valid_from:'2020-01-01T00:00:00.000Z',valid_to:null,recorded_at:'2020-01-01T00:00:00.000Z',recorded_sequence:String(sequence),source:uid,author:uid,unit:null,operation_uid:uid,evidence:[]});
 const tx={query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('WITH anchors AS'))return {rows:[]};
  if(sql.includes('FROM assertion a'))return {rows:[assertion(0,'$exists',true,2),assertion(0,'left','L',3),assertion(1,'$exists',true,2),assertion(1,'right','R',4)]};
  return {rows:[0,1].map(request_index=>({request_index,id:1,uid,key:{},from_node:null,to_node:null,discriminator:null,read_at:now}))};
 }} as SqlExecutor;
 const contract={vertex:[],edge:[],dictionary:[]};
 const rows=await readKindsAssertions(tx,[{sort:'vertex',kind:'example.item',fields:['left']},{sort:'vertex',kind:'example.item',fields:['right']}],{contract});
 expect(rows.map(group=>group.map(row=>row.values))).toEqual([[{$exists:true,left:'L'}],[{$exists:true,right:'R'}]]);
 expect(queries).toHaveLength(3);
 expect(queries.filter(sql=>sql.includes('WITH anchors AS'))).toHaveLength(1);
});
