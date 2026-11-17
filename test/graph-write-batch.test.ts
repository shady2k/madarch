/** Batch admission counters: decision 0039 items 25–29, ALX-117. */
import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {type GraphContract,type VertexDraft,type EdgeDraft} from '../src/graph/contract.js';
import {publishGraphDrafts,ensureVertex,bindWriteCapability,requireWriteCapability} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {createTestDatabaseOwner} from './test-database.js';

const labels={en:{out:'to',in:'from'},ru:{out:'to',in:'from'}};
const contract:GraphContract={vertex:[
 {name:'batch.repository',table:'unused_repository',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},
 {name:'batch.file',table:'unused_file',key:['path'],keyEdges:[{role:'repository',edge:'batch.parent',direction:'from',onDelete:'restrict'}],fields:[{name:'path',type:'text'},{name:'text',type:'text'},{name:'size',type:'integer'}],capability:'fixture'},
 {name:'batch.snapshot',table:'unused_snapshot',key:['digest'],fields:[{name:'digest',type:'text'},{name:'content',type:'text'}],evidence:{immutable:true,digestField:'digest',contentField:'content',digestAlgorithm:'sha256'},capability:'fixture'},
],edge:[
 {name:'batch.parent',from:['batch.file'],to:['batch.repository'],fields:[],repeats:false,cardinality:{from:'many',to:'one'},labels,capability:'fixture'},
 {name:'batch.related',from:['batch.file'],to:['batch.repository'],fields:[],repeats:false,cardinality:{from:'many',to:'many'},labels,capability:'fixture'},
],dictionary:[]};
const producer={producer:'fixture',producerVersion:'1'};
const repository={kind:'batch.repository',key:{name:'example'}};
const content='immutable snapshot';
const snapshot={kind:'batch.snapshot',key:{digest:createHash('sha256').update(content).digest('hex')}};
async function measure(count:number){
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  const uid=await owner.transaction('write',async tx=>{
   await publishGraphDrafts(tx,contract,{vertices:[{...repository,...producer},{...snapshot,values:{content},...producer}],removals:[]});
   return (await ensureVertex(tx,contract,repository)).uid;
  });
  const vertices:VertexDraft[]=Array.from({length:count},(_,i)=>({kind:'batch.file',key:{path:`file-${i}`},keyEdges:{repository},values:{text:`[[uid:${uid}]]`,size:i},evidence:[{target:snapshot,locator:{start:0,end:content.length}}],...producer}));
  const edges:EdgeDraft[]=vertices.map(from=>({kind:'batch.related',from,to:repository,...producer}));
  const run=()=>owner.transaction('write',async tx=>{
   const before=Number((await tx.query<{count:string}>('SELECT count(*)::text AS count FROM assertion')).rows[0]!.count);
   const query=tx.query.bind(tx);let statements=0;
   tx.query=async(sql,values)=>{statements++;return query(sql,values);};
   try{await publishGraphDrafts(tx,contract,{vertices,edges,removals:[]});}finally{tx.query=query;}
   const after=Number((await tx.query<{count:string}>('SELECT count(*)::text AS count FROM assertion')).rows[0]!.count);
   return {statements,added:after-before};
  });
  const first=await run();
  const repeat=await run();
  return {first:first.statements,repeat:repeat.statements,added:repeat.added};
 }finally{await owner.close();}
}
test('ALX-117: 10 and 100 evidenced files have constant publication statements, including repeats',async()=>{
 const ten=await measure(10),hundred=await measure(100);
 console.log('ALX-117 counters',JSON.stringify({ten,hundred}));
 // Phase bound: lock + catalogue + identities/parents + node insert + ordered lock (5),
 // edge insert/read (2), endpoint activity (1), scope (1), streams (1), immutable
 // values/content (1), assertion CTE (1), seven typed value tables (7), repeat
 // lineage (1), evidence/mentions insert (1). Total 21; no array slicing allowance.
 expect(ten.first).toBeLessThanOrEqual(21);
 expect(hundred.first).toBe(ten.first);
 expect(hundred.repeat).toBe(hundred.first);
 expect(hundred.added).toBe(0);
},120000);

