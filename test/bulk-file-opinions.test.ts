/** Batching preserves typed assertion streams, selection and rollback (0039.24–25). */
import { expect,test } from 'bun:test';
import { generatedTableName,type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { loadAssertions,selectAssertionSlots } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';
const graph:GraphContract={vertex:[{name:'file',table:generatedTableName('file','vertex'),key:['path'],fields:[{name:'path',type:'text'},{name:'language',type:'text'}],capability:'fixture'}],edge:[],dictionary:[]};
test('0039.25: batch and singleton publication preserve the same source histories and effective values',async()=>{
 const owners=await Promise.all([createTestDatabaseOwner({graphContract:graph}),createTestDatabaseOwner({graphContract:graph})]);
 try{
 const snapshots=[];
 for(const [mode,owner] of owners.entries()){
 const turns=[['TypeScript','XML'],['TypeScript','XML'],['JavaScript','JSON']];
 for(const languages of turns)await owner.transaction('write',async tx=>{
 const vertices=languages.map((language,index)=>({kind:'file',key:{path:`${index}.txt`},values:{language},producer:'fixture',producerVersion:'1'}));
 if(mode===0)await publishGraphDrafts(tx,graph,{vertices,removals:[]});else for(const vertex of vertices)await publishGraphDrafts(tx,graph,{vertices:[vertex],removals:[]});
 });
 const history=await owner.run(tx=>loadAssertions(tx,'vertex','file',['language']));
 await expect(owner.transaction('write',async tx=>{await publishGraphDrafts(tx,graph,{vertices:[{kind:'file',key:{path:'0.txt'},values:{language:'rollback'},producer:'fixture',producerVersion:'1'}],removals:[]});throw new Error('rollback');})).rejects.toThrow('rollback');
 expect(await owner.run(tx=>loadAssertions(tx,'vertex','file',['language']))).toEqual(history);
 const now=new Date().toISOString();
 snapshots.push({history:history.map(a=>[a.subject,a.source,a.property,a.value,a.operation]),selected:[...selectAssertionSlots(history,{validAt:now,recordedAt:now,contexts:[1]}).values()].map(s=>s.selected!.value)});
 }
 expect(snapshots[0]).toEqual(snapshots[1]);
 }finally{for(const owner of owners)await owner.close();}
},30000);
