import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {loadAssertions,loadAssertionsBatch} from '../src/graph/assertion-read.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
const graph:GraphContract={vertex:[{name:'typed',table:generatedTableName('typed','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'amount',type:'bigint'},{name:'when',type:'timestamp'},{name:'enabled',type:'boolean'},{name:'details',type:'json',schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}],capability:'fixture'}],edge:[],dictionary:[]};
test('assertion property batch preserves native typed values and subject filtering',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:['one','two'].map(name=>({kind:'typed',key:{name},values:{amount:name==='one'?'9223372036854775807':'9007199254740991',when:'2026-01-01T12:00:00.123Z',enabled:true,details:{count:3}},producer:'fixture',producerVersion:'1'})),removals:[]});});
  await owner.run(async tx=>{
   const identities=await tx.query<{id:number}>(`SELECT id FROM node WHERE key->>'name'='one'`);
   let reads=0;let statement='';let parameters:readonly unknown[]|undefined;
   const executor={query:((...args:Parameters<typeof tx.query>)=>{reads++;[statement,parameters]=args;return tx.query(...args);}) as typeof tx.query};
   const rows=await loadAssertions(executor,'vertex','typed',['amount','when','enabled','details'],[Number(identities.rows[0]!.id)]);
   expect(reads).toBe(1);expect(rows.map(row=>[row.property,row.value])).toEqual([['amount','9223372036854775807'],['when','2026-01-01T12:00:00.123Z'],['enabled',true],['details',{count:3}]]);
   const explained=await tx.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,parameters);
   const plan=explained.rows[0]!['QUERY PLAN'] as {Plan:PlanNode}[];
   interface PlanNode { 'Relation Name'?:string; 'Actual Loops':number; Plans?:PlanNode[] }
   const typedProbes=(node:PlanNode):number=>(node['Relation Name']?.startsWith('a_')?node['Actual Loops']:0)+(node.Plans??[]).reduce((sum,child)=>sum+typedProbes(child),0);
   // A header belongs to one property: other typed tables must not be probed for it.
   expect(typedProbes(plan[0]!.Plan)).toBe(rows.length);
   const lineageProbes=(node:PlanNode):number=>(node['Relation Name']==='edge'&&('Alias' in node)&&String(node.Alias).startsWith('lineage')?node['Actual Loops']:0)+(node.Plans??[]).reduce((sum,child)=>sum+lineageProbes(child),0);
   expect(lineageProbes(plan[0]!.Plan)).toBe(rows.length);
   expect(await loadAssertions(executor,'vertex','typed',['amount'],[])).toEqual([]);expect(reads).toBe(1);
   const all=await loadAssertions(executor,'vertex','typed',['amount']);
   expect(all.map(row=>row.value)).toEqual(['9223372036854775807',9007199254740991]);
   const beforeBatch=reads;
   const batches=await loadAssertionsBatch(executor,[
    {sort:'vertex',kind:'typed',properties:['amount'],subjectIds:[Number(identities.rows[0]!.id)]},
    {sort:'vertex',kind:'typed',properties:['enabled','amount']},
    {sort:'vertex',kind:'typed',properties:['details'],subjectIds:[]},
   ]);
   expect(reads-beforeBatch).toBe(1);
   expect(batches.map(batch=>batch.map(row=>[row.property,row.value]))).toEqual([
    [['amount','9223372036854775807']],
    [['enabled',true],['enabled',true],['amount','9223372036854775807'],['amount',9007199254740991]],
    [],
   ]);
  });
 }finally{await owner.close();}
},30000);
