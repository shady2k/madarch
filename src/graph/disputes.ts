/** Writer-side dispute judgement and ordinary resolution assertions (0039 items 16,17,27). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, EvidenceDraft } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { loadResolutionAssertion, type DisputeView } from './dispute-read.js';
import { loadAssertions, loadAssertionsBatch, type StoredAssertion } from './assertion-read.js';
import { selectAssertions, candidateFingerprint, resolutionMatches, applySemanticResolution, type AssertionRow } from './assertion-selection.js';
import { bindWriteCapability, bootstrapWriteIdentity, writeAssertion, requireWriteCapability, requireAssertionScope, publishGraphDrafts } from './write.js';
import { requireProducerAction, requirePublicationBinding, requireProducerBinding, type ProducerBinding } from './producer-binding.js';
import { keyUid, newUid } from './uid.js';
import { startupBinding } from './manifest-publication.js';
import { byCodePoint } from '../model/order.js';
import { contextLayers } from './context.js';
import { acquireGraphWriteLock } from './write.js';
import { readPublishedManifest } from './manifest-publication.js';
import { evidenceSupportRoles } from './evidence-support.js';
import { readEvidenceStates } from './evidence-read.js';
import { withSpan } from '../obs/trace.js';

async function mergedAssertions(tx:SqlExecutor,sort:'vertex'|'edge',kind:string,properties:readonly string[],ids:readonly number[]|undefined,selectors:Selectors):Promise<StoredAssertion[]> {
 return await withSpan('graph.dispute.merged-assertions',{},async()=>{
 const merged=(await tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') AS present`)).rows[0]!.present;
 const targets=ids===undefined?undefined:merged&&sort==='vertex'?(await tx.query<{id:number}>(`SELECT DISTINCT graph_merge_target(id,$2::bigint,$3::timestamptz,$4::timestamptz) AS id FROM unnest($1::bigint[]) subject(id)`,[ids,selectors.contexts[0],selectors.validAt,selectors.recordedAt])).rows.map(row=>Number(row.id)):ids;
 return await loadAssertions(tx,sort,kind,properties,targets,{...selectors,projectMergedSubjects:merged&&sort==='vertex'});
 });
}
type Selectors = Parameters<typeof selectAssertions>[1];
interface Segment {from:string;to:string|null}
const kinds=['system.dispute-question','system.dispute-resolution','system.problem'];
const edgeKinds=['system.dispute-anchor','system.dispute-candidate','system.dispute-question-resolution','system.resolution-judged','system.dispute-chosen','system.dispute-supersedes','system.resolution-assertion','system.dispute-resolution-question','system.problem-about'];
function subject(row:AssertionRow):string{return row.subject.type==='vertex'?row.subject.uid:row.subject.id;}
async function links(tx:SqlExecutor,uid:string,kind:string,selectors?:Selectors):Promise<string[]>{
 return await withSpan('graph.dispute.links',{},async()=>{
 const found=(await tx.query<{uid:string;id:number}>(`SELECT target.uid::text AS uid,e.id FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE origin.uid=$1::uuid AND k.name=$2 ORDER BY target.uid::text COLLATE "C"`,[uid,kind])).rows;
 if(selectors===undefined)return found.map(row=>row.uid);
 const assertions=await loadAssertions(tx,'edge',kind,['$exists'],found.map(row=>Number(row.id)));
 return found.filter(row=>selectAssertions(assertions.filter(assertion=>assertion.subjectId===Number(row.id)),selectors).selected?.value===true).map(row=>row.uid);
 });
}
async function records(tx:SqlExecutor,kind:string,selectors:Selectors):Promise<Map<string,Record<string,unknown>>>{
 return await withSpan('graph.dispute.records',{},async()=>{
 const properties=kind==='system.dispute-question'?['segment_from','segment_to','state']:['segment_from','segment_to','rationale'];
 const rows=await loadAssertions(tx,'vertex',kind,properties);const grouped=new Map<string,StoredAssertion[]>();
 for(const row of rows){const uid=subject(row);grouped.set(uid,[...(grouped.get(uid)??[]),row]);}
 const result=new Map<string,Record<string,unknown>>();
 for(const [uid,values] of grouped){const fields:Record<string,unknown>={};for(const property of properties){const selected=selectAssertions(values.filter(r=>r.property===property),selectors).selected;if(selected)fields[property]=selected.value instanceof Date?selected.value.toISOString():selected.value;}if(Object.keys(fields).length)result.set(uid,fields);}
 return result;
 });
}
interface ReconciliationSnapshot {
 at:string;
 fields:Map<string,Map<string,StoredAssertion[]>>;
 linked:Map<string,{origin:string;uid:string;id:number;kind:string}[]>;
 existence:Map<number,StoredAssertion[]>;
 decisionIds:Set<string>;
 records(kind:string,selectors:Selectors):Map<string,Record<string,unknown>>;
 links(uid:string,kind:string,selectors:Selectors):string[];
 producerRows(rows:readonly StoredAssertion[]):StoredAssertion[];
}
async function reconciliationSnapshot(tx:SqlExecutor,rows:readonly StoredAssertion[],questionUid?:string,previous?:ReconciliationSnapshot):Promise<ReconciliationSnapshot>{
 return await withSpan('graph.dispute.reconciliation-snapshot',{},async()=>{
 const linkKinds=['system.dispute-anchor','system.dispute-candidate','system.dispute-question-resolution','system.resolution-judged','system.dispute-chosen','system.resolution-assertion'];
 const at=(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
 const scope=(await tx.query<{id:number;uid:string;kind:string}>(`WITH questions AS (
 SELECT DISTINCT q.id,q.uid FROM node q JOIN edge e ON e.from_node=q.id JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node
 WHERE ($2::uuid IS NULL AND k.name IN ('system.dispute-anchor','system.dispute-candidate') AND target.uid=ANY($1::uuid[])) OR q.uid=$2::uuid
 ), resolutions AS (
 SELECT DISTINCT r.id,r.uid FROM questions q JOIN edge e ON e.from_node=q.id JOIN entity k ON k.id=e.entity_id AND k.name='system.dispute-question-resolution' JOIN node r ON r.id=e.to_node
 ) SELECT id,uid::text,'system.dispute-question'::text AS kind FROM questions UNION ALL SELECT id,uid::text,'resolution'::text AS kind FROM resolutions`,[rows.map(row=>row.id),questionUid??null])).rows;
 const lineage=(await tx.query<{origin:string;uid:string;id:number;kind:string}>(`SELECT origin.uid::text AS origin,target.uid::text AS uid,e.id,k.name AS kind FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name=ANY($1::text[]) AND origin.id=ANY($2::bigint[]) AND (k.name<>'system.resolution-assertion' OR target.uid=ANY($3::uuid[])) ORDER BY target.uid::text COLLATE "C"`,[linkKinds,scope.map(node=>Number(node.id)),rows.map(row=>row.id)])).rows;
 const batches=await loadAssertionsBatch(tx,[
  {sort:'vertex',kind:'system.dispute-question',properties:['segment_from','segment_to','state'],subjectIds:scope.filter(node=>node.kind==='system.dispute-question').map(node=>Number(node.id))},
  {sort:'vertex',kind:'system.dispute-resolution',properties:['segment_from','segment_to','rationale'],subjectIds:scope.filter(node=>node.kind==='resolution').map(node=>Number(node.id))},
  ...linkKinds.map(kind=>({sort:'edge' as const,kind,properties:['$exists'],subjectIds:lineage.filter(link=>link.kind===kind).map(link=>Number(link.id))})),
 ]);
 const fields=previous?.fields??new Map<string,Map<string,StoredAssertion[]>>();
 for(const [index,kind] of ['system.dispute-question','system.dispute-resolution'].entries()){
  const grouped=new Map<string,StoredAssertion[]>();
  for(const row of batches[index]!){const uid=subject(row);const values=grouped.get(uid)??[];values.push(row);grouped.set(uid,values);}
  const retained=fields.get(kind)??new Map<string,StoredAssertion[]>();
  for(const [uid,values] of grouped)retained.set(uid,values);
  fields.set(kind,retained);
 }
 const linked=previous?.linked??new Map<string,typeof lineage>();
 for(const node of scope)for(const kind of linkKinds)linked.delete(JSON.stringify([node.uid,kind]));
 for(const link of lineage){const key=JSON.stringify([link.origin,link.kind]);const values=linked.get(key)??[];values.push(link);linked.set(key,values);}
 const existence=previous?.existence??new Map<number,StoredAssertion[]>();
 for(const link of lineage)existence.delete(Number(link.id));
 for(const row of batches.slice(2).flat()){const values=existence.get(row.subjectId)??[];values.push(row);existence.set(row.subjectId,values);}
 const decisionIds=previous?.decisionIds??new Set<string>();
 for(const uid of new Set(lineage.filter(link=>link.kind==='system.resolution-assertion').map(link=>link.uid)))decisionIds.add(uid);
 return {at,fields,linked,existence,decisionIds,
  records(kind,selectors){
   const result=new Map<string,Record<string,unknown>>();
   for(const [uid,rows] of fields.get(kind)??[]){
    const values:Record<string,unknown>={};
    for(const property of kind==='system.dispute-question'?['segment_from','segment_to','state']:['segment_from','segment_to','rationale']){
     const selected=selectAssertions(rows.filter(row=>row.property===property),selectors).selected;
     if(selected)values[property]=selected.value instanceof Date?selected.value.toISOString():selected.value;
    }
    if(Object.keys(values).length)result.set(uid,values);
   }
   return result;
  },
  links(uid,kind,selectors){return (linked.get(JSON.stringify([uid,kind]))??[]).filter(link=>selectAssertions(existence.get(Number(link.id))??[],selectors).selected?.value===true).map(link=>link.uid);},
  producerRows(rows){const sources=new Set(rows.filter(row=>decisionIds.has(row.id)).map(row=>row.source));return rows.filter(row=>!sources.has(row.source));},
 };
 });
}
async function internal<T>(tx:SqlExecutor,contract:GraphContract,work:()=>Promise<T>,preserveSource=false):Promise<T>{
 return await withSpan('graph.dispute.internal',{},async()=>{
 const previous=requireWriteCapability(tx);
 try{
  const installed=await startupBinding(tx,contract,'system.disputes');
  bindWriteCapability(tx,{...installed.binding,...(preserveSource?{sourceUid:previous.sourceUid}:{}),context:previous.context,principalUid:previous.principalUid,operationUid:previous.operationUid,...(previous.unitUid===undefined?{}:{unitUid:previous.unitUid}),permissions:[...kinds,...edgeKinds].map(kind=>({kind,properties:['*'],assert:true,retractOwn:true}))});
  return await work();
 }finally{bindWriteCapability(tx,previous);}
 });
}
async function save(tx:SqlExecutor,contract:GraphContract,kind:string,uid:string,values:Record<string,unknown>,edges:readonly {kind:string;target:string;targetKind:string}[],evidence?:readonly EvidenceDraft[],validScope?:Segment):Promise<void>{
 return await withSpan('graph.dispute.save',{},async()=>{
 const binding=requireWriteCapability(tx);const from={kind,uid,key:{}};
 await publishGraphDrafts(tx,contract,{vertices:[{...from,values:validScope?{}:values,evidence,validFrom:'0001-01-01T00:00:00.000Z',producer:binding.sourceUid,producerVersion:'1'}],removals:[],edges:edges.map(e=>({kind:e.kind,from,to:{kind:e.targetKind,uid:e.target,key:{}},discriminator:e.target,validFrom:'0001-01-01T00:00:00.000Z',producer:binding.sourceUid,producerVersion:'1'}))},binding.context);
 if(validScope){
  const node=(await tx.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`,[uid])).rows[0]!;
  for(const [property,value] of Object.entries(values))await writeAssertion(tx,contract,{sort:'vertex',kind,subjectId:node.id,property,operation:'assert',value,validFrom:validScope.from,validTo:validScope.to,evidence},binding.context);
 }
 });
}
async function recordQuestionState(tx:SqlExecutor,contract:GraphContract,questionUid:string,state:DisputeView['state'],newEdges:readonly {kind:string;target:string;targetKind:string}[],segment:Segment):Promise<void>{
 return await withSpan('graph.dispute.record-question-state',{},async()=>{
 const binding=requireWriteCapability(tx);
 if(newEdges.length)await publishGraphDrafts(tx,contract,{vertices:[],edges:newEdges.map(edge=>({kind:edge.kind,from:{kind:'system.dispute-question',uid:questionUid,key:{}},to:{kind:edge.targetKind,uid:edge.target,key:{}},discriminator:edge.target,validFrom:'0001-01-01T00:00:00.000Z',producer:binding.sourceUid,producerVersion:'1'})),removals:[]},binding.context);
 const node=(await tx.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`,[questionUid])).rows[0]!;
 await writeAssertion(tx,contract,{sort:'vertex',kind:'system.dispute-question',subjectId:node.id,property:'state',operation:'assert',value:state,validFrom:segment.from,validTo:segment.to},binding.context);
 });
}
function segmentAt(rows:readonly AssertionRow[],at:string):Segment{
 const point=Date.parse(at);const bounds=rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])]).map(Date.parse).sort((a,b)=>a-b);
 return {from:new Date(Math.max(...bounds.filter(b=>b<=point),-62135596800000)).toISOString(),to:bounds.find(b=>b>point)===undefined?null:new Date(bounds.find(b=>b>point)!).toISOString()};
}
async function producerRows(tx:SqlExecutor,rows:readonly StoredAssertion[]):Promise<StoredAssertion[]> {
 return await withSpan('graph.dispute.producer-rows',{},async()=>{
 const decisionIds=(await tx.query<{uid:string}>(`SELECT n.uid::text AS uid FROM edge e JOIN entity k ON k.id=e.entity_id AND k.name='system.resolution-assertion' JOIN node n ON n.id=e.to_node`)).rows.map(row=>row.uid);
 const sources=new Set(rows.filter(row=>decisionIds.includes(row.id)).map(row=>row.source));
 return rows.filter(row=>!sources.has(row.source));
 });
}
async function resolutionSource(tx:SqlExecutor,contract:GraphContract,principal:string,product:string):Promise<string>{
 return await withSpan('graph.dispute.resolution-source',{},async()=>{
 const uid=keyUid('system.resolution-source',[principal]);const previous=requireWriteCapability(tx);
 await bootstrapWriteIdentity(tx,'source',uid,product,previous.context);
 try{
  bindWriteCapability(tx,{...previous,sourceUid:uid,permissions:[{kind:'source',properties:['$exists'],assert:true,retractOwn:false}]});
  const source=(await tx.query<{id:string}>('SELECT id::text AS id FROM node WHERE uid=$1::uuid',[uid])).rows[0]!;
  await writeAssertion(tx,contract,{sort:'vertex',kind:'source',subjectId:source.id,property:'$exists',operation:'assert',value:true,validFrom:'0001-01-01T00:00:00.000Z'},previous.context);
 }finally{bindWriteCapability(tx,previous);}
 return uid;
 });
}
/** Materialize a persisted question at the same temporal/context snapshot as its slot. */
async function judgeDispute(tx:SqlExecutor,contract:GraphContract,rows:readonly StoredAssertion[],selectors:Selectors,snapshot:ReconciliationSnapshot):Promise<DisputeView|null>{
 return await withSpan('graph.dispute.read',{},async()=>{
 rows=snapshot.producerRows(rows);
 if(!rows.length)return null;
 const selected=selectAssertions(rows,selectors);const questions=snapshot.records('system.dispute-question',selectors);
 const resolutions=snapshot.records('system.dispute-resolution',selectors);
 for(const [id,fields] of questions){
  const anchor=snapshot.links(id,'system.dispute-anchor',selectors)[0];const anchorRow=rows.find(row=>row.id===anchor);if(!anchorRow)continue;
  const segment=segmentAt(selected.candidates.length?selected.candidates:rows,selectors.validAt);
  if(fields['segment_from']===undefined)continue;
  if(Date.parse(String(fields['segment_from']))>=Date.parse(segment.to??'9999-01-01T00:00:00Z')||(fields['segment_to']!==null&&Date.parse(String(fields['segment_to']))<=Date.parse(segment.from)))continue;
  const history=snapshot.links(id,'system.dispute-question-resolution',selectors).filter(uid=>resolutions.has(uid));
  let matching:string|null=null;let chosen:string|null=null;
  for(const resolution of history){
   const pin=rows.filter(row=>snapshot.links(resolution,'system.resolution-judged',selectors).includes(row.id));const current=selected.candidates;
   const metadata=resolutions.get(resolution)!;const scope={from:String(metadata['segment_from']),to:metadata['segment_to']===null?null:String(metadata['segment_to'])};
   const evidenceAt=snapshot.at;
   const evidenceValid=await resolutionEvidenceValid(tx,contract,resolution,{...selectors,validAt:evidenceAt},snapshot);
   if(pin.length&&resolutionMatches(pin.map(row=>candidateFingerprint(row,scope)),current.map(row=>candidateFingerprint(row,segment)),evidenceValid)){
    const chosenId=snapshot.links(resolution,'system.dispute-chosen',selectors)[0];const original=rows.find(row=>row.id===chosenId);
    const repeated=original?applySemanticResolution(selected,{pins:pin.map(row=>candidateFingerprint(row,scope)),segment,chosenSource:original.source,chosenValue:original.value,evidenceValid}).selected:null;
    if(repeated){matching=resolution;chosen=repeated.id;}
   }
  }
  return {id,state:matching!==null?'RESOLVED':selected.contested?'OPEN':'DISMISSED',candidates:selected.candidates.map(row=>row.id),resolution:matching,supersededResolutions:history.filter(uid=>uid!==matching),selectedAssertionUid:chosen};
 }
 return null;
 });
}
async function resolutionEvidenceValid(tx:SqlExecutor,contract:GraphContract,uid:string,selectors:Selectors,snapshot:ReconciliationSnapshot):Promise<boolean>{
 return await withSpan('graph.dispute.evidence',{},async()=>{
 const values=snapshot.fields.get('system.dispute-resolution')?.get(uid);
 if(values===undefined)throw new Error(`${import.meta.path}:194: reconciliation snapshot missing resolution ${uid}`);
 const assertion=selectAssertions(values,selectors).selected as StoredAssertion|null;
 if(assertion===null||assertion.evidence.length===0)return false;
 const manifest=await readPublishedManifest(tx);const support=evidenceSupportRoles(manifest?.semanticBindings);
 const attachments=(await tx.query<{target:string;locator:Record<string,unknown>}>(`SELECT target.uid::text AS target,e.discriminator::jsonb->'locator' AS locator FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE origin.uid=$1::uuid AND k.name='system.assertion-evidence'`,[assertion.id])).rows;
 const states=await readEvidenceStates(tx,contract,attachments.map(attachment=>({targetUid:attachment.target,locator:attachment.locator,assertion})),selectors,support);
 for(const [index,attachment] of attachments.entries()){
  const node=(await tx.query<{kind:string;id:number}>(`SELECT k.name AS kind,n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[attachment.target])).rows[0];if(!node)return false;
  const active=selectAssertions(await loadAssertions(tx,'vertex',node.kind,['$exists'],[Number(node.id)]),selectors);
  if(active.contested||active.selected?.value!==true)return false;
  const state=states[index]!;
  let stale=state.currentApplicability==='stale';
  if(support){
   const here=support.direction==='from'?'from_node':'to_node';
   const supportEdges=(await tx.query<{id:number}>(`SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.${here}=$1::bigint AND k.name=$2`,[node.id,support.edgeKind])).rows;
   const supportAssertions=await loadAssertions(tx,'edge',support.edgeKind,['$exists'],supportEdges.map(edge=>Number(edge.id)));
   for(const edge of supportEdges){
    const stream=supportAssertions.filter(row=>row.subjectId===Number(edge.id)&&selectors.contexts.includes(row.context)&&Date.parse(row.validFrom)<=Date.parse(selectors.validAt)&&(row.validTo===null||Date.parse(row.validTo)>Date.parse(selectors.validAt))&&Date.parse(row.recordedAt)<=Date.parse(selectors.recordedAt)).sort((a,b)=>a.recordedSequence>b.recordedSequence?-1:1);
    if(stream[0]?.operation==='retract')return false;
    if(selectAssertions(supportAssertions.filter(row=>row.subjectId===Number(edge.id)),selectors).selected?.value===false)stale=true;
   }
  }
  if(state.historicalValidity==='invalid'||state.currentApplicability==='ended')return false;
  if(stale){
   const problem=keyUid('system.resolution-stale-evidence',[uid,attachment.target]);
   await internal(tx,contract,()=>save(tx,contract,'system.problem',problem,{rule:'resolution-stale-evidence',fingerprint:`${uid}:${attachment.target}`,reason:'Resolution evidence is stale; its source must reconcile current support.'},[{kind:'system.problem-about',target:uid,targetKind:'system.dispute-resolution'}]));
  }
 }
 return true;
 });
}
/** Call once after the operation's final assertions and deferred evidence, while its write lock is held. */
export interface AffectedDisputeSlot {readonly sort:'vertex'|'edge';readonly kind:string;readonly subjectId:number;readonly property:string;readonly language?:string|null}
export async function reconcileDisputes(tx:SqlExecutor,declared:GraphContract,affected?:readonly AffectedDisputeSlot[]|'all',propagate=true):Promise<void>{
 return await withSpan('graph.dispute.reconcile',{},async()=>{
 const contract=withAssertionContract(declared);const binding=requireWriteCapability(tx);
 const now=(await tx.query<{now:string}>(`SELECT clock_timestamp()::text AS now`)).rows[0]!.now;
 const layers=await contextLayers(tx,String(binding.context));
 const selectors:Selectors={validAt:now,recordedAt:now,contexts:layers.map(layer=>Number(layer.id)),contextRecordedThrough:Object.fromEntries(layers.map(layer=>[Number(layer.id),layer.recordedThrough]))};
 const operationUid=binding.operationUid;
 const touched=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,coalesce(subject.id,edge_subject.id) AS subject_id,a.property,a.language FROM assertion a JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity lineage_kind ON lineage_kind.id=lineage.entity_id AND lineage_kind.name='system.assertion-operation' JOIN node op ON op.id=lineage.to_node LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id LEFT JOIN node subject ON subject.id=attachment.to_node LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id) WHERE op.uid=$1::uuid`,[operationUid])).rows;
 const relevant=affected===undefined||affected==='all'?touched.map(row=>({sort:row.sort,kind:row.kind,subjectId:Number(row.subject_id),property:row.property,language:row.language})):affected;
 // Reverse structural evidence dependencies are bounded by subjects written by this operation.
 const support=affected===undefined?evidenceSupportRoles((await readPublishedManifest(tx))?.semanticBindings):undefined;
 const here=support?.direction==='to'?'to_node':'from_node',there=support?.direction==='to'?'from_node':'to_node';
 const evidenceTargets=affected===undefined?(await tx.query<{id:number}>(`WITH vertices AS (SELECT DISTINCT unnest($1::bigint[]) AS id), written_edges AS (SELECT e.* FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.id=ANY($2::bigint[]) AND k.name=$3), sources AS (SELECT ${there} AS id FROM written_edges)
 SELECT id FROM vertices UNION SELECT ${here} FROM written_edges UNION SELECT e.${here} FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.${there} IN (SELECT id FROM sources UNION SELECT id FROM vertices) AND k.name=$3`,[touched.filter(row=>row.sort==='vertex').map(row=>Number(row.subject_id)),touched.filter(row=>row.sort==='edge').map(row=>Number(row.subject_id)),support?.edgeKind??null])).rows.map(row=>Number(row.id)):[];
 const anchors=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,CASE WHEN subject.id IS NOT NULL THEN graph_assertion_target(subject.id,a.assertion_id,$1::bigint,$2::timestamptz,$3::timestamptz) ELSE edge_subject.id END AS subject_id,a.property,a.language FROM edge anchor JOIN entity ak ON ak.id=anchor.entity_id AND ak.name='system.dispute-anchor' JOIN assertion a ON a.assertion_id=anchor.to_node LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id LEFT JOIN node subject ON subject.id=attachment.to_node LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id) WHERE $6::boolean OR EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) slot(sort text,kind text,"subjectId" bigint,property text,language text) WHERE slot.sort=CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AND slot.kind=k.name AND CASE WHEN slot.sort='vertex' THEN graph_merge_target(slot."subjectId",$1::bigint,$2::timestamptz,$3::timestamptz) ELSE slot."subjectId" END=CASE WHEN subject.id IS NOT NULL THEN graph_assertion_target(subject.id,a.assertion_id,$1::bigint,$2::timestamptz,$3::timestamptz) ELSE edge_subject.id END AND slot.property=a.property AND slot.language IS NOT DISTINCT FROM a.language) OR EXISTS(
 SELECT 1 FROM edge qr JOIN entity qrk ON qrk.id=qr.entity_id AND qrk.name='system.dispute-question-resolution'
 JOIN assertion_vertex_subject rationale ON true JOIN edge rs ON rs.id=rationale.subject_edge_id AND rs.to_node=qr.to_node
 JOIN assertion ra ON ra.assertion_id=rationale.assertion_id AND ra.property='rationale'
 JOIN edge evidence ON evidence.from_node=ra.assertion_id JOIN entity ek ON ek.id=evidence.entity_id AND ek.name='system.assertion-evidence'
 WHERE qr.from_node=anchor.from_node AND evidence.to_node=ANY($5::bigint[]))`,[selectors.contexts[0],selectors.validAt,selectors.recordedAt,JSON.stringify(relevant),evidenceTargets,affected==='all'])).rows;
 const affectedSlots=[...relevant,...anchors.map(row=>({sort:row.sort,kind:row.kind,subjectId:Number(row.subject_id),property:row.property,language:row.language}))];
 const slots=new Map<string,StoredAssertion[]>();
 for(const sort of ['vertex','edge'] as const)for(const kind of contract[sort]){
  const changed=affectedSlots.filter(slot=>slot.sort===sort&&slot.kind===kind.name&&isDisputableProperty(sort,kind.name,slot.property));if(changed.length===0)continue;
  const rows=await mergedAssertions(tx,sort,kind.name,[...new Set(changed.map(slot=>slot.property))],[...new Set(changed.map(slot=>slot.subjectId))],selectors);
  for(const row of rows){const key=JSON.stringify([sort,subject(row),row.property,row.language]);slots.set(key,[...(slots.get(key)??[]),row]);}
 }
 if(slots.size===0)return;
 const anchoredSlots=new Set(anchors.map(row=>JSON.stringify([row.sort,Number(row.subject_id),row.property,row.language])));
 for(const [key,rows] of slots){
  const row=rows[0]!;
  // One source cannot disagree with itself; anchored slots still need evidence revalidation.
  if(!anchoredSlots.has(JSON.stringify([row.subject.type,row.subjectId,row.property,row.language]))&&new Set(rows.filter(row=>row.operation==='assert').map(row=>row.source)).size<=1)slots.delete(key);
 }
 if(slots.size>0)await internal(tx,contract,async()=>{let snapshot=await reconciliationSnapshot(tx,[...slots.values()].flat());for(const rows of slots.values()){
  const instants=[...new Set([now,...rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])])])];
  for(const validAt of instants){
  const segmentSelectors={...selectors,validAt,recordedAt:snapshot.at};
  const candidateRows=snapshot.producerRows(rows);
  const selection=selectAssertions(candidateRows,segmentSelectors);
  const existing=await judgeDispute(tx,contract,candidateRows,segmentSelectors,snapshot);
  if(existing){
   const desired=existing.state;
   const held=snapshot.records('system.dispute-question',segmentSelectors).get(existing.id);
   if(held?.['state']!==desired){
    if(desired!=='RESOLVED')for(const resolution of existing.supersededResolutions){
     const assertion=await loadResolutionAssertion(tx,contract,resolution,rows,segmentSelectors);if(!assertion)continue;
     const evidenceValid=await resolutionEvidenceValid(tx,contract,resolution,{...segmentSelectors,validAt:now},snapshot);
     const from=evidenceValid?segmentAt(candidateRows,validAt).from:assertion.validFrom;
     const subjectKind=(await tx.query<{kind:string}>(`SELECT k.name AS kind FROM ${assertion.subject.type==='vertex'?'node':'edge'} s JOIN entity k ON k.id=s.entity_id WHERE s.id=$1::bigint`,[assertion.subjectId])).rows[0]!.kind;
     const previous=requireWriteCapability(tx);
     try{
      bindWriteCapability(tx,{...binding,sourceUid:assertion.source,permissions:[{kind:subjectKind,properties:[assertion.property],assert:false,retractOwn:true}]});
      await writeAssertion(tx,contract,{sort:assertion.subject.type,kind:subjectKind,subjectId:String(assertion.subjectId),property:assertion.property,language:assertion.language,operation:'retract',validFrom:from,validTo:assertion.validTo},binding.context);
     }finally{bindWriteCapability(tx,previous);}
    }
    const oldCandidates=snapshot.links(existing.id,'system.dispute-candidate',segmentSelectors);
    for(const candidate of oldCandidates.filter(uid=>!selection.candidates.some(row=>row.id===uid))){
     const edge=(await tx.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name='system.dispute-candidate' AND origin.uid=$1::uuid AND target.uid=$2::uuid`,[existing.id,candidate])).rows[0];
     if(edge)await writeAssertion(tx,contract,{sort:'edge',kind:'system.dispute-candidate',subjectId:edge.id,property:'$exists',operation:'retract',validFrom:'0001-01-01T00:00:00.000Z'},binding.context);
    }
    await recordQuestionState(tx,contract,existing.id,desired,selection.candidates.filter(row=>!oldCandidates.includes(row.id)).map(row=>({kind:'system.dispute-candidate',target:row.id,targetKind:'system.assertion'})),segmentAt(candidateRows,validAt));
    snapshot=await reconciliationSnapshot(tx,rows,existing.id,snapshot);
   }
   continue;
  }
  if(!selection.contested)continue;
  const segment=segmentAt(selection.candidates,validAt);const uid=newUid();
  await save(tx,contract,'system.dispute-question',uid,{property:rows[0]!.property,language:rows[0]!.language,segment_from:segment.from,segment_to:segment.to,state:'OPEN'},[
   {kind:'system.dispute-anchor',target:rows[0]!.id,targetKind:'system.assertion'},
   ...selection.candidates.map(row=>({kind:'system.dispute-candidate',target:row.id,targetKind:'system.assertion'})),
  ],undefined,segment);
  snapshot=await reconciliationSnapshot(tx,rows,uid,snapshot);
 }}});
 if(propagate){
  const children=(await tx.query<{id:string}>(`WITH RECURSIVE children AS (SELECT id FROM context WHERE parent=$1::bigint AND parent_recorded_seq IS NULL UNION ALL SELECT c.id FROM context c JOIN children p ON c.parent=p.id WHERE c.parent_recorded_seq IS NULL) SELECT id::text AS id FROM children`,[binding.context])).rows;
  for(const child of children){
   const owns=(await tx.query<{owned:boolean}>(`SELECT EXISTS(SELECT 1 FROM assertion WHERE context_id=$1::bigint) AS owned`,[child.id])).rows[0]?.owned;if(!owns)continue;
   try{bindWriteCapability(tx,{...binding,context:Number(child.id)});await reconcileDisputes(tx,contract,affectedSlots,false);}finally{bindWriteCapability(tx,binding);}
  }
 }
 });
}
export interface ResolveDisputeInput {readonly questionUid:string;readonly chosenAssertionUid:string;readonly expectedCandidates:readonly string[];readonly rationale:string;readonly evidence:readonly EvidenceDraft[]}
/** A decision appends its own lineage; it never rewrites a producer's assertion. */
export async function resolveDispute(tx:SqlExecutor,declared:GraphContract,binding:ProducerBinding,input:ResolveDisputeInput):Promise<string>{
 return await withSpan('graph.dispute.resolve',{},async()=>{
 await acquireGraphWriteLock(tx);
 requireProducerAction(binding,'resolve');if(!input.rationale||!input.evidence.length)throw new Error(`${import.meta.path}:150: EVIDENCE_INVALID resolution needs rationale and evidence`);
 const contract=withAssertionContract(declared);const capability=requireWriteCapability(tx);
 requirePublicationBinding(tx,contract,binding,capability.context);
 if(binding.sourceUid!==capability.sourceUid||binding.principalUid!==capability.principalUid)throw new Error(`${import.meta.path}:157: SOURCE_FORBIDDEN resolution principal differs from active capability`);
 const now=(await tx.query<{now:string}>(`SELECT clock_timestamp()::text AS now`)).rows[0]!.now;
 const layers=await contextLayers(tx,String(capability.context));
 const selectors:Selectors={validAt:now,recordedAt:now,contexts:layers.map(layer=>Number(layer.id)),contextRecordedThrough:Object.fromEntries(layers.map(layer=>[Number(layer.id),layer.recordedThrough]))};
 const questions=await records(tx,'system.dispute-question',selectors);const question=questions.get(input.questionUid);if(!question)throw new Error(`${import.meta.path}:155: TARGET_MISSING question`);
 const anchor=(await links(tx,input.questionUid,'system.dispute-anchor',selectors))[0];
 const location=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,coalesce(subject.id,edge_subject.id) AS subject_id,a.property,a.language FROM assertion a JOIN node header ON header.id=a.assertion_id LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id LEFT JOIN node subject ON subject.id=attachment.to_node LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id) WHERE header.uid=$1::uuid`,[anchor])).rows[0];
 if(!location)throw new Error(`${import.meta.path}:172: TARGET_MISSING question subject`);
 const sort=location.sort;const kindRow={kind:location.kind};
 const rows=(await mergedAssertions(tx,sort,location.kind,[location.property],[Number(location.subject_id)],selectors)).filter(row=>row.language===location.language);
 const anchorRow=rows[0];if(!anchorRow)throw new Error(`${import.meta.path}:172: TARGET_MISSING question subject`);
 requireProducerBinding(tx,contract,binding,capability.context,sort,kindRow.kind,anchorRow.property==='$exists'?[]:[anchorRow.property],undefined,undefined,'resolve');
 await requireAssertionScope(tx,contract,capability,{sort,subjectId:String(anchorRow.subjectId)},capability.context);
 const selection=selectAssertions(await producerRows(tx,rows),selectors);if(!selection.contested)throw new Error(`${import.meta.path}:176: REVISION_CONFLICT question is no longer disputed`);
 const current=selection.candidates;const expected=[...input.expectedCandidates].sort(byCodePoint);const actual=current.map(row=>row.id).sort(byCodePoint);
 if(JSON.stringify(expected)!==JSON.stringify(actual)||!actual.includes(input.chosenAssertionUid))throw new Error(`${import.meta.path}:161: REVISION_CONFLICT dispute candidates changed`);
 const uid=newUid();const previous=await links(tx,input.questionUid,'system.dispute-question-resolution',selectors);
 const currentSegment=segmentAt(current,now);question['segment_from']=currentSegment.from;question['segment_to']=currentSegment.to;
 const decisionSource=await resolutionSource(tx,contract,capability.principalUid,capability.productUid);
 const chosen=current.find(row=>row.id===input.chosenAssertionUid)!;
 let assertionUid:string;
 try{
  bindWriteCapability(tx,{...capability,sourceUid:decisionSource,permissions:[...capability.permissions,{kind:location.kind,properties:[location.property],assert:true,retractOwn:true}]});
  assertionUid=await writeAssertion(tx,contract,{sort,kind:location.kind,subjectId:String(location.subject_id),property:location.property,language:location.language,operation:'assert',value:chosen.value,validFrom:currentSegment.from,validTo:currentSegment.to,evidence:input.evidence},capability.context);
 }finally{bindWriteCapability(tx,capability);}
 await internal(tx,contract,async()=>{
  await save(tx,contract,'system.dispute-resolution',uid,{segment_from:question['segment_from'],segment_to:question['segment_to'],rationale:input.rationale},[
   ...current.map(row=>({kind:'system.resolution-judged',target:row.id,targetKind:'system.assertion'})),
   {kind:'system.dispute-resolution-question',target:input.questionUid,targetKind:'system.dispute-question'},
   {kind:'system.dispute-chosen',target:input.chosenAssertionUid,targetKind:'system.assertion'},
   {kind:'system.resolution-assertion',target:assertionUid,targetKind:'system.assertion'},
   ...previous.map(target=>({kind:'system.dispute-supersedes',target,targetKind:'system.dispute-resolution'})),
  ],input.evidence);
 },true);
 await internal(tx,contract,async()=>{
  await recordQuestionState(tx,contract,input.questionUid,'RESOLVED',previous.includes(uid)?[]:[{kind:'system.dispute-question-resolution',target:uid,targetKind:'system.dispute-resolution'}],currentSegment);
 });return uid;
 });
}

