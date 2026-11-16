import {withAssertionContract} from '../src/graph/system-contract.js';
import {expect,test} from 'bun:test';
import {createDatabaseOwner} from '../src/adapters/database-owner.js';
import {prepareGraphSchema} from '../src/adapters/schemas/graph.js';
import {createTestDatabaseOwner,testStoreServer} from './test-database.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion,resolveEntityRef} from '../src/graph/write.js';
import {assertionValueTableName,generatedTableName,graphContractVersion,type GraphContract} from '../src/graph/contract.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {newUid} from '../src/graph/uid.js';
const contract:GraphContract={vertex:[{name:'fixture',table:generatedTableName('fixture','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}],capability:'fixture'},{name:'system.operation',table:generatedTableName('system.operation','vertex'),key:[],fields:[],capability:'system'}],edge:[],dictionary:[]};
test('0039.25: typed immutable assertions retain source and recorded history',async()=>{
 const server=await testStoreServer();const owner=await createDatabaseOwner({cluster:server,database:`assert_${Date.now()}`});
 try {
 await owner.ready;await prepareGraphSchema(owner,contract);
 const productUid=newUid(),sourceUid=newUid(),principalUid=newUid(),operationUid=newUid();
 await owner.transaction('write',async tx=>{
  for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});
  await publishGraphDrafts(tx,contract,{vertices:[{kind:'fixture',key:{name:'one'},values:{amount:3},producer:'ignored',producerVersion:'ignored'}],removals:[]});
 });
 const subject=await owner.transaction('snapshot',async tx=>(await tx.query<{id:string}>(`SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture'`)).rows[0]!);
 const rows=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','fixture',['amount']));
 expect(rows).toHaveLength(1);expect(rows[0]!.source).toBe(sourceUid);expect(rows[0]!.value).toBe(3);expect(rows[0]!.recordedSequence>0n).toBe(true);
 await expect(owner.transaction('write',tx=>tx.query(`UPDATE assertion SET property='other'`))).rejects.toThrow('immutable');
 await expect(owner.transaction('write',tx=>tx.query(`UPDATE "${assertionValueTableName('fixture','vertex','amount')}" SET value=5`))).rejects.toThrow('immutable');
 await expect(owner.transaction('write',async tx=>{
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});
  await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:'wrong'});
 })).rejects.toThrow('TYPE_MISMATCH');
 expect(await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','fixture',['amount']))).toHaveLength(1);
 await owner.transaction('write',async tx=>{
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});
  await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:5,validFrom:'2020-01-01T00:00:00Z',validTo:'2021-01-01T00:00:00Z'});
 });
 const history=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','fixture',['amount']));
 expect(history).toHaveLength(2);expect(history[1]!.validFrom).toBe('2020-01-01T00:00:00.000Z');expect(history[1]!.validTo).toBe('2021-01-01T00:00:00.000Z');
 const branch=await owner.transaction('write',async tx=>(await tx.query<{id:number}>(`INSERT INTO context(parent,ref) VALUES(1,'branch') RETURNING id`)).rows[0]!.id);
 await owner.transaction('write',async tx=>{bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:branch,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:8},branch);});
 const branchRows=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','fixture',['amount']));expect(branchRows).toHaveLength(3);
 await owner.transaction('write',async tx=>{
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:branch,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});
  await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'$exists',operation:'assert',value:true,validFrom:'2200-01-01T00:00:00Z'},branch);
 });
 const active=await owner.transaction('snapshot',async tx=>(await tx.query<{scalar:boolean;set:boolean}>(`SELECT graph_vertex_active($1,'fixture',$2) AS scalar,EXISTS(SELECT 1 FROM graph_vertex_active_ids('fixture',$2) active(id) WHERE active.id=$1) AS set`,[subject.id,branch])).rows[0]!);
 expect(active).toEqual({scalar:false,set:false});

 await expect(owner.transaction('write',async tx=>{bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:2,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:9});})).rejects.toThrow('SOURCE_FORBIDDEN');
 await expect(owner.transaction('write',async tx=>{bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:productUid,contractVersion:'stale',permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:9});})).rejects.toThrow('CONTRACT_CONFLICT');
 await expect(owner.transaction('write',async tx=>{bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:newUid(),contractVersion:graphContractVersion(withAssertionContract(contract)),permissions:[{kind:'fixture',properties:['*'],assert:true,retractOwn:true}]});await writeAssertion(tx,contract,{sort:'vertex',kind:'fixture',subjectId:subject.id,property:'amount',operation:'assert',value:9});})).rejects.toThrow('SOURCE_FORBIDDEN');


 }finally{await owner.close();}
});

