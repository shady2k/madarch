import {expect,test} from 'bun:test';
import {type GraphContract} from '../src/graph/contract.js';
import {ensureVertex,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {createTestDatabaseOwner} from './test-database.js';

const contract:GraphContract={vertex:['activity.left','activity.right'].map(name=>({name,table:name.replace('.','_'),key:['name'],fields:[{name:'name',type:'text'},{name:'text',type:'text',nullable:true}],capability:'fixture'})),edge:[],dictionary:[]};
const producer={producer:'fixture',producerVersion:'1'};

test('endpoint activity selection runs once per kind and keeps first inactive mention refusal',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  const refs=Array.from({length:6},(_,i)=>({kind:i%2===0?'activity.left':'activity.right',key:{name:`target-${i}`}}));
  const targets=await owner.transaction('write',async tx=>{
   await publishGraphDrafts(tx,contract,{vertices:refs.map(ref=>({...ref,...producer})),removals:[]});
   return Promise.all(refs.map(ref=>ensureVertex(tx,contract,ref)));
  });
  const subject={kind:'activity.left',key:{name:'subject'},values:{text:targets.map(target=>`[[uid:${target.uid}]]`).join(' ')},...producer};
  const calls=await owner.transaction('write',async tx=>{
   await tx.query("SET LOCAL track_functions = 'all'");
   const query=tx.query.bind(tx);let calls=0;
   const count=async()=>Number((await query<{calls:string}>("SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_xact_user_functions WHERE funcname='graph_vertex_active_ids_batch'")).rows[0]!.calls);
   tx.query=async<Row extends object>(sql:string,values?:readonly unknown[])=>{
    if(!sql.includes('graph_vertex_active'))return query<Row>(sql,values);
    const before=await count();const result=await query<Row>(sql,values);calls+=await count()-before;return result;
   };
   try{await publishGraphDrafts(tx,contract,{vertices:[subject],removals:[]});}finally{tx.query=query;}
   return calls;
  });
  expect(calls).toBe(2);
  await owner.transaction('write',async tx=>{
   for(const i of [4,1])await writeAssertion(tx,contract,{sort:'vertex',kind:refs[i]!.kind,subjectId:targets[i]!.nodeId,property:'$exists',operation:'assert',value:false});
  });
  await expect(owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[subject],removals:[]}))).rejects.toThrow(`TARGET_MISSING /values/text activity.right ${targets[1]!.uid}`);
 }finally{await owner.close();}
},30000);
