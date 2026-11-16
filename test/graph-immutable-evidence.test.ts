import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {publishGraphDrafts,resolveEntityRef} from '../src/graph/write.js';
import {generatedTableName,type GraphContract,type VertexDraft} from '../src/graph/contract.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
const graph:GraphContract={vertex:[{name:'claim',table:generatedTableName('claim','vertex'),key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},{name:'snapshot',table:generatedTableName('snapshot','vertex'),key:['digest'],fields:[{name:'digest',type:'text'},{name:'content',type:'text'}],capability:'fixture',evidence:{immutable:true,digestField:'digest',contentField:'content',digestAlgorithm:'sha256'}}],edge:[],dictionary:[]};
const content='first\nsecond';const digest=createHash('sha256').update(content).digest('hex');
const target={kind:'snapshot',key:{digest}};
const snapshot:VertexDraft={...target,values:{content},producer:'fixture',producerVersion:'1'};
const claim:VertexDraft={kind:'claim',key:{name:'citation'},evidence:[{target,locator:{digest,lineStart:1,lineEnd:2}}],producer:'fixture',producerVersion:'1'};
test('0039.31 immutable support later in the batch resolves before atomic publication',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[claim,snapshot],removals:[]});});
  expect((await owner.run(tx=>loadAssertions(tx,'vertex','claim',['$exists'])))[0]!.evidence).toHaveLength(1);
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);const identity=await resolveEntityRef(tx,graph,target);expect(await resolveEntityRef(tx,graph,{kind:'snapshot',key:{},uid:identity.uid})).toEqual(identity);await expect(resolveEntityRef(tx,graph,{kind:'claim',key:{},uid:identity.uid})).rejects.toThrow('MISSING_ENDPOINT');await expect(resolveEntityRef(tx,graph,{kind:'snapshot',key:{digest:'conflicting'},uid:identity.uid})).rejects.toThrow('UID_IDENTITY_CONFLICT');});

  for(const vertices of [[{...snapshot,values:{content:'tampered'}}],[{...claim,key:{name:'outside'},evidence:[{target,locator:{lineStart:1,lineEnd:3}}]}],[{...claim,key:{name:'mutable'},evidence:[{target:{kind:'claim',key:{name:'citation'}}}]}]]){
   await expect(owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices,removals:[]});})).rejects.toThrow();
  }
  await expect(owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[],removals:[{...target,producer:'fixture'}]});})).rejects.toThrow('IMMUTABLE_EVIDENCE');
  expect((await owner.run(tx=>loadAssertions(tx,'vertex','claim',['$exists'])))).toHaveLength(1);
 }finally{await owner.close();}
},30000);
test('0039.31 digest mismatch rolls back the entire operation',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try{
  await expect(owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:[{...snapshot,key:{digest:'wrong'}}],removals:[]});})).rejects.toThrow('EVIDENCE_INVALID');
  expect(await owner.run(tx=>loadAssertions(tx,'vertex','snapshot',['$exists']))).toHaveLength(0);
 }finally{await owner.close();}
},30000);
