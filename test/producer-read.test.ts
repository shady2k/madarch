import { expect, test, spyOn } from 'bun:test';
import { Client } from 'pg';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';
import { publishGraphDrafts, removeEntity } from '../src/graph/write.js';
import { producerEntities, referenceOf } from '../src/graph/plugin-turns.js';
import { readKindAssertions } from '../src/graph/records.js';
import type { EntityRefDraft, GraphContract } from '../src/graph/contract.js';

const contract: GraphContract = { vertex: [
 {name:'sample',table:'unused',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture',keyEdges:[{role:'parent',edge:'sample-parent',direction:'from',onDelete:'restrict'}]},
 {name:'parent',table:'unused',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},
 {name:'file',table:'unused',evidence:{immutable:true},key:['path'],fields:[{name:'path',type:'text'}],capability:'fixture'},
],edge:[{name:'sample-parent',from:['sample'],to:['parent'],fields:[],repeats:false,cardinality:{from:'many',to:'one'},labels:{en:{out:'parent',in:'children'},ru:{out:'parent',in:'children'}},capability:'fixture'}],dictionary:[]};
const other = '019a0000-0000-7000-8000-000000000003';

test('producer references reconstruct two key-edge levels through an any endpoint', async () => {
 const nested: GraphContract = {
  ...contract,
  vertex: [
   ...contract.vertex.map(vertex => vertex.name === 'parent' ? {
    ...vertex, keyEdges: [{ role: 'root', edge: 'root-parent', direction: 'to' as const, onDelete: 'restrict' as const }],
   } : vertex),
   {name:'root',table:'unused',key:['name'],fields:[{name:'name',type:'text'}],capability:'fixture'},
  ],
  edge: [
   {...contract.edge[0]!,to:['any']},
   {...contract.edge[0]!,name:'root-parent',from:['root'],to:['parent']},
  ],
 };
 const root: EntityRefDraft = {kind:'root',key:{name:'top'}};
 const parent: EntityRefDraft = {kind:'parent',key:{name:'middle'},keyEdges:{root}};
 const sample: EntityRefDraft = {kind:'sample',key:{name:'leaf'},keyEdges:{parent}};
 const owner = await createTestDatabaseOwner({graphContract:nested});
 try {
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,nested);
   await publishGraphDrafts(tx,nested,{
    vertices:[root,parent,sample].map(ref=>({...ref,values:{},producer:'fixture',producerVersion:'1'})),
    edges:[
     {kind:'root-parent',from:root,to:parent,producer:'fixture',producerVersion:'1'},
     {kind:'sample-parent',from:sample,to:parent,producer:'fixture',producerVersion:'1'},
    ],removals:[],
   });
  });
  const rows = await producerEntities(owner,nested,'sample',TEST_SOURCE_UID);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({key:sample.key,keyEdges:{parent}});
  const expected = await owner.transaction('snapshot',async tx=>{
   const held = await readKindAssertions(tx,'vertex','sample',[],{contract:nested});
   return await referenceOf(tx,nested,'sample',held[0]!.id);
  });
  expect(rows[0]!.keyEdges).toEqual(expected.keyEdges!);
 } finally {await owner.close();}
},60_000);


test('producer reads keep all opinions and evidence but use the same query count for 2 and 200 entities', async () => {
 const owner = await createTestDatabaseOwner({graphContract:contract});
 try {
  const write = async (count: number, source=TEST_SOURCE_UID) => owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,contract,source);
   await publishGraphDrafts(tx,contract,{vertices:[{kind:'parent',key:{name:'root'},values:{},producer:'fixture',producerVersion:'1'}, {kind:'file',key:{path:'a.ts'},values:{},producer:'fixture',producerVersion:'1'},...Array.from({length:count},(_,i)=>({kind:'sample',key:{name:String(i)},keyEdges:{parent:{kind:'parent',key:{name:'root'}}},values:{},evidence:[{target:{kind:'file',key:{path:'a.ts'}}}],producer:'fixture',producerVersion:'1'}))],edges:Array.from({length:count},(_,i)=>({kind:'sample-parent',from:{kind:'sample',key:{name:String(i)},keyEdges:{parent:{kind:'parent',key:{name:'root'}}}},to:{kind:'parent',key:{name:'root'}},producer:'fixture',producerVersion:'1'})),removals:[]});
  });
  const measure = async () => {
   let queries=0; const original=Client.prototype.query;
   const spy=spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){queries++;return Reflect.apply(original,this,args);} as typeof original);
   const start=performance.now();
   try { const rows=await producerEntities(owner,contract,'sample',TEST_SOURCE_UID);console.log('producer measurement',JSON.stringify({count:rows.length,queries,ms:performance.now()-start}));return {rows,queries}; } finally {spy.mockRestore();}
  };
  await write(2);
  const small=await measure(); expect(small.rows).toHaveLength(2);
  await write(201);
  await write(202,other);
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,contract);await removeEntity(tx,contract,{kind:'sample',producer:'fixture',key:{name:'0'},keyEdges:{parent:{kind:'parent',key:{name:'root'}}}});});
  const large=await measure(); expect(large.rows).toHaveLength(200);
  expect(large.rows.every(row=>row.path==='a.ts')).toBe(true);
  expect(large.rows.some(row=>row.key.name==='201'||row.key.name==='0')).toBe(false);
  const expected=await owner.transaction('snapshot',async tx=>{
   const rows=await readKindAssertions(tx,'vertex','sample',[],{contract});
   const selected=rows.filter(row=>row.activeSources.includes(TEST_SOURCE_UID));
   const ref=await referenceOf(tx,contract,'sample',selected[0]!.id);
   return selected.map(row=>({key:row.key,uid:row.uid,path:'a.ts',keyEdges:ref.keyEdges??{}}));
  });
  expect(large.rows as unknown[]).toEqual(expected as unknown[]);
  expect(large.queries).toBe(small.queries);
 } finally {await owner.close();}
},300_000);