test('0039.28 and 29: final graph requires parents and valid mention endpoints',async()=>{
 const parent={name:'parent',table:generatedTableName('parent','vertex'),key:['name'],fields:[{name:'name',type:'text' as const},{name:'body',type:'text' as const}],capability:'fixture'};
 const child={name:'child',table:generatedTableName('child','vertex'),key:['name'],fields:[{name:'name',type:'text' as const}],capability:'fixture',keyEdges:[{role:'parent',edge:'child-parent',direction:'from' as const,onDelete:'restrict' as const}]};
 const declared:GraphContract={vertex:[parent,child],edge:[{name:'child-parent',from:['child'],to:['parent'],fields:[],repeats:false,capability:'fixture',cardinality:{from:'many',to:'one'},labels:{en:{out:'parent',in:'children'},ru:{out:'родитель',in:'дети'}}}],dictionary:[]};
 const server=await testStoreServer();const owner=await createDatabaseOwner({cluster:server,database:`required_${Date.now()}`});
 try{
 await owner.ready;await prepareGraphSchema(owner,declared);
 const binding={context:1,scope:"",contractVersion:graphContractVersion(withAssertionContract(declared)),productUid:newUid(),sourceUid:newUid(),principalUid:newUid(),operationUid:newUid(),permissions:[...declared.vertex,...declared.edge].map(kind=>({kind:kind.name,properties:['*'],assert:true,retractOwn:true}))};
 binding.scope=binding.productUid;
 const bind=async(tx:import('../src/sql-driver.js').SqlExecutor)=>{for(const [kind,uid] of [['source',binding.sourceUid],['person',binding.principalUid],['system.operation',binding.operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,binding.productUid);bindWriteCapability(tx,binding);};
 await expect(owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{kind:'child',key:{name:'orphan'},producer:'fixture',producerVersion:'1'}],removals:[]});})).rejects.toThrow('REQUIRED_PARENT');
 const parentRef={kind:'parent',key:{name:'p'}};
 await owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{...parentRef,producer:'fixture',producerVersion:'1'},{kind:'child',key:{name:'c'},keyEdges:{parent:parentRef},producer:'fixture',producerVersion:'1'}],removals:[]});});
 await expect(owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{...parentRef,values:{body:`[[uid:${newUid()}]]`},producer:'fixture',producerVersion:'1'}],removals:[]});})).rejects.toThrow('TARGET_MISSING');
 const parentUid=await owner.transaction('write',async tx=>{await bind(tx);return (await resolveEntityRef(tx,declared,parentRef)).uid;});
 await owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{...parentRef,values:{body:`emoji 😀 [[uid:${parentUid}]]`},producer:'fixture',producerVersion:'1'}],removals:[]});});
 expect(await owner.transaction('snapshot',async tx=>(await tx.query(`SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.assertion-mentions'`)).rows)).toHaveLength(1);
 const secondParent={kind:'parent',key:{name:'other'}};
 await expect(owner.transaction('write',async tx=>{
  await bind(tx);
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await tx.query('SET CONSTRAINTS ALL DEFERRED');
  await tx.query('SAVEPOINT before_extra');
  await publishGraphDrafts(tx,declared,{vertices:[{kind:'parent',key:{name:'rolled-back'},producer:'fixture',producerVersion:'1'}],removals:[]});
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await tx.query('ROLLBACK TO SAVEPOINT before_extra');
  await tx.query('SET CONSTRAINTS ALL DEFERRED');
  await publishGraphDrafts(tx,declared,{vertices:[{...secondParent,producer:'fixture',producerVersion:'1'}],edges:[{kind:'child-parent',from:{kind:'child',key:{name:'c'},keyEdges:{parent:parentRef}},to:secondParent,producer:'fixture',producerVersion:'1'}],removals:[]});
 })).rejects.toThrow('CARDINALITY_INVALID');

 await expect(owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{...secondParent,producer:'fixture',producerVersion:'1'}],edges:[{kind:'child-parent',from:{kind:'child',key:{name:'c'},keyEdges:{parent:parentRef}},to:secondParent,producer:'fixture',producerVersion:'1'}],removals:[]});})).rejects.toThrow('CARDINALITY_INVALID');
 await expect(owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[],edgeRemovals:[{kind:'child-parent',from:{kind:'child',key:{name:'c'},keyEdges:{parent:parentRef}},to:parentRef,producer:'fixture'}],removals:[]});})).rejects.toThrow('CARDINALITY_INVALID');
 await expect(owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[],removals:[{...parentRef,producer:'fixture'}]});})).rejects.toThrow('PARENT_DELETE_RESTRICTED');
 }finally{await owner.close();}
});

