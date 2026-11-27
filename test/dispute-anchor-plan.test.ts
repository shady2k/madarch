/**
 * Dispute reconciliation's anchor lookups stay inside the operation's touched slots under the
 * planner's own statistics (madarch-64o5.202).
 *
 * `reconcileDisputes` resolves the subject of every anchored assertion through two grouped lateral
 * probes — one for a vertex subject, one for an edge subject — so one lookup visits at most one tuple
 * of each relation it names per driver row. Written as plain joins, PostgreSQL reassociates the same
 * lookups into a hash join over every `assertion_edge_subject` (and, at larger batches, `assertion`)
 * row, and a run then visited 1 523 tuples against a bound of 180.
 *
 * The bound is the one `test/dispute-reconciliation-batch.test.ts` holds its measured host runs to:
 * `visited(plan) <= probes(plan) * expected`, where `expected` comes from what this case itself wrote
 * and never from the driver list the lookup under test assembles. This file reaches that bound with two
 * fixtures of a few hundred rows, so it stays well inside the single-file budget; the batch file keeps
 * its own cases and their bounds untouched.
 */
import {expect,test} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {generatedTableName,graphContractVersion,type EdgeDraft,type GraphContract,type VertexDraft} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {bindWriteCapability,bootstrapWriteIdentity,publishGraphDrafts,writeAssertion} from '../src/graph/write.js';
import * as uidModule from '../src/graph/uid.js';
import {loadAssertions,type StoredAssertion} from '../src/graph/assertion-read.js';
import type {SqlExecutor} from '../src/sql-driver.js';
const newUid=()=>uidModule.newUid();
const from='2020-01-01T00:00:00.000Z';
const contract:GraphContract=withAssertionContract({vertex:[{name:'sample',table:generatedTableName('sample','vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text'},{name:'amount',type:'integer'}]}],edge:[{name:'justifies',from:['sample'],to:['sample'],cardinality:{from:'many',to:'many'},labels:{en:{out:'justifies',in:'justified by'},ru:{out:'justifies',in:'justified by'}},fields:[{name:'weight',type:'integer'}],repeats:false,capability:'fixture'}],dictionary:[]});
const slotName=(index:number)=>`slot-${String(index).padStart(3,'0')}`;
interface Slot {readonly sort:'vertex'|'edge';readonly kind:string;readonly subjectId:number;readonly property:string;readonly language:null}
type Plan=Record<string,unknown>;

/**
 * The direct anchor lookup as it stood before madarch-64o5.202, subject resolution left as plain
 * joins. It is replayed only to show that the bound rejects the plan it produces; it is not a second
 * reader and nothing calls it.
 */
const unfencedLookup=`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,
CASE WHEN subject.id IS NOT NULL THEN graph_assertion_target(subject.id,a.assertion_id,$1::bigint,$2::timestamptz,$3::timestamptz) ELSE edge_subject.id END AS subject_id,a.property,a.language
FROM node header CROSS JOIN LATERAL (SELECT candidate.*,judged.assertion_id FROM edge candidate JOIN assertion judged ON judged.assertion_id=candidate.to_node WHERE candidate.to_node=header.id AND candidate.entity_id=(SELECT id FROM entity WHERE name='system.dispute-anchor') OFFSET 0) anchor
JOIN assertion a ON a.assertion_id=anchor.assertion_id
LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id
LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id
LEFT JOIN node subject ON subject.id=attachment.to_node
LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id
LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id
JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id)
WHERE header.uid=ANY($4::uuid[])`;

/** The relations whose tuples the lookups are allowed to visit once per driver row. */
const countedRelations=new Set(['edge','node','assertion','assertion_vertex_subject','assertion_edge_subject']);
function visited(plan:Plan):number{
 const own=countedRelations.has(String(plan['Relation Name']))?(Number(plan['Actual Rows']??0)+Number(plan['Rows Removed by Filter']??0)+Number(plan['Rows Removed by Index Recheck']??0))*Number(plan['Actual Loops']??0):0;
 return own+((plan['Plans']??[]) as Plan[]).reduce((sum,child)=>sum+visited(child),0);
}
function probes(plan:Plan):number{
 return (countedRelations.has(String(plan['Relation Name']))?1:0)+((plan['Plans']??[]) as Plan[]).reduce((sum,child)=>sum+probes(child),0);
}
function planNodes(plan:Plan,depth=0):string[]{
 const node=`${'  '.repeat(depth)}${String(plan['Node Type'])}${plan['Relation Name']===undefined?'':` ${String(plan['Relation Name'])}`} rows=${Number(plan['Actual Rows']??0)} loops=${Number(plan['Actual Loops']??1)}`;
 return [node,...((plan['Plans']??[]) as Plan[]).flatMap(child=>planNodes(child,depth+1))];
}

