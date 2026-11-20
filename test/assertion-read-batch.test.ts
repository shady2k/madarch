import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import {pinContext} from '../src/graph/context.js';
import {assertionSelectionSql,loadAssertions,loadAssertionsBatch} from '../src/graph/assertion-read.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
const graph:GraphContract={vertex:[{name:'typed',table:generatedTableName('typed','vertex'),key:['name'],fields:[{name:'name',type:'text'},{name:'amount',type:'bigint'},{name:'when',type:'timestamp'},{name:'enabled',type:'boolean'},{name:'details',type:'json',schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}],capability:'fixture'}],edge:[],dictionary:[]};
test('assertion SQL keeps its text when temporal, context, unit and resolution values change',async()=>{
 const { assertionReadSql }=await import('../src/graph/assertion-read.js');
 const request=[{sort:'vertex' as const,kind:'typed',properties:['amount'],subjectIds:[1]}];
 const first=await assertionReadSql(request,{contexts:[1],validAt:'2025-01-01T00:00:00Z',recordedAt:'2025-02-01T00:00:00Z',unitUids:['019a0000-0000-7000-8000-000000000011'],sourceUids:['first'],resolvedAssertionIds:['first'],contextRecordedThrough:{1:'10'}});
 const second=await assertionReadSql(request,{contexts:[2],validAt:'2026-01-01T00:00:00Z',recordedAt:'2026-02-01T00:00:00Z',unitUids:['019a0000-0000-7000-8000-000000000012'],sourceUids:['second'],resolvedAssertionIds:['second'],contextRecordedThrough:{2:'20'}});
 expect(first.sql).toBe(second.sql);
 expect(first.parameters).not.toEqual(second.parameters);
});

test('repeated assertion reads reuse a server prepared statement',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'prepared'},values:{amount:7},producer:'fixture',producerVersion:'1'}],removals:[]});
   const id=Number((await tx.query<{id:number}>("SELECT id FROM node WHERE key->>'name'='prepared'")).rows[0]!.id);
   for(let i=0;i<8;i++)expect((await loadAssertions(tx,'vertex','typed',['amount'],[id],{validAt:'2026-12-01T00:00:00Z',currentStatement:true})).filter(row=>row.selected).map(row=>row.value)).toEqual([7]);
   const prepared=await tx.query<{uses:string}>('SELECT (generic_plans+custom_plans)::text AS uses FROM pg_prepared_statements WHERE statement LIKE $1',["%raw AS MATERIALIZED%"]);
   expect(prepared.rows.some(row=>Number(row.uses)>=8)).toBe(true);
  });
 }finally{await owner.close();}
},30_000);

test('assertion property batch preserves native typed values and subject filtering',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try{
  await owner.transaction('write',async tx=>{await bindTestWriteCapability(tx,graph);await publishGraphDrafts(tx,graph,{vertices:['one','two'].map(name=>({kind:'typed',key:{name},values:{amount:name==='one'?'9223372036854775807':'9007199254740991',when:'2026-01-01T12:00:00.123Z',enabled:true,details:{count:3}},producer:'fixture',producerVersion:'1'})),removals:[]});});
  await owner.run(async tx=>{
   const identities=await tx.query<{id:number}>(`SELECT id FROM node WHERE key->>'name'='one'`);
   let reads=0;let statement='';let parameters:readonly unknown[]|undefined;
   const executor={query:((...args:Parameters<typeof tx.query>)=>{reads++;[statement,parameters]=args;return tx.query(...args);}) as typeof tx.query};
   const rows=await loadAssertions(executor,'vertex','typed',['amount','when','enabled','details'],[Number(identities.rows[0]!.id)]);
   expect(rows[0]!.evidenceAttachments).toEqual([]);
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
   const duplicate=await tx.query<{id:number}>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
    SELECT gen_random_uuid(),e.entity_id,e.from_node,e.to_node,'duplicate-lineage',e.context_id
    FROM edge e JOIN entity k ON k.id=e.entity_id
    WHERE k.name='system.assertion-source' AND e.from_node=(SELECT n.id FROM node n WHERE n.uid=$1::uuid)
    RETURNING id`,[rows[0]!.id]);
   expect(duplicate.rows).toHaveLength(1);
   await expect(loadAssertions(tx,'vertex','typed',['amount'],[Number(identities.rows[0]!.id)])).rejects.toThrow('more than one row');
  });
 }finally{await owner.close();}
},30000);


test('projected subject reads skip incoming lineage before probing assertion attachments',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'one'},values:{amount:1},producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  await owner.run(async tx=>{
   const id=Number((await tx.query<{id:number}>("SELECT id FROM node WHERE key->>'name'='one'")).rows[0]!.id);
   // Unrelated incoming edges must not turn a lookup into one attachment probe per edge.
   await tx.query(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
    SELECT gen_random_uuid(),(SELECT id FROM entity WHERE name='system.assertion-evidence'),n.id,$1,'noise-'||i,1
    FROM node n CROSS JOIN generate_series(1,100) i WHERE n.id=$1`,[id]);
   let sql='';let parameters:readonly unknown[]|undefined;
   const executor={query:((...args:Parameters<typeof tx.query>)=>{[sql,parameters]=args;return tx.query(...args);}) as typeof tx.query};
   const rows=await loadAssertions(executor,'vertex','typed',['amount'],[id],{projectMergedSubjects:true});
   expect(rows.filter(row=>row.selected).map(row=>row.value)).toEqual([1]);
   const explained=await tx.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,parameters);
   interface Plan {'Relation Name'?:string;'Actual Loops':number;Plans?:Plan[]}
   const probes=(p:Plan):number=>(p['Relation Name']==='assertion_vertex_subject'?p['Actual Loops']:0)+(p.Plans??[]).reduce((sum,c)=>sum+probes(c),0);
   const plan=explained.rows[0]!['QUERY PLAN'] as {Plan:Plan}[];
   expect(probes(plan[0]!.Plan)).toBeLessThanOrEqual(3);
  });
 }finally{await owner.close();}
},30000);

