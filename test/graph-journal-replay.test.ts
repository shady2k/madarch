/** Bitemporal history replaces mutable opinion/journal replay (0039 items 24–25). */
import { expect,test } from 'bun:test';
import { generatedTableName,type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts,ensureVertex,writeAssertion } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
const graph:GraphContract={vertex:[{name:'record',table:generatedTableName('record','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'label',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
test('0039.25: recorded snapshots replay immutable history without a second source of facts',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});try{
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[{kind:'record',key:{name:'a'},producer:'fixture',producerVersion:'1'}],removals:[]});});
 const versions: import('../src/graph/assertion-read.js').StoredAssertion[]=[];
 const recordedCutoffs:string[]=[];
 for(const label of ['first','second','third']){
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);const subject=await ensureVertex(tx,graph,{kind:'record',key:{name:'a'}});await writeAssertion(tx,graph,{sort:'vertex',kind:'record',subjectId:subject.nodeId,property:'label',operation:'assert',value:label,validFrom:'2020-01-01T00:00:00Z'});});
 versions.push((await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']))).at(-1)!);
 recordedCutoffs.push((await owner.run(tx=>tx.query<{at:string}>("SELECT clock_timestamp()::text AS at"))).rows[0]!.at);
 }
 const all=await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']));
 expect(all.map(a=>a.value)).toEqual(['first','second','third']);
 for(const [index] of versions.entries()){
 const slots=await owner.run(tx=>loadAssertions(tx,'vertex','record',['label'],undefined,{validAt:'2025-01-01T00:00:00Z',recordedAt:recordedCutoffs[index]!,contexts:[1]}));
 expect(slots.find(a=>a.selected)!.value).toBe(['first','second','third'][index]);
 }
 await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[],removals:[{kind:'record',key:{name:'a'},producer:'fixture',selectedFields:['label']}]});});
 const after=await owner.run(tx=>loadAssertions(tx,'vertex','record',['label']));
 expect(after.slice(0,3)).toEqual(all);
 const now=new Date().toISOString();
 expect((await owner.run(tx=>loadAssertions(tx,'vertex','record',['label'],undefined,{validAt:now,recordedAt:now,contexts:[1]}))).find(a=>a.selected)).toBeUndefined();
 expect((await owner.run(tx=>loadAssertions(tx,'vertex','record',['label'],undefined,{validAt:'2025-01-01T00:00:00Z',recordedAt:recordedCutoffs[1]!,contexts:[1]}))).find(a=>a.selected)!.value).toBe('second');
 }finally{await owner.close();}
});