test('ALX-117: a later assertion in one batch wins the slot in recorded order',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[{...repository,...producer}],removals:[]}));
  const file={kind:'batch.file',key:{path:'same'},keyEdges:{repository},...producer};
  await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[{...file,values:{text:'first'}},{...file,values:{text:'last'}}],removals:[]}));
  const rows=await owner.run(tx=>loadAssertions(tx,'vertex','batch.file',['text'],undefined,{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}));
  expect(rows.map(row=>row.value)).toEqual(['first','last']);
  expect(rows.find(row=>row.selected)?.value).toBe('last');
 }finally{await owner.close();}
},30000);

test('ALX-117: JSON null remains a typed JSON value and batch headers share admission time',async()=>{
 const graph:GraphContract={vertex:[{name:'batch.json',table:'unused_json',key:['name'],fields:[{name:'name',type:'text'},{name:'payload',type:'json',nullable:true,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:['object','null']}}],capability:'fixture'}],edge:[],dictionary:[]};
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{kind:'batch.json',key:{name:'one'},values:{payload:null},...producer},{kind:'batch.json',key:{name:'two'},values:{payload:{a:1}},...producer}],removals:[]}));
  const rows=await owner.run(tx=>loadAssertions(tx,'vertex','batch.json',['payload']));
  expect(rows.map(row=>row.value)).toEqual([null,{a:1}]);
  const times=await owner.run(tx=>tx.query<{starts:string}>(`SELECT count(DISTINCT a.valid_from)::text AS starts FROM assertion a JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id JOIN edge e ON e.id=s.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE k.name='batch.json'`));
  expect(times.rows).toEqual([{starts:'1'}]);
 }finally{await owner.close();}
},30000);

async function measureStore(size:number,scoped:boolean){
 const graph:GraphContract={...contract,vertex:contract.vertex.map(kind=>kind.name==='batch.snapshot'?{...kind,keyEdges:[{role:'repository',edge:'batch.snapshot-parent',direction:'from' as const,onDelete:'restrict' as const}]}:kind),edge:[...contract.edge,{name:'batch.snapshot-parent',from:['batch.snapshot'],to:['batch.repository'],fields:[],repeats:false,cardinality:{from:'many',to:'one'},labels,capability:'fixture'}]};
 const support={...snapshot,keyEdges:{repository}};
 const owner=await createTestDatabaseOwner({graphContract:graph});
 try{
  const uid=await owner.transaction('write',async tx=>{
   await publishGraphDrafts(tx,graph,{vertices:[{...repository,...producer},{...support,values:{content},...producer}],removals:[]});
   return (await ensureVertex(tx,graph,repository)).uid;
  });
  const file=(i:number):VertexDraft=>({kind:'batch.file',key:{path:`file-${i}`},keyEdges:{repository},values:{text:`[[uid:${uid}]]`,size:i},evidence:[{target:support,locator:{start:0,end:content.length}}],...producer});
  const publish=(vertices:VertexDraft[])=>({vertices,edges:vertices.map(from=>({kind:'batch.related',from,to:repository,...producer})),removals:[]});
  await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,publish(Array.from({length:size},(_,i)=>file(i)))));
  return await owner.transaction('write',async tx=>{
   if(scoped)bindWriteCapability(tx,{...requireWriteCapability(tx),scope:uid});
   await tx.query('SET LOCAL enable_seqscan = off');
   // Server counters cover graph identities, attachments, headers and typed values,
   // but not the catalogue or authentication setup outside this invocation.
   const stats=async()=> (await tx.query<{reads:string;inserted:string}>(`SELECT coalesce(sum(seq_tup_read+idx_tup_fetch),0)::text AS reads,coalesce(sum(n_tup_ins) FILTER(WHERE relname='assertion'),0)::text AS inserted FROM pg_stat_xact_user_tables WHERE relname IN ('node','edge','assertion','assertion_vertex_subject','assertion_edge_subject') OR relname ~ '^a_[0-9a-f]{32}$'`)).rows[0]!;
   const before=await stats();const query=tx.query.bind(tx);let statements=0;
   tx.query=async(sql,values)=>{statements++;return query(sql,values);};
   try{await publishGraphDrafts(tx,graph,publish([...Array.from({length:10},(_,i)=>file(size+i)),...Array.from({length:10},(_,i)=>file(i))]));}finally{tx.query=query;}
   const after=await stats();
   return {reads:Number(after.reads)-Number(before.reads),statements,inserted:Number(after.inserted)-Number(before.inserted)};
  });
 }finally{await owner.close();}
}
for(const scoped of [false,true])test(`ALX-142: store reads stay equal for 50 and 500 files, scoped=${scoped}`,async()=>{
 const small=await measureStore(50,scoped),large=await measureStore(500,scoped);
 console.log('ALX-142 store counters',JSON.stringify({scoped,small,large}));
 expect(small.statements).toBeGreaterThanOrEqual(15);expect(large.statements).toBeGreaterThanOrEqual(15);
 // Ten fresh files: existence, path, text, size, parent and related edge.
 expect(small.inserted).toBe(60);expect(large.inserted).toBe(60);
 expect(large.statements).toBe(small.statements);expect(large.reads).toBe(small.reads);
},120000);