test('SQL item 25 selects backdated corrections by recorded sequence and pins branch bases',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  let id=0;let branch='';let before='';
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'one'},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
   id=Number((await tx.query<{id:number}>("SELECT id FROM node WHERE key->>'name'='one'")).rows[0]!.id);
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:2,validFrom:'2022-01-01T00:00:00Z'});
  });
  await owner.transaction('write',async tx=>{branch=await pinContext(tx,'1','fixture-branch');before=(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;});
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:3,validFrom:'2021-01-01T00:00:00Z'});
  });
  await owner.run(async tx=>{
   const selected=async(contexts:number[],recordedAt?:string)=>(await loadAssertions(tx,'vertex','typed',['amount'],[id],{validAt:'2023-01-01T00:00:00Z',contexts,...(recordedAt===undefined?{}:{recordedAt})})).filter(row=>row.selected).map(row=>row.value);
   expect(await selected([1])).toEqual([3]);
   expect(await selected([1],before)).toEqual([2]);
   expect(await selected([Number(branch)])).toEqual([2]);
  });
 } finally {await owner.close();}
});


test('unit replay filters source streams before newest selection and accepts several captured units',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 const units=['019a0000-0000-7000-8000-000000000011','019a0000-0000-7000-8000-000000000012','019a0000-0000-7000-8000-000000000013'];
 let id=0;
 try {
  await owner.transaction('write',async tx=>{
   const binding=await bindTestWriteCapability(tx,graph);
   for(const unit of units)await bootstrapWriteIdentity(tx,'system.unit',unit,binding.productUid);
   bindWriteCapability(tx,{...binding,unitUid:units[0]!});
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'captured'},values:{amount:10},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
   id=Number((await tx.query<{id:number}>("SELECT id FROM node WHERE key->>'name'='captured'")).rows[0]!.id);
   for(const [index,amount] of [[1,20],[2,30]] as const){
    bindWriteCapability(tx,{...binding,unitUid:units[index]!});
    await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:amount,validFrom:'2020-01-01T00:00:00Z'});
   }
  });
  await owner.run(async tx=>{
   const values=async(unitUids:readonly string[])=>(await loadAssertions(tx,'vertex','typed',['amount'],[id],{unitUids})).filter(row=>row.selected).map(row=>row.value);
   expect(await values([units[0]!])).toEqual([10]);
   expect(await values(units.slice(0,2))).toEqual([20]);
   expect(await values([units[1]!,units[0]!])).toEqual([20]);
   expect(await values([])).toEqual([]);
  });
 } finally {await owner.close();}
});

test('explicit recorded fences independently constrain base and branch selection',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  let id=0;let branch=0;let baseCutoff='';let branchCutoff='';
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:[{kind:'typed',key:{name:'fenced'},values:{amount:1},validFrom:'2020-01-01T00:00:00Z',producer:'fixture',producerVersion:'1'}],removals:[]});
   const rows=await loadAssertions(tx,'vertex','typed',['amount']);
   id=rows[0]!.subjectId;baseCutoff=rows[0]!.recordedSequence.toString();
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:2,validFrom:'2020-01-01T00:00:00Z'});
  });
  await owner.transaction('write',async tx=>{branch=Number(await pinContext(tx,'1','explicit-fences'));});
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph,undefined,branch);
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:3,validFrom:'2020-01-01T00:00:00Z'},branch);
   const rows=await loadAssertions(tx,'vertex','typed',['amount'],[id],{contexts:[branch]});
   branchCutoff=rows.find(row=>row.context===branch)!.recordedSequence.toString();
   await writeAssertion(tx,graph,{sort:'vertex',kind:'typed',subjectId:String(id),property:'amount',operation:'assert',value:4,validFrom:'2020-01-01T00:00:00Z'},branch);
  });
  await owner.run(async tx=>{
   const selected=async(contextRecordedThrough:Record<number,string|null>)=>(await loadAssertions(tx,'vertex','typed',['amount'],[id],{contexts:[branch],validAt:'2023-01-01T00:00:00Z',contextRecordedThrough})).filter(row=>row.selected).map(row=>row.value);
   expect(await selected({})).toEqual([4]);
   expect(await selected({1:baseCutoff,[branch]:branchCutoff})).toEqual([3]);
   expect(await selected({1:baseCutoff,[branch]:'0'})).toEqual([1]);
   expect(await selected({1:null,[branch]:'0'})).toEqual([2]);
  });
 } finally {await owner.close();}
});

