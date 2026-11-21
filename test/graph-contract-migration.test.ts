/** Today's products refill into final assertions; compatible additions retain history (0039.25). */
import {expect,test} from 'bun:test';
import {prepareGraphSchema} from '../src/adapters/schemas/graph.js';
import {assertionValueTableName,generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
const graph:GraphContract={vertex:[{name:'record',table:generatedTableName('record','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'label',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
test('0039.25: old physical revision resets as one graph and never lifts a scalar relation into an edge',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});try{
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[{kind:'record',key:{name:'old'},values:{label:'old'},producer:'fixture',producerVersion:'1'}],removals:[]});});
 await owner.run(tx=>tx.query("UPDATE madarch_meta.schema_stamp SET stamp='0' WHERE name='one-graph-revision'"));
 expect(await prepareGraphSchema(owner,graph)).toEqual({reset:true});
 expect(await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']))).toEqual([]);
 expect((await owner.run(tx=>tx.query('SELECT * FROM node'))).rows).toEqual([]);
 expect(await prepareGraphSchema(owner,graph)).toEqual({reset:false});
 }finally{await owner.close();}
});
test('0039.25: compatible property addition preserves old typed rows and does not recreate opinions',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});try{
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[{kind:'record',key:{name:'a'},values:{label:'retained'},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const history=await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']));
 const next:GraphContract={...graph,vertex:[{...graph.vertex[0]!,fields:[...graph.vertex[0]!.fields,{name:'extra',type:'text',nullable:true}]}]};
 expect(await prepareGraphSchema(owner,next)).toEqual({reset:false});
 expect(await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']))).toEqual(history);
 expect((await owner.run(tx=>tx.query('SELECT to_regclass($1)::text AS name',[assertionValueTableName('record','vertex','extra')]))).rows[0]!.name).toBe(assertionValueTableName('record','vertex','extra'));
 }finally{await owner.close();}
});
