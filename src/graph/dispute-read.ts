/** Recorded question state and lineage; no read-time judgement (0039 amendment). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { loadAssertions, type StoredAssertion, type AssertionRow, type AssertionSqlSelector } from './assertion-read.js';
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
async function records(tx:SqlExecutor,kind:string,selectors:Selectors):Promise<Map<string,Record<string,unknown>>>{
 return await withSpan('graph.dispute.records',{},async()=>{
 const properties=kind==='system.dispute-question'?['segment_from','segment_to','state']:['segment_from','segment_to','rationale'];
 const rows=await loadAssertions(tx,'vertex',kind,properties,undefined,selectors);const grouped=new Map<string,StoredAssertion[]>();
 for(const row of rows){const uid=subject(row);grouped.set(uid,[...(grouped.get(uid)??[]),row]);}
 const result=new Map<string,Record<string,unknown>>();
 for(const [uid,values] of grouped){const fields:Record<string,unknown>={};for(const property of properties){const selected=values.find(r=>r.property===property&&r.selected);if(selected)fields[property]=selected.value;}if(Object.keys(fields).length)result.set(uid,fields);}
 return result;
 });
}
/** Read persisted judgement at the requested bitemporal snapshot. */
export async function readDispute(tx:SqlExecutor,_contract:GraphContract,rows:readonly StoredAssertion[],selectors:Selectors):Promise<DisputeView|null>{
 const questions=await records(tx,'system.dispute-question',selectors);

 for(const [id,fields] of questions){
  const anchor=(await links(tx,id,'system.dispute-anchor',selectors))[0];if(!rows.some(row=>row.id===anchor))continue;
  if(fields['state']===undefined)continue;
  const history=await links(tx,id,'system.dispute-question-resolution',selectors);
  const superseded=new Set<string>();for(const uid of history)for(const older of await links(tx,uid,'system.dispute-supersedes',selectors))superseded.add(older);
  const resolution=fields['state']==='RESOLVED'?(history.find(uid=>!superseded.has(uid))??null):null;
  const assertion=resolution===null?null:(await links(tx,resolution,'system.resolution-assertion',selectors))[0]??null;
  return {id,state:fields['state']==='RESOLVED'?'RESOLVED':'OPEN',candidates:await links(tx,id,'system.dispute-candidate',selectors),resolution,supersededResolutions:history.filter(uid=>uid!==resolution),selectedAssertionUid:assertion};
 }
 return null;
}
export interface DisputeSlot {
 readonly sort:'vertex'|'edge'; readonly kind:string; readonly subjectId:number; readonly property:string; readonly language:string|null;
 readonly rows:readonly StoredAssertion[]; readonly dispute:DisputeView;
}
/** Batch bridge for readers: applicability is computed here once, including semantic pins and evidence. */
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
  for(const group of groups.values()){
   const all=await loadAssertions(tx,group.sort,group.kind,[...group.properties],[...group.subjects],selectors);
   for(const anchor of group.slots){
    const rows=all.filter(row=>row.subjectId===Number(anchor.subject_id)&&row.property===anchor.property&&row.language===anchor.language);const dispute=await readDispute(tx,contract,rows,selectors);
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