test('reused assertions expose evidence targets once and retain distinct locators', async () => {
 const contract: GraphContract = { ...graph, vertex: [...graph.vertex, { name: 'support', table: generatedTableName('support', 'vertex'), capability: 'fixture', key: ['name'], fields: [{ name: 'name', type: 'text' }], evidence: { immutable: true } }] };
 const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
 try {
  await owner.transaction('write', async tx => {
   await bindTestWriteCapability(tx, contract);
   await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'support', key: { name: 'document' }, producer: 'fixture', producerVersion: '1' }], removals: [] });
   for (const line of [1, 2]) {
    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'typed', key: { name: 'grounded' }, values: { amount: 1 }, evidence: [{ target: { kind: 'support', key: { name: 'document' } }, locator: { lineStart: line, lineEnd: line } }], producer: 'fixture', producerVersion: '1' }], removals: [] });
   }
  });
  const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'typed', ['amount']));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.evidence).toHaveLength(1);
  expect(rows[0]!.evidenceAttachments).toHaveLength(2);
  expect(rows[0]!.evidenceAttachments.map(attachment => JSON.parse(attachment.locator).locator.lineStart).sort()).toEqual([1, 2]);
 } finally { await owner.close(); }
}, 30_000);

test('current statement assertion selection includes values newer than the transaction', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: graph, authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      await tx.query('SELECT pg_sleep(0.01)');
      const raw = `SELECT 0 AS request_index,1 AS subject_id,'value' AS property,NULL::text AS language,
        'source' AS source,'assertion' AS id,1 AS context_id,'assert' AS operation,
        statement_timestamp() AS valid_from,NULL::timestamptz AS valid_to,
        statement_timestamp() AS recorded_at,1::bigint AS recorded_sequence`;
      const ordinary = await tx.query<{ selected: boolean }>(assertionSelectionSql(raw));
      expect(ordinary.rows[0]!.selected).toBe(false);
      const current = await tx.query<{ selected: boolean }>(assertionSelectionSql(raw, { currentStatement: true }));
      expect(current.rows[0]!.selected).toBe(true);
      const pinned = await tx.query<{ selected: boolean }>(assertionSelectionSql(raw, { currentStatement: true, validAt: '2000-01-01T00:00:00Z', recordedAt: '2000-01-01T00:00:00Z' }));
      expect(pinned.rows[0]!.selected).toBe(false);
    });
  } finally { await owner.close(); }
}, 30_000);

test('supplied subjects use the subject indexes without merges', async () => {
 const owner=await createTestDatabaseOwner({graphContract:graph,authenticated:false});
 try {
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,graph);
   await publishGraphDrafts(tx,graph,{vertices:Array.from({length:300},(_,i)=>({kind:'typed',key:{name:`subject-${i}`},values:{amount:i},producer:'fixture',producerVersion:'1'})),removals:[]});
  });
  await owner.run(async tx=>{
   await tx.query('ANALYZE');
   const id=Number((await tx.query<{id:string}>("SELECT id::text FROM node WHERE key->>'name'='subject-0'")).rows[0]!.id);
   let statement='';let parameters:readonly unknown[]|undefined;
   const executor={query:async <Row extends object>(sql:string,values?:readonly unknown[])=>{statement=sql;parameters=values;return tx.query<Row>(sql,values);}};
   const rows=await loadAssertions(executor,'vertex','typed',['amount'],[id],{projectMergedSubjects:true});
   expect(rows.map(row=>row.value)).toEqual([0]);
   const explained=await tx.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,parameters);
   interface PlanNode { 'Index Name'?:string; 'Actual Loops':number; 'Actual Rows':number; 'Relation Name'?:string; Alias?:string; Plans?:PlanNode[] }
   const plan=explained.rows[0]!['QUERY PLAN'] as {Plan:PlanNode}[];
   const nodes:PlanNode[]=[];
   const visit=(node:PlanNode):void=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};
   visit(plan[0]!.Plan);
   if(process.env['MADARCH_READER_EXPLAIN']==='1')console.log('SUBJECT_PLAN',JSON.stringify(explained.rows));
   expect(nodes.some(node=>node['Index Name']==='node_pkey'&&node.Alias?.startsWith('subject')&&node['Actual Loops']>0)).toBe(true);
   expect(nodes.some(node=>node['Index Name']==='edge_to'&&node['Actual Loops']>0)).toBe(true);
   expect(nodes.filter(node=>node['Relation Name']==='assertion').reduce((sum,node)=>sum+node['Actual Rows']*node['Actual Loops'],0)).toBeLessThan(10);
  });
 } finally {await owner.close();}
},30000);