test('ALX-142: fixed admission phases name the first failing draft within each phase and roll back',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:contract});
 try{
  await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:[{...repository,...producer},{...snapshot,values:{content},...producer}],removals:[]}));
  const ids=await owner.transaction('write',async tx=>{await publishGraphDrafts(tx,contract,{vertices:Array.from({length:5},(_,i)=>({kind:'batch.file',key:{path:`error-${i+1}`},keyEdges:{repository},...producer})),removals:[]});return Promise.all(Array.from({length:5},(_,i)=>ensureVertex(tx,contract,{kind:'batch.file',key:{path:`error-${i+1}`},keyEdges:{repository}})));});
  const counts=()=>owner.run(async tx=>(await tx.query(`SELECT (SELECT count(*) FROM node)::text AS nodes,(SELECT count(*) FROM edge)::text AS edges,(SELECT count(*) FROM assertion)::text AS assertions`)).rows);
  const file=(i:number):VertexDraft=>({kind:'batch.file',uid:ids[i-1]!.uid,key:{path:`error-${i}`},keyEdges:{repository},values:{size:i},...producer});
  const evidence={...file(2),evidence:[{target:snapshot,locator:{start:0,end:content.length+1}}]};
  const absent=(i:number):VertexDraft=>({...file(i),evidence:[{target:{...snapshot,key:{digest:'missing'}},locator:{}}]});
  const cases=[
   {vertices:[file(1),evidence,absent(3),{...file(4),values:{size:'x' as unknown as number}},file(5)],code:'TYPE_MISMATCH',index:4},
   {vertices:[file(1),evidence,absent(3),file(5)],code:'MISSING_ENDPOINT',index:3},
   {vertices:[file(1),evidence,file(5)],code:'EVIDENCE_INVALID',index:2},
   {vertices:[file(1),absent(2),file(3),absent(4),file(5)],code:'MISSING_ENDPOINT',index:2},
  ];
  for(const scenario of cases){const before=await counts();let error='';try{await owner.transaction('write',tx=>publishGraphDrafts(tx,contract,{vertices:scenario.vertices,removals:[]}));}catch(cause){error=String(cause);}
   console.log('ALX-142 phase error',scenario.code,scenario.index,error);
   expect(await counts()).toEqual(before);expect(error).toContain(scenario.code);expect(error).toContain('batch.file');expect(error).toContain(ids[scenario.index-1]!.uid);
  }
 }finally{await owner.close();}
},30000);