/**
 * Two sources state every slot, so every slot holds two assertions; the operation then states one
 * further value on each slot it touches. Questions are seeded for the whole catalogue, so the graph
 * around the lookup is larger than the affected slots — the CI case that first showed the scan.
 */
async function fixture(catalog:number,disputedEdges:number){
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const productUid=newUid(),principalUid=newUid(),a=newUid(),b=newUid();
 let operation=newUid();
 const bind=(tx:SqlExecutor,sourceUid:string)=>bindWriteCapability(tx,{productUid,principalUid,operationUid:operation,sourceUid,context:1,scope:productUid,contractVersion:graphContractVersion(contract),permissions:contract.vertex.concat(contract.edge as never[]).map(kind=>({kind:kind.name,properties:['*'],assert:true,retractOwn:true}))});
 await owner.transaction('write',async tx=>{
  for(const [kind,uid] of [['source',a],['source',b],['person',principalUid],['system.operation',operation]] as const)await bootstrapWriteIdentity(tx,kind,uid,productUid);
  for(const [source,value] of [[a,1],[b,2]] as const){
   bind(tx,source);
   await publishGraphDrafts(tx,contract,{
    vertices:Array.from({length:catalog},(_,index)=>({kind:'sample',key:{name:slotName(index)},values:{amount:value},validFrom:from,producer:'fixture',producerVersion:'1'})),
    edges:Array.from({length:disputedEdges},(_,index)=>({kind:'justifies',from:{kind:'sample',key:{name:slotName(index)}},to:{kind:'sample',key:{name:slotName(index+1)}},values:{weight:value},validFrom:from,producer:'fixture',producerVersion:'1'})),
    removals:[]});
  }
  bind(tx,a);
  const vertices:VertexDraft[]=[],edges:EdgeDraft[]=[];
  const question=(rows:readonly StoredAssertion[],property:string)=>{
   const uid=newUid(),vertex={kind:'system.dispute-question',uid,key:{}};
   vertices.push({...vertex,values:{property,language:null,segment_from:from,segment_to:null,state:'OPEN'},validFrom:from,producer:'fixture',producerVersion:'1'});
   for(const [index,row] of rows.entries()){
    if(index===0)edges.push({kind:'system.dispute-anchor',from:vertex,to:{kind:'system.assertion',uid:row.id,key:{}},discriminator:row.id,validFrom:from,producer:'fixture',producerVersion:'1'});
    edges.push({kind:'system.dispute-candidate',from:vertex,to:{kind:'system.assertion',uid:row.id,key:{}},discriminator:row.id,validFrom:from,producer:'fixture',producerVersion:'1'});
   }
  };
  const amounts=await loadAssertions(tx,'vertex','sample',['amount']);
  for(const id of new Set(amounts.map(row=>row.subjectId)))question(amounts.filter(row=>row.subjectId===id),'amount');
  const weights=await loadAssertions(tx,'edge','justifies',['weight']);
  for(const id of new Set(weights.map(row=>row.subjectId)))question(weights.filter(row=>row.subjectId===id),'weight');
  await publishGraphDrafts(tx,contract,{vertices,edges,removals:[]});
 });
 // A new operation keeps the fixture's own writes out of the affected slots.
 operation=newUid();await owner.transaction('write',tx=>bootstrapWriteIdentity(tx,'system.operation',operation,productUid));
 const slots=await owner.transaction('snapshot',async tx=>({
  vertices:(await tx.query<{id:string}>(`SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='sample' ORDER BY n.key->>'name' COLLATE "C"`)).rows.map(row=>({sort:'vertex' as const,kind:'sample',subjectId:Number(row.id),property:'amount',language:null})),
  edges:(await tx.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies' ORDER BY e.id`)).rows.map(row=>({sort:'edge' as const,kind:'justifies',subjectId:Number(row.id),property:'weight',language:null})),
 }));
 return {owner,bind,a,b,productUid,slots};
}

interface Measurement {readonly sql:string;readonly values?:readonly unknown[];readonly plan:Plan;readonly work:number;readonly probes:number;readonly drivers:number;readonly budget:number;readonly rows:readonly {sort:string;kind:string;subjectId:number;property:string}[]}

/**
 * Run one touched-slot operation through the production host, then replay the anchor lookup it issued
 * with `EXPLAIN (ANALYZE, FORMAT JSON)` at the statistics the operation itself ran against.
 */
async function measure(catalog:number,touched:number,touchEdge:boolean,seqscan:'on'|'off'){
 const f=await fixture(catalog,1);
 const {createPgBossQueue}=await import('../src/adapters/pg-boss-queue.js');
 const {prepareQueueSchema}=await import('../src/adapters/schemas/queue.js');
 const {createOperationHost,initializeOperationScope}=await import('../src/graph/operation-host.js');
 const {requireWriteCapability}=await import('../src/graph/write.js');
 const queue=await createPgBossQueue({owner:f.owner,supervise:false});
 try{
  const declaration={name:'anchor-plan-fixture',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
  await prepareQueueSchema(f.owner,{declarations:[declaration]});await queue.declare(declaration);
  await queue.enqueue({queue:declaration.name,data:{}});const [job]=await queue.claim({queue:declaration.name});
  const runUid=newUid(),unitUid=newUid();
  const binding=await f.owner.transaction('write',async tx=>{
   f.bind(tx,f.a);const binding=requireWriteCapability(tx);
   for(const [kind,uid] of [['person',binding.principalUid],['source',binding.sourceUid]] as const){const node=(await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[uid])).rows[0]!;await writeAssertion(tx,contract,{sort:'vertex',kind,subjectId:node.id,property:'$exists',operation:'assert',value:true});}
   await initializeOperationScope(tx,contract,binding,runUid,unitUid);return binding;
  });
  // Statistics where CI has them: after the fixture stands and before the operation runs.
  await f.owner.transaction('write',tx=>tx.query('ANALYZE'));
  const statements:{sql:string;values?:readonly unknown[]}[]=[];
  let recording=false;
  const observed:typeof f.owner={...f.owner,transaction:(kind,work,options)=>f.owner.transaction(kind,async tx=>{
   const query=tx.query.bind(tx);
   tx.query=async<Row extends object>(sql:string,values?:readonly unknown[]):Promise<{rows:Row[]}>=>{const result=await query<Row>(sql,values);if(recording)statements.push({sql,values});return result;};
   try{return await work(tx);}finally{tx.query=query;}
  },options)};
  const host=createOperationHost({owner:observed,queue,job:job!,contract,capability:binding,runUid,unitUid});
  const written:Slot[]=[...f.slots.vertices.slice(0,touched),...(touchEdge?[f.slots.edges[0]!]:[])];
  await host.execute({key:'touched-slots',request:{}},async tx=>{
   for(const slot of written)await writeAssertion(tx,contract,{sort:slot.sort,kind:slot.kind,subjectId:String(slot.subjectId),property:slot.property,operation:'assert',value:3,validFrom:from});
   recording=true;return {accepted:true};
  });
  recording=false;
  const lookups=statements.filter(statement=>statement.sql.startsWith('SELECT CASE WHEN vertex.assertion_id IS NOT NULL')&&statement.sql.includes("name='system.dispute-anchor'")&&!statement.sql.includes('FROM edge evidence'));
  expect(lookups.length).toBe(1);
  // Two statements per slot from the fixture and one from this operation, which stated its own value.
  const expected=written.length*3;
  const expectedRows=written.map(slot=>JSON.stringify({sort:slot.sort,kind:slot.kind,subjectId:slot.subjectId,property:slot.property})).sort();
  const rollback=new Error('rollback anchor plan');
  const measurements:Measurement[]=[];
  let widened:Measurement|undefined,unfenced:Measurement|undefined;
  const explain=async(tx:SqlExecutor,sql:string,values?:readonly unknown[]):Promise<Measurement>=>{
   const explained=await tx.query<{'QUERY PLAN':{Plan:Plan}[]}>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,values);
   const plan=explained.rows[0]!['QUERY PLAN'][0]!.Plan;
   const rows=(await tx.query<{sort:string;kind:string;subject_id:number|string;property:string}>(sql,values)).rows;
   return {sql,values,plan,work:visited(plan),probes:probes(plan),drivers:Array.isArray(values?.[3])?(values[3] as readonly unknown[]).length:0,budget:probes(plan)*expected,rows:rows.map(row=>({sort:row.sort,kind:row.kind,subjectId:Number(row.subject_id),property:row.property}))};
  };
  try{
   await f.owner.transaction('write',async tx=>{
    await tx.query(`SET LOCAL enable_seqscan=${seqscan}`);
    for(const lookup of lookups)measurements.push(await explain(tx,lookup.sql,lookup.values));
    const [lookup]=lookups;
    // The same lookup fed every assertion in the graph: a run that reconciled the catalogue rather than
    // its own slots.
    const everything=(await tx.query<{id:string}>(`SELECT n.uid::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.assertion'`)).rows.map(row=>row.id);
    widened=await explain(tx,lookup!.sql,[...lookup!.values!.slice(0,3),everything]);
    // The lookups as they stood before this change, over the same drivers.
    unfenced=await explain(tx,unfencedLookup,lookup!.values);
    throw rollback;
   });
  }catch(error){if(error!==rollback)throw error;}
  const [direct]=measurements;
  console.log('ANCHOR-PLAN',JSON.stringify({catalog,touched,touchEdge,seqscan,expected,drivers:direct!.drivers,work:direct!.work,probes:direct!.probes,budget:direct!.budget,widened:{drivers:widened!.drivers,work:widened!.work,budget:widened!.budget},unfenced:{work:unfenced!.work,probes:unfenced!.probes,budget:unfenced!.budget},nodes:planNodes(direct!.plan),unfencedNodes:planNodes(unfenced!.plan)}));
  return {owner:f.owner,expected,expectedRows,direct:direct!,widened:widened!,unfenced:unfenced!,written,measurements};
 }finally{await queue.stop();}
}

