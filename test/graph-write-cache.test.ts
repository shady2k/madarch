/** Immutable lookup lifetime: decision 0039 items 25, 28 and 31. */
import {expect,test} from 'bun:test';
import {type GraphContract} from '../src/graph/contract.js';
import {bindWriteCapability,ensureVertex,publishGraphDrafts,requireWriteCapability} from '../src/graph/write.js';
import {createTestDatabaseOwner,prepareTestStore} from './test-database.js';
const graph:GraphContract={vertex:[{name:'cache.subject',table:'unused',key:['name'],fields:[{name:'name',type:'text'},{name:'value',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
const subject={kind:'cache.subject',key:{name:'same'}};
const draft={...subject,values:{value:'one'},producer:'fixture',producerVersion:'1'};
test('committed identities avoid kind and uid reads in a later transaction',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  const run=()=>owner.transaction('write',async tx=>{
   const query=tx.query.bind(tx);const statements:string[]=[];
   tx.query=async(sql,values)=>{statements.push(sql);return query(sql,values);};
   try{await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});}
   finally{tx.query=query;}
   return {statements:statements.length,kinds:statements.filter(sql=>sql.includes('FROM entity WHERE name=$1')).length,identities:statements.filter(sql=>sql.includes('WHERE n.uid=$1::uuid FOR UPDATE')).length};
  });
  const first=await run(),second=await run();console.log('cache statements',JSON.stringify({first,second}));
  expect(second.kinds).toBe(0);expect(second.identities).toBe(0);expect(second.statements).toBeLessThan(first.statements);
 }finally{await owner.close();}
},30000);
test('a rolled back birth never supplies the later id',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});let abandoned='';
 try{
  await expect(owner.transaction('write',async tx=>{abandoned=(await ensureVertex(tx,graph,subject)).nodeId;throw new Error('rollback');})).rejects.toThrow('rollback');
  const kept=await owner.transaction('write',async tx=>{const made=await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return made;});
  expect(kept.nodeId).not.toBe(abandoned);
  const stored=await owner.run(tx=>tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[kept.uid]));expect(stored.rows).toEqual([{id:kept.nodeId}]);
 }finally{await owner.close();}
},30000);
test('separate databases cannot share local ids',async()=>{
 const a=await createTestDatabaseOwner({graphContract:graph}),b=await createTestDatabaseOwner({graphContract:graph});
 try{
  const binding=await a.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return requireWriteCapability(tx);});
  const held=await b.transaction('write',async tx=>{const own=requireWriteCapability(tx);bindWriteCapability(tx,{...own,productUid:binding.productUid,scope:binding.productUid});await tx.query("SELECT setval(pg_get_serial_sequence('node','id'),100000)");const made=await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});return made;});
  expect(Number(held.nodeId)).toBeGreaterThan(100000);
 }finally{await a.close();await b.close();}
},30000);
test('schema reinstall cannot reuse an earlier kind id',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]}));
  await prepareTestStore(owner,{reset:true,contract:graph});
  await owner.transaction('write',async tx=>{await tx.query("SELECT setval(pg_get_serial_sequence('entity','id'),100000)");});
  const extended={...graph,vertex:[...graph.vertex,{name:'cache.later',table:'unused_later',key:['name'],fields:[{name:'name',type:'text' as const}],capability:'fixture'}]};
  await prepareTestStore(owner,{contract:extended});
  await owner.transaction('write',async tx=>{await ensureVertex(tx,graph,subject);await publishGraphDrafts(tx,graph,{vertices:[draft],removals:[]});});
 }finally{await owner.close();}
},30000);