test('0039.28: shared origin and parent key identities travel between products',async()=>{
 const namespace='019a0000-0000-7000-8000-000000000099';
 const declared:GraphContract={vertex:[{name:'shared',table:generatedTableName('shared','vertex'),fields:[{name:'origin',type:'text'}],key:['origin'],identity:{namespace,origin:['origin']},capability:'fixture'}],edge:[],dictionary:[]};
 const server=await testStoreServer();const owner=await createDatabaseOwner({cluster:server,database:`federation_${Date.now()}`});
 try{await owner.ready;await prepareGraphSchema(owner,declared);
 const sourceUid=newUid(),principalUid=newUid(),operationUid=newUid(),productUid=newUid();
 const first=await owner.transaction('write',async tx=>{
  for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid,context:1,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(declared)),permissions:[{kind:'shared',properties:['*'],assert:true,retractOwn:true}]});
  await publishGraphDrafts(tx,declared,{vertices:[{kind:'shared',key:{origin:'canonical'},producer:'fixture',producerVersion:'1'}],removals:[]});
  return (await resolveEntityRef(tx,declared,{kind:'shared',key:{origin:'canonical'}})).uid;
 });
 const second=await owner.transaction('write',async tx=>{
  bindWriteCapability(tx,{sourceUid,principalUid,operationUid,productUid:newUid(),context:1,scope:first,contractVersion:graphContractVersion(withAssertionContract(declared)),permissions:[{kind:'shared',properties:['*'],assert:true,retractOwn:true}]});
  return (await resolveEntityRef(tx,declared,{kind:'shared',key:{origin:'canonical'}})).uid;
 });expect(first).toBe(second);
 }finally{await owner.close();}
});

test('0039.28: parent cascade retires children without deleting their history',async()=>{
 const declared:GraphContract={vertex:[{name:'root',table:'root',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},{name:'leaf',table:'leaf',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture',keyEdges:[{role:'root',edge:'belongs',direction:'from',onDelete:'cascade'}]}],edge:[{name:'belongs',from:['leaf'],to:['root'],fields:[],repeats:false,capability:'fixture',cardinality:{from:'many',to:'one'},labels:{en:{out:'root',in:'leaves'},ru:{out:'корень',in:'листья'}}}],dictionary:[]};
 const server=await testStoreServer();const owner=await createDatabaseOwner({cluster:server,database:`cascade_${Date.now()}`});
 try{await owner.ready;await prepareGraphSchema(owner,declared);
 const productUid=newUid(),sourceUid=newUid(),principalUid=newUid(),operationUid=newUid();
 const bind=async(tx:import('../src/sql-driver.js').SqlExecutor)=>{for(const [kind,uid] of [['source',sourceUid],['person',principalUid],['system.operation',operationUid]])await bootstrapWriteIdentity(tx,kind!,uid!,productUid);bindWriteCapability(tx,{productUid,sourceUid,principalUid,operationUid,context:1,scope:productUid,contractVersion:graphContractVersion(withAssertionContract(declared)),permissions:[...declared.vertex,...declared.edge].map(k=>({kind:k.name,properties:['*'],assert:true,retractOwn:true}))});};
 const root={kind:'root',key:{name:'r'}},leaf={kind:'leaf',key:{name:'l'},keyEdges:{root}};
 await owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[{...root,producer:'fixture',producerVersion:'1'},{...leaf,producer:'fixture',producerVersion:'1'}],removals:[]});});
 await owner.transaction('write',async tx=>{await bind(tx);await publishGraphDrafts(tx,declared,{vertices:[],removals:[{...root,producer:'fixture'}]});});
 const history=await owner.transaction('snapshot',tx=>loadAssertions(tx,'vertex','leaf',['$exists']));expect(history.map(h=>h.operation)).toEqual(['assert','retract']);
 await expect(owner.transaction('write',async tx=>{await bind(tx);await resolveEntityRef(tx,declared,leaf);})).rejects.toThrow('MISSING_ENDPOINT');
 }finally{await owner.close();}
});