test('a touched-slot operation keeps its anchor lookup inside the reproduced plan',async()=>{
 const measured=await measure(10,10,false,'off');
 try{
  expect(measured.expectedRows).toHaveLength(10);
  expect(measured.direct.drivers).toBeLessThanOrEqual(measured.expected);
  expect(measured.direct.work).toBeLessThanOrEqual(measured.direct.budget);
  expect(measured.direct.rows.map(row=>JSON.stringify(row)).sort()).toEqual(measured.expectedRows);
  // Every assertion of every touched slot is a driver, and the anchor names one slot per assertion pair.
  expect(measured.direct.drivers).toBe(measured.expected);
 }finally{await measured.owner.close();}
},60000);

test('a fifty-slot operation keeps its anchor lookup inside the default planner settings, and the bound rejects a lookup that walks the graph',async()=>{
 const measured=await measure(200,50,true,'on');
 try{
  expect(measured.written.at(-1)).toMatchObject({sort:'edge',kind:'justifies',property:'weight'});
  expect(measured.direct.drivers).toBeLessThanOrEqual(measured.expected);
  expect(measured.direct.work).toBeLessThanOrEqual(measured.direct.budget);
  expect(measured.direct.rows.map(row=>JSON.stringify(row)).sort()).toEqual(measured.expectedRows);
  // The edge subject is resolved through its own branch, not dropped and not doubled.
  expect(measured.direct.rows.filter(row=>row.sort==='edge')).toHaveLength(1);
  expect(measured.direct.rows.filter(row=>row.sort==='vertex')).toHaveLength(50);
  // A whole-graph driver list is out of bounds on both counts.
  expect(measured.widened.drivers).toBeGreaterThan(measured.expected*10);
  expect(measured.widened.work).toBeGreaterThan(measured.widened.budget);
  // The lookups as they stood before this change return the same slots and leave the same bound.
  expect(measured.unfenced.rows.map(row=>JSON.stringify(row)).sort()).toEqual(measured.expectedRows);
  expect(measured.unfenced.work).toBeGreaterThan(measured.unfenced.budget);
  expect(measured.unfenced.probes).toBeGreaterThan(0);
 }finally{await measured.owner.close();}
},60000);
