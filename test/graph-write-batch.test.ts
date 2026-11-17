/** Batch admission counters: decision 0039 items 25–29, ALX-117. */
import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {type GraphContract,type VertexDraft,type EdgeDraft} from '../src/graph/contract.js';
import {publishGraphDrafts,ensureVertex} from '../src/graph/write.js';
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
 // values/content (2), assertion CTE (1), six typed value tables (6), repeat
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
