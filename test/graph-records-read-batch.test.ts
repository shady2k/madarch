import {expect,test} from 'bun:test';
import {readKindAssertions} from '../src/graph/records.js';
import type {SqlExecutor} from '../src/sql-driver.js';

test('record identities do not conceal a missing typed storage table',async()=>{
 const now=new Date('2026-01-01T00:00:00.000Z');
 const tx={query:async(sql:string)=>{
  if(sql.includes('FROM assertion a'))throw new Error('missing typed table');
  if(sql==='SELECT transaction_timestamp() AS now')return {rows:[{now}]};
  return {rows:[{id:1,uid:'00000000-0000-4000-8000-000000000001',key:{},read_at:now}]};
 }} as SqlExecutor;
 await expect(readKindAssertions(tx,'vertex','system.run',['state'])).rejects.toThrow('missing typed table');
});
