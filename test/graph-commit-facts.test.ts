import {expect,test} from 'bun:test';
import {commitFacts} from '../src/graph/records.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {createRecordOwner,recordGraph,commitRef,fixtureProducer} from './assertion-record-fixture.js';
import {GIT_KINDS} from '../src/fill/stages/git-contract.js';
test('0039.1: commit facts traverse parent and author edges and retain the original git clock',async()=>{
 const owner=await createRecordOwner();try{
 const author={kind:GIT_KINDS.signature,key:{name:'Ada',email:'ada@example.test'}};
 await owner.transaction('write',tx=>publishGraphDrafts(tx,recordGraph,{vertices:[{...commitRef('abc'),values:{author_date:'2026-01-02T03:04:05Z',author_offset_min:180,commit_date:'2026-01-03T04:05:06Z',commit_offset_min:-120,subject:'Change'},...fixtureProducer},{...commitRef('parent'),...fixtureProducer},{...author,...fixtureProducer}],edges:[{kind:GIT_KINDS.parent,from:commitRef('abc'),to:commitRef('parent'),values:{position:0},...fixtureProducer},{kind:GIT_KINDS.authored,from:author,to:commitRef('abc'),...fixtureProducer}],removals:[]}));
 expect(await commitFacts(owner,'shop','abc')).toEqual({hash:'abc',parents:['parent'],author:{name:'Ada',email:'ada@example.test'},authorDate:'2026-01-02T06:04:05+03:00',commitDate:'2026-01-03T02:05:06-02:00',authorOffsetMin:180,commitOffsetMin:-120,subject:'Change'});
 expect(await commitFacts(owner,'shop','missing')).toBeNull();
 }finally{await owner.close();}
});


test('0039.30: a parent edge projection refuses text where its position role requires a number',async()=>{
 const owner=await createRecordOwner({parentPositionFieldType:'text'});
 const graph={...recordGraph,edge:recordGraph.edge.map(edge=>edge.name===GIT_KINDS.parent?{...edge,fields:edge.fields.map(field=>field.name==='position'?{...field,type:'text' as const}:field)}:edge)};
 try{
   await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{...commitRef('abc'),...fixtureProducer},{...commitRef('parent'),...fixtureProducer}],edges:[{kind:GIT_KINDS.parent,from:commitRef('abc'),to:commitRef('parent'),values:{position:'first'},...fixtureProducer}],removals:[]}));
   await expect(commitFacts(owner,'shop','abc')).rejects.toThrow('/fixture/catalog.yaml:1: semantic role "commit.parent" projection');
 }finally{await owner.close();}
});
