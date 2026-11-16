import {expect,test} from 'bun:test';
import {readKindAssertions} from '../src/graph/records.js';
import type {SqlExecutor} from '../src/sql-driver.js';

test('empty record identities do not conceal a missing typed storage table',async()=>{
 const tx={query:async(sql:string)=>{if(sql.includes('FROM assertion a'))throw new Error('missing typed table');return {rows:[]};}} as SqlExecutor;
 await expect(readKindAssertions(tx,'vertex','system.run',['state'])).rejects.toThrow('missing typed table');
});