test('deferred typed table validation rejects malformed direct SQL and permits complete assertion/retraction',async()=>{
 const graph:GraphContract={vertex:['one','two'].map(name=>({name,table:name,key:['name'],fields:[{name:'name',type:'text' as const},{name:'amount',type:'integer' as const},{name:'other',type:'integer' as const}],capability:'fixture'})),edge:[],dictionary:[]};
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{kind:'one',key:{name:'a'},values:{amount:1},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const original=await owner.run(async tx=>(await tx.query<{id:string}>(`SELECT assertion_id::text AS id FROM "${assertionValueTableName('one','vertex','amount')}"`)).rows[0]!.id);
 async function clone(property:string,operation:string,tables:string[]){return owner.transaction('write',async tx=>{
 const id=(await tx.query<{id:string}>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id) SELECT entity_id,$1,key,identity_scope,context_id FROM node WHERE id=$2 RETURNING id::text`,[newUid(),original])).rows[0]!.id;
 await tx.query(`INSERT INTO assertion(assertion_id,property,context_id,valid_from,operation) SELECT $1,$2,context_id,valid_from,$3 FROM assertion WHERE assertion_id=$4`,[id,property,operation,original]);
 const edges=(await tx.query<{entity_id:string,to_node:string,discriminator:string,context_id:number}>(`SELECT entity_id,to_node,discriminator,context_id FROM edge WHERE from_node=$1`,[original])).rows;
 for(const e of edges){const edge=(await tx.query<{id:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,[newUid(),e.entity_id,id,e.to_node,e.discriminator,e.context_id])).rows[0]!.id;
 await tx.query(`INSERT INTO assertion_vertex_subject(assertion_id,subject_edge_id) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM assertion_vertex_subject WHERE assertion_id=$3 AND subject_edge_id IN(SELECT id FROM edge WHERE entity_id=$4 AND from_node=$3))`,[id,edge,original,e.entity_id]);}
 for(const table of tables)await tx.query(`INSERT INTO "${table}"(assertion_id,value) VALUES($1,2)`,[id]);
 });}
 const right=assertionValueTableName('one','vertex','amount'),wrongProperty=assertionValueTableName('one','vertex','other'),wrongKind=assertionValueTableName('two','vertex','amount');
 await clone('amount','assert',[right]);
 await clone('amount','retract',[]);
 const invalid:readonly [string,'assert'|'retract',string[],string][]=[
  ['amount','assert',[],'assertion requires exactly one typed value'],
  ['unknown','assert',[right],'assertion requires exactly one typed value'],
  ['amount','assert',[wrongProperty],'assertion requires exactly one typed value'],
  ['amount','assert',[wrongKind],'assertion requires exactly one typed value'],
  ['amount','assert',[right,wrongProperty],'assertion value does not match declared subject/property'],
  ['amount','retract',[right],'assertion value does not match declared subject/property'],
 ];
 for(const [property,operation,tables,message] of invalid)await expect(clone(property,operation,tables)).rejects.toThrow(message);
 }finally{await owner.close();}
},60000);



test('deferred endpoint validation rejects direct SQL deactivation of either live relation endpoint',async()=>{
 const graph:GraphContract={
  vertex:['endpoint-from','endpoint-to'].map(name=>({name,table:generatedTableName(name,'vertex'),key:['name'],fields:[{name:'name',type:'text' as const}],capability:'fixture'})),
  edge:[{name:'endpoint-link',from:['endpoint-from'],to:['endpoint-to'],fields:[],repeats:false,capability:'fixture',cardinality:{from:'many',to:'many'},labels:{en:{out:'target',in:'source'},ru:{out:'target',in:'source'}}}],dictionary:[],
 };
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  const from={kind:'endpoint-from',key:{name:'from'}},to={kind:'endpoint-to',key:{name:'to'}};
  await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{
   vertices:[{...from,producer:'fixture',producerVersion:'1'},{...to,producer:'fixture',producerVersion:'1'}],
   edges:[{kind:'endpoint-link',from,to,producer:'fixture',producerVersion:'1'}],removals:[],
  }));
  for(const kind of ['endpoint-from','endpoint-to']){
   await expect(owner.transaction('write',async tx=>{
    const original=(await tx.query<{assertion_id:string;subject_id:string}>(`SELECT a.assertion_id::text,subject.id::text AS subject_id
      FROM assertion a JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
      JOIN edge attachment ON attachment.id=s.subject_edge_id JOIN node subject ON subject.id=attachment.to_node
      JOIN entity k ON k.id=subject.entity_id WHERE k.name=$1 AND a.property='$exists' AND a.context_id=1
      ORDER BY a.recorded_sequence DESC LIMIT 1`,[kind])).rows[0]!;
    // Clone the authenticated assertion's subject and lineage, but supersede its existence value through SQL alone.
    const id=(await tx.query<{id:string}>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id)
      SELECT entity_id,$1,key,identity_scope,context_id FROM node WHERE id=$2 RETURNING id::text`,[newUid(),original.assertion_id])).rows[0]!.id;
    await tx.query(`INSERT INTO assertion(assertion_id,property,language,context_id,valid_from,valid_to,operation)
      SELECT $1,property,language,context_id,valid_from,valid_to,operation FROM assertion WHERE assertion_id=$2`,[id,original.assertion_id]);
    const bindings=(await tx.query<{id:string;entity_id:string;to_node:string;discriminator:string;context_id:number}>(
      `SELECT id::text,entity_id,to_node,discriminator,context_id FROM edge WHERE from_node=$1`,[original.assertion_id])).rows;
    for(const binding of bindings){
     const edge=(await tx.query<{id:string}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,[newUid(),binding.entity_id,id,binding.to_node,binding.discriminator,binding.context_id])).rows[0]!.id;
     await tx.query(`INSERT INTO assertion_vertex_subject(assertion_id,subject_edge_id)
       SELECT $1,$2 FROM assertion_vertex_subject WHERE assertion_id=$3 AND subject_edge_id=$4`,[id,edge,original.assertion_id,binding.id]);
    }
    await tx.query(`INSERT INTO "${assertionValueTableName(kind,'vertex','$exists')}"(assertion_id,value) VALUES($1,false)`,[id]);
    expect((await tx.query(`SELECT id FROM graph_vertex_active_ids($1,1) active(id) WHERE id=$2`,[kind,original.subject_id])).rows).toHaveLength(0);
    expect((await tx.query(`SELECT id FROM graph_edge_active_ids('endpoint-link',1) active(id)`)).rows).toHaveLength(1);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
   })).rejects.toThrow('TARGET_MISSING or END_KIND_INVALID for endpoint-link');
  }
 }finally{await owner.close();}
},60000);

