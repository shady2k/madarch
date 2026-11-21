/** New typed properties extend a graph contract without rewriting assertion history (0039.25). */
import { expect,test } from 'bun:test';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { assertionValueTableName,generatedTableName,type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
const before:GraphContract={vertex:[{name:'probe',table:generatedTableName('probe','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'label',type:'text',nullable:true}],capability:'fixture'}],edge:[],dictionary:[]};
const after:GraphContract={...before,vertex:[{...before.vertex[0]!,fields:[...before.vertex[0]!.fields,{name:'enabled',type:'boolean',nullable:true}]}]};
test('0039.25: a new nullable property gets typed storage while immutable prior assertions remain byte-for-byte',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:before,authenticated:false});try{
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,before);await publishGraphDrafts(tx,before,{vertices:[{kind:'probe',key:{name:'a'},values:{label:'first'},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const history=await owner.run(tx=>loadAssertions(tx,'vertex','probe',['label']));
 expect(await prepareGraphSchema(owner,after)).toEqual({reset:false});
 expect(await owner.run(tx=>loadAssertions(tx,'vertex','probe',['label']))).toEqual(history);
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,after);await publishGraphDrafts(tx,after,{vertices:[{kind:'probe',key:{name:'a'},values:{enabled:false},producer:'fixture',producerVersion:'2'}],removals:[]});});
 expect((await owner.run(tx=>loadAssertions(tx,'vertex','probe',['enabled']))).map(a=>a.value)).toEqual([false]);
 expect(await owner.run(tx=>loadAssertions(tx,'vertex','probe',['label']))).toEqual(history);
 const columns=await owner.run(tx=>tx.query<{column_name:string;data_type:string}>('SELECT column_name,data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position',[assertionValueTableName('probe','vertex','enabled')]));
 expect(columns.rows).toEqual([{column_name:'assertion_id',data_type:'bigint'},{column_name:'value',data_type:'boolean'}]);
 expect(await prepareGraphSchema(owner,after)).toEqual({reset:false});
 }finally{await owner.close();}
});
