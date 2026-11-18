/** Writer-side dispute judgement and ordinary resolution assertions (0039 items 16,17,27). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, EvidenceDraft } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { loadResolutionAssertion, type DisputeView } from './dispute-read.js';
import { loadAssertions, type StoredAssertion } from './assertion-read.js';
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
function segmentAt(rows:readonly AssertionRow[],at:string):Segment{
 const point=Date.parse(at);const bounds=rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])]).map(Date.parse).sort((a,b)=>a-b);
 return {from:new Date(Math.max(...bounds.filter(b=>b<=point),-62135596800000)).toISOString(),to:bounds.find(b=>b>point)===undefined?null:new Date(bounds.find(b=>b>point)!).toISOString()};
}
async function candidatesForResolution(tx:SqlExecutor,all:readonly StoredAssertion[],resolution:string,selectors:Selectors):Promise<StoredAssertion[]>{const ids=await links(tx,resolution,'system.resolution-judged',selectors);return all.filter(row=>ids.includes(row.id));}
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
async function judgeDispute(tx:SqlExecutor,contract:GraphContract,rows:readonly StoredAssertion[],selectors:Selectors):Promise<DisputeView|null>{
 return await withSpan('graph.dispute.read',{},async()=>{
 rows=await producerRows(tx,rows);
 if(!rows.length)return null;
 const selected=selectAssertions(rows,selectors);const questions=await records(tx,'system.dispute-question',selectors);
 const resolutions=await records(tx,'system.dispute-resolution',selectors);
 for(const [id,fields] of questions){
  const anchor=(await links(tx,id,'system.dispute-anchor',selectors))[0];const anchorRow=rows.find(row=>row.id===anchor);if(!anchorRow)continue;
  const segment=segmentAt(selected.candidates.length?selected.candidates:rows,selectors.validAt);
  if(fields['segment_from']===undefined)continue;
  if(Date.parse(String(fields['segment_from']))>=Date.parse(segment.to??'9999-01-01T00:00:00Z')||(fields['segment_to']!==null&&Date.parse(String(fields['segment_to']))<=Date.parse(segment.from)))continue;
  const history=(await links(tx,id,'system.dispute-question-resolution',selectors)).filter(uid=>resolutions.has(uid));
  let matching:string|null=null;let chosen:string|null=null;
  for(const resolution of history){
   const pin=await candidatesForResolution(tx,rows,resolution,selectors);const current=selected.candidates;
   const metadata=resolutions.get(resolution)!;const scope={from:String(metadata['segment_from']),to:metadata['segment_to']===null?null:String(metadata['segment_to'])};
   const evidenceAt=(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
   const evidenceValid=await resolutionEvidenceValid(tx,contract,resolution,{...selectors,validAt:evidenceAt});
   if(pin.length&&resolutionMatches(pin.map(row=>candidateFingerprint(row,scope)),current.map(row=>candidateFingerprint(row,segment)),evidenceValid)){
    const chosenId=(await links(tx,resolution,'system.dispute-chosen',selectors))[0];const original=rows.find(row=>row.id===chosenId);
    const repeated=original?applySemanticResolution(selected,{pins:pin.map(row=>candidateFingerprint(row,scope)),segment,chosenSource:original.source,chosenValue:original.value,evidenceValid}).selected:null;
    if(repeated){matching=resolution;chosen=repeated.id;}
   }
  }
  return {id,state:matching===null?'OPEN':'RESOLVED',candidates:selected.candidates.map(row=>row.id),resolution:matching,supersededResolutions:history.filter(uid=>uid!==matching),selectedAssertionUid:chosen};
 }
 return null;
 });
}
async function resolutionEvidenceValid(tx:SqlExecutor,contract:GraphContract,uid:string,selectors:Selectors):Promise<boolean>{
 return await withSpan('graph.dispute.evidence',{},async()=>{
 const values=(await loadAssertions(tx,'vertex','system.dispute-resolution',['rationale'])).filter(row=>subject(row)===uid);
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
export async function reconcileDisputes(tx:SqlExecutor,declared:GraphContract,affected?:readonly AffectedDisputeSlot[],propagate=true):Promise<void>{
 return await withSpan('graph.dispute.reconcile',{},async()=>{
 const contract=withAssertionContract(declared);const binding=requireWriteCapability(tx);
 const now=(await tx.query<{now:string}>(`SELECT clock_timestamp()::text AS now`)).rows[0]!.now;
 const layers=await contextLayers(tx,String(binding.context));
 const selectors:Selectors={validAt:now,recordedAt:now,contexts:layers.map(layer=>Number(layer.id)),contextRecordedThrough:Object.fromEntries(layers.map(layer=>[Number(layer.id),layer.recordedThrough]))};
 const operationUid=binding.operationUid;
 const touched=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,coalesce(subject.id,edge_subject.id) AS subject_id,a.property,a.language FROM assertion a JOIN edge lineage ON lineage.from_node=a.assertion_id JOIN entity lineage_kind ON lineage_kind.id=lineage.entity_id AND lineage_kind.name='system.assertion-operation' JOIN node op ON op.id=lineage.to_node LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id LEFT JOIN node subject ON subject.id=attachment.to_node LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id) WHERE op.uid=$1::uuid`,[operationUid])).rows;
 const relevant=affected??touched.map(row=>({sort:row.sort,kind:row.kind,subjectId:Number(row.subject_id),property:row.property,language:row.language}));
 // Existing question anchors are the reverse-dependency set for justification withdrawal.
 const anchors=(await tx.query<{sort:'vertex'|'edge';kind:string;subject_id:number;property:string;language:string|null}>(`SELECT CASE WHEN vertex.assertion_id IS NOT NULL THEN 'vertex' ELSE 'edge' END AS sort,k.name AS kind,coalesce(subject.id,edge_subject.id) AS subject_id,a.property,a.language FROM edge anchor JOIN entity ak ON ak.id=anchor.entity_id AND ak.name='system.dispute-anchor' JOIN assertion a ON a.assertion_id=anchor.to_node LEFT JOIN assertion_vertex_subject vertex ON vertex.assertion_id=a.assertion_id LEFT JOIN edge attachment ON attachment.id=vertex.subject_edge_id LEFT JOIN node subject ON subject.id=attachment.to_node LEFT JOIN assertion_edge_subject edge_attachment ON edge_attachment.assertion_id=a.assertion_id LEFT JOIN edge edge_subject ON edge_subject.id=edge_attachment.edge_id JOIN entity k ON k.id=coalesce(subject.entity_id,edge_subject.entity_id)`)).rows;
 const affectedSlots=[...relevant,...anchors.map(row=>({sort:row.sort,kind:row.kind,subjectId:Number(row.subject_id),property:row.property,language:row.language}))];
 const slots=new Map<string,StoredAssertion[]>();
 for(const sort of ['vertex','edge'] as const)for(const kind of contract[sort]){
  const changed=affectedSlots.filter(slot=>slot.sort===sort&&slot.kind===kind.name&&isDisputableProperty(sort,kind.name,slot.property));if(changed.length===0)continue;
  const rows=await loadAssertions(tx,sort,kind.name,[...new Set(changed.map(slot=>slot.property))],[...new Set(changed.map(slot=>slot.subjectId))]);
  for(const row of rows){const key=JSON.stringify([sort,subject(row),row.property,row.language]);slots.set(key,[...(slots.get(key)??[]),row]);}
 }
 if(slots.size===0)return;
 const anchoredSlots=new Set(anchors.map(row=>JSON.stringify([row.sort,Number(row.subject_id),row.property,row.language])));
 for(const [key,rows] of slots){
  const row=rows[0]!;
  // One source cannot disagree with itself; anchored slots still need evidence revalidation.
  if(!anchoredSlots.has(JSON.stringify([row.subject.type,row.subjectId,row.property,row.language]))&&new Set(rows.filter(row=>row.operation==='assert').map(row=>row.source)).size<=1)slots.delete(key);
 }
 if(slots.size>0)await internal(tx,contract,async()=>{for(const rows of slots.values()){
  const instants=[...new Set([now,...rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])])])];
  for(const validAt of instants){
  const segmentSelectors={...selectors,validAt,recordedAt:(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now};
  const candidateRows=await producerRows(tx,rows);
  const selection=selectAssertions(candidateRows,segmentSelectors);
  const existing=await judgeDispute(tx,contract,candidateRows,segmentSelectors);
  if(existing){
   const desired=existing.state;
   const held=(await records(tx,'system.dispute-question',segmentSelectors)).get(existing.id);
   if(held?.['state']!==desired){
    if(desired==='OPEN')for(const resolution of existing.supersededResolutions){
     const assertion=await loadResolutionAssertion(tx,contract,resolution,rows,segmentSelectors);if(!assertion)continue;
     const evidenceValid=await resolutionEvidenceValid(tx,contract,resolution,{...segmentSelectors,validAt:now});
     const from=evidenceValid?segmentAt(candidateRows,validAt).from:assertion.validFrom;
     const subjectKind=(await tx.query<{kind:string}>(`SELECT k.name AS kind FROM ${assertion.subject.type==='vertex'?'node':'edge'} s JOIN entity k ON k.id=s.entity_id WHERE s.id=$1::bigint`,[assertion.subjectId])).rows[0]!.kind;
     const previous=requireWriteCapability(tx);
     try{
      bindWriteCapability(tx,{...binding,sourceUid:assertion.source,permissions:[{kind:subjectKind,properties:[assertion.property],assert:false,retractOwn:true}]});
      await writeAssertion(tx,contract,{sort:assertion.subject.type,kind:subjectKind,subjectId:String(assertion.subjectId),property:assertion.property,language:assertion.language,operation:'retract',validFrom:from,validTo:assertion.validTo},binding.context);
     }finally{bindWriteCapability(tx,previous);}
    }
    const oldCandidates=await links(tx,existing.id,'system.dispute-candidate',segmentSelectors);
    for(const candidate of oldCandidates.filter(uid=>!selection.candidates.some(row=>row.id===uid))){
     const edge=(await tx.query<{id:string}>(`SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node WHERE k.name='system.dispute-candidate' AND origin.uid=$1::uuid AND target.uid=$2::uuid`,[existing.id,candidate])).rows[0];
     if(edge)await writeAssertion(tx,contract,{sort:'edge',kind:'system.dispute-candidate',subjectId:edge.id,property:'$exists',operation:'retract',validFrom:'0001-01-01T00:00:00.000Z'},binding.context);
    }
    await save(tx,contract,'system.dispute-question',existing.id,{state:desired},selection.candidates.map(row=>({kind:'system.dispute-candidate',target:row.id,targetKind:'system.assertion'})),undefined,segmentAt(candidateRows,validAt));

   }
   continue;
  }
  if(!selection.contested)continue;
  const segment=segmentAt(selection.candidates,validAt);const uid=newUid();
  await save(tx,contract,'system.dispute-question',uid,{property:rows[0]!.property,language:rows[0]!.language,segment_from:segment.from,segment_to:segment.to,state:'OPEN'},[
   {kind:'system.dispute-anchor',target:rows[0]!.id,targetKind:'system.assertion'},
   ...selection.candidates.map(row=>({kind:'system.dispute-candidate',target:row.id,targetKind:'system.assertion'})),
  ],undefined,segment);
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
 const rows=(await loadAssertions(tx,sort,location.kind,[location.property],[Number(location.subject_id)])).filter(row=>row.language===location.language);
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
  await save(tx,contract,'system.dispute-question',input.questionUid,{state:'RESOLVED'},[{kind:'system.dispute-question-resolution',target:uid,targetKind:'system.dispute-resolution'}],undefined,currentSegment);
 });return uid;
 });
}

