/** Recorded question state and lineage; no read-time judgement (0039 amendment). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { loadAssertions, loadAssertionsBatch, type AssertionReadRequest, type StoredAssertion, type AssertionRow, type AssertionSqlSelector } from './assertion-read.js';
import { withSpan } from '../obs/trace.js';
type Selectors = AssertionSqlSelector;
export interface DisputeView {
  readonly id:string; readonly state:'OPEN'|'RESOLVED'; readonly candidates:readonly string[];
  readonly resolution:string|null; readonly supersededResolutions:readonly string[];
  readonly selectedAssertionUid:string|null;
}
function subject(row:AssertionRow):string{return row.subject.type==='vertex'?row.subject.uid:row.subject.id;}
async function links(tx:SqlExecutor,uid:string,kind:string,selectors?:Selectors):Promise<string[]>{
 return await withSpan('graph.dispute.links',{},async()=>{
 const found=(await tx.query<{uid:string;id:number}>(`SELECT target.uid::text AS uid,e.id FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE origin.uid=$1::uuid AND k.name=$2 ORDER BY target.uid::text COLLATE "C"`,[uid,kind])).rows;
 if(selectors===undefined)return found.map(row=>row.uid);
 const assertions=await loadAssertions(tx,'edge',kind,['$exists'],found.map(row=>Number(row.id)),selectors);
 return found.filter(row=>assertions.some(assertion=>assertion.subjectId===Number(row.id)&&assertion.selected&&assertion.value===true)).map(row=>row.uid);
 });
}
const questionProperties=['segment_from','segment_to','state'];
const lineageKinds=['system.dispute-anchor','system.dispute-question-resolution','system.dispute-supersedes','system.resolution-assertion','system.dispute-candidate'];
type Lineage = { origin:string; uid:string; id:number; kind:string };
/** One snapshot's recorded question fields and lineage, shared by every requested slot. */
async function disputeSnapshot(tx:SqlExecutor,selectors:Selectors,requests:readonly AssertionReadRequest[]=[]) {
 return await withSpan('graph.dispute.snapshot',{},async()=>{
 const lineage=(await tx.query<Lineage>(`SELECT origin.uid::text AS origin,target.uid::text AS uid,e.id,k.name AS kind FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name=ANY($1::text[]) ORDER BY target.uid::text COLLATE "C"`,[lineageKinds])).rows;
 const batches=await loadAssertionsBatch(tx,[...requests,{sort:'vertex',kind:'system.dispute-question',properties:questionProperties},...lineageKinds.map(kind=>({sort:'edge' as const,kind,properties:['$exists'],subjectIds:lineage.filter(link=>link.kind===kind).map(link=>Number(link.id))}))],selectors);
 const questions=new Map<string,Record<string,unknown>>();
 for(const row of batches[requests.length]!){const uid=subject(row),fields=questions.get(uid)??{};if(row.selected)fields[row.property]=row.value;questions.set(uid,fields);}
 const visible=new Set(batches.slice(requests.length+1).flat().filter(row=>row.selected&&row.value===true).map(row=>row.subjectId));
 const linked=new Map<string,string[]>();
 for(const link of lineage){if(!visible.has(Number(link.id)))continue;const key=JSON.stringify([link.origin,link.kind]);const values=linked.get(key)??[];values.push(link.uid);linked.set(key,values);}
 const links=(uid:string,kind:string)=>linked.get(JSON.stringify([uid,kind]))??[];
 const read=(rows:readonly StoredAssertion[]):DisputeView|null=>{
  for(const [id,fields] of questions){
   const anchor=links(id,'system.dispute-anchor')[0];if(!rows.some(row=>row.id===anchor)||fields['state']===undefined)continue;
   const history=links(id,'system.dispute-question-resolution');
   const superseded=new Set(history.flatMap(uid=>links(uid,'system.dispute-supersedes')));
   const resolution=fields['state']==='RESOLVED'?(history.find(uid=>!superseded.has(uid))??null):null;
   return {id,state:fields['state']==='RESOLVED'?'RESOLVED':'OPEN',candidates:links(id,'system.dispute-candidate'),resolution,supersededResolutions:history.filter(uid=>uid!==resolution),selectedAssertionUid:resolution===null?null:links(resolution,'system.resolution-assertion')[0]??null};
  }
  return null;
 };
 return {batches:batches.slice(0,requests.length),read};
 });
}
/** Read persisted judgement at the requested bitemporal snapshot. */
export async function readDispute(tx:SqlExecutor,_contract:GraphContract,rows:readonly StoredAssertion[],selectors:Selectors,snapshot?:Awaited<ReturnType<typeof disputeSnapshot>>):Promise<DisputeView|null>{
 return (snapshot??await disputeSnapshot(tx,selectors)).read(rows);
}
export interface DisputeSlot {
 readonly sort:'vertex'|'edge'; readonly kind:string; readonly subjectId:number; readonly property:string; readonly language:string|null;
 readonly rows:readonly StoredAssertion[]; readonly dispute:DisputeView;
}
/** Read the persisted question state and lineage once for every anchored slot. */
export async function listDisputeSlots(tx:SqlExecutor,declared:GraphContract,selectors:Selectors):Promise<readonly DisputeSlot[]> {
 return await withSpan('graph.dispute.slots',{},async()=>{
  const contract=withAssertionContract(declared);const result:DisputeSlot[]=[];
  const anchors=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`WITH anchors AS (
   SELECT DISTINCT a.assertion_id,a.property,a.language FROM edge e JOIN entity k ON k.id=e.entity_id AND k.name='system.dispute-anchor' JOIN assertion a ON a.assertion_id=e.to_node
  ) SELECT 'vertex'::text AS sort,k.name AS kind,n.id AS subject_id,a.property,a.language FROM anchors a JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id JOIN edge subject_edge ON subject_edge.id=attachment.subject_edge_id JOIN node n ON n.id=subject_edge.to_node JOIN entity k ON k.id=n.entity_id
  UNION SELECT 'edge'::text AS sort,k.name AS kind,e.id AS subject_id,a.property,a.language FROM anchors a JOIN assertion_edge_subject attachment ON attachment.assertion_id=a.assertion_id JOIN edge e ON e.id=attachment.edge_id JOIN entity k ON k.id=e.entity_id`)).rows;
  const groups=new Map<string,{sort:'vertex'|'edge';kind:string;properties:Set<string>;subjects:Set<number>;slots:typeof anchors}>();
  for(const anchor of anchors){
   const definition=contract[anchor.sort].find(kind=>kind.name===anchor.kind);
   if(!definition||!isDisputableProperty(anchor.sort,anchor.kind,anchor.property)||('key'in definition&&definition.key.includes(anchor.property)))continue;
   const key=JSON.stringify([anchor.sort,anchor.kind]);let group=groups.get(key);
   if(!group){group={sort:anchor.sort,kind:anchor.kind,properties:new Set(),subjects:new Set(),slots:[]};groups.set(key,group);}
   group.properties.add(anchor.property);group.subjects.add(Number(anchor.subject_id));group.slots.push(anchor);
  }
  if(groups.size===0)return result;
  const requested=[...groups.values()];
  const snapshot=await disputeSnapshot(tx,selectors,requested.map(group=>({sort:group.sort,kind:group.kind,properties:[...group.properties],subjectIds:[...group.subjects]})));
  for(const [index,group] of requested.entries()){
   const all=snapshot.batches[index]!;
   for(const anchor of group.slots){
    const rows=all.filter(row=>row.subjectId===Number(anchor.subject_id)&&row.property===anchor.property&&row.language===anchor.language);const dispute=await readDispute(tx,contract,rows,selectors,snapshot);
    if(dispute)result.push({sort:group.sort,kind:group.kind,subjectId:Number(anchor.subject_id),property:anchor.property,language:anchor.language,rows,dispute});
   }
  }
  return result;
 });
}

/** Load the ordinary assertion created by a resolution. */
export async function loadResolutionAssertion(tx:SqlExecutor,_contract:GraphContract,uid:string,rows:readonly StoredAssertion[],selectors:Selectors):Promise<StoredAssertion|null> {
 const assertionUid=(await links(tx,uid,'system.resolution-assertion',selectors))[0];
 return rows.find(row=>row.id===assertionUid)??null;
}