test('disputed SQL existence fails closed after later writes and restores projection on savepoint rollback',async()=>{
 const graph:GraphContract={vertex:[{name:'guarded',table:'guarded',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{await owner.transaction('write',async tx=>{
  await publishGraphDrafts(tx,graph,{vertices:[{kind:'guarded',key:{name:'fixture'},producer:'fixture',producerVersion:'1'}],removals:[]});
  await tx.query(`INSERT INTO node(entity_id,uid,identity_scope) SELECT id,$1,$2 FROM entity WHERE name='system.dispute-resolution'`,[newUid(),newUid()]);
  await tx.query('SAVEPOINT absent_projection');
  await expect(tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rejects.toThrow('DISPUTE_SELECTION_STALE');
  await tx.query('ROLLBACK TO SAVEPOINT absent_projection');

  const fresh=(await tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rows;
  expect(fresh).toHaveLength(1);
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await tx.query('SET CONSTRAINTS ALL DEFERRED');
  await tx.query('SAVEPOINT fresh_projection');
  await tx.query(`INSERT INTO context(parent,ref) VALUES(1,'invalidate')`);
  await expect(tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rejects.toThrow('DISPUTE_SELECTION_STALE');
  await tx.query('ROLLBACK TO SAVEPOINT fresh_projection');
  expect((await tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rows).toEqual(fresh);
  const assertion=(await tx.query<{id:string;edge:string}>(`SELECT a.assertion_id::text AS id,e.id::text AS edge FROM assertion a JOIN edge e ON e.from_node=a.assertion_id WHERE a.property='name' LIMIT 1`)).rows[0]!;
  for(const mutate of [
   ()=>tx.query(`INSERT INTO assertion_edge_subject(assertion_id,edge_id) VALUES($1,$2)`,[assertion.id,assertion.edge]),
   ()=>tx.query(`INSERT INTO "${assertionValueTableName('guarded','vertex','$exists')}"(assertion_id,value) VALUES($1,true)`,[assertion.id]),
  ]){
   await tx.query('SAVEPOINT late_attachment');
   await mutate();
   await expect(tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rejects.toThrow('DISPUTE_SELECTION_STALE');
   await tx.query('ROLLBACK TO SAVEPOINT late_attachment');
   expect((await tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rows).toEqual(fresh);
  }
 });
 await owner.transaction('snapshot',async tx=>{
  await tx.query('SAVEPOINT before_projection');
  await expect(tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rejects.toThrow('DISPUTE_SELECTION_STALE');
  await tx.query('ROLLBACK TO SAVEPOINT before_projection');

  expect((await tx.query(`SELECT * FROM graph_vertex_active_ids('guarded',1)`)).rows).toHaveLength(1);
 });
 }finally{await owner.close();}
},60000);
