/** Durable graph disputes and value-pinned resolutions (0039 items 16,17,27). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, EvidenceDraft } from './contract.js';
import { withAssertionContract, isDisputableProperty } from './system-contract.js';
import { loadAssertions, type StoredAssertion } from './assertion-read.js';
import { DISPUTE_EXISTENCE_SETTING, selectAssertions, candidateFingerprint, resolutionMatches, canonicalAssertionValue, applySemanticResolution, type AssertionRow } from './assertion-selection.js';
import { bindWriteCapability, requireWriteCapability, requireAssertionScope, bindSemanticRefresh, publishGraphDrafts } from './write.js';
import { requireProducerAction, requirePublicationBinding, requireProducerBinding, type ProducerBinding } from './producer-binding.js';
import { newUid } from './uid.js';
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
 return await loadAssertions(tx,sort,kind,properties,targets,merged&&sort==='vertex'?{context:selectors.contexts[0]!,validAt:selectors.validAt,recordedAt:selectors.recordedAt}:undefined);
 });
}
type Selectors = Parameters<typeof selectAssertions>[1];
export interface DisputeView {
  readonly id:string; readonly state:'OPEN'|'RESOLVED'; readonly candidates:readonly string[];
  readonly resolution:string|null; readonly supersededResolutions:readonly string[];
  readonly selectedAssertionUid:string|null;
}
interface Segment {from:string;to:string|null}
const kinds=['system.dispute-question','system.dispute-resolution','system.dispute-pin'];
const edgeKinds=['system.dispute-anchor','system.dispute-candidate','system.dispute-question-resolution','system.resolution-judged','system.dispute-chosen','system.dispute-supersedes','system.dispute-pin-resolution','system.dispute-pin-assertion','system.dispute-pin-source','system.dispute-resolution-question'];
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
 for(const [uid,values] of grouped){const fields:Record<string,unknown>={};for(const property of properties){const selected=selectAssertions(values.filter(r=>r.property===property),selectors).selected;if(selected)fields[property]=selected.value;}if(Object.keys(fields).length)result.set(uid,fields);}
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
async function save(tx:SqlExecutor,contract:GraphContract,kind:string,uid:string,values:Record<string,unknown>,edges:readonly {kind:string;target:string;targetKind:string}[],evidence?:readonly EvidenceDraft[]):Promise<void>{
 return await withSpan('graph.dispute.save',{},async()=>{
 const binding=requireWriteCapability(tx);const from={kind,uid,key:{}};
 await publishGraphDrafts(tx,contract,{vertices:[{...from,values,evidence,validFrom:'0001-01-01T00:00:00.000Z',producer:binding.sourceUid,producerVersion:'1'}],removals:[],edges:edges.map(e=>({kind:e.kind,from,to:{kind:e.targetKind,uid:e.target,key:{}},discriminator:e.target,validFrom:'0001-01-01T00:00:00.000Z',producer:binding.sourceUid,producerVersion:'1'}))},binding.context);
 });
}
function segmentAt(rows:readonly AssertionRow[],at:string):Segment{
 const point=Date.parse(at);const bounds=rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])]).map(Date.parse).sort((a,b)=>a-b);
 return {from:new Date(Math.max(...bounds.filter(b=>b<=point),-62135596800000)).toISOString(),to:bounds.find(b=>b>point)===undefined?null:new Date(bounds.find(b=>b>point)!).toISOString()};
}
async function candidatesForResolution(tx:SqlExecutor,all:readonly StoredAssertion[],resolution:string,selectors:Selectors):Promise<StoredAssertion[]>{const ids=await links(tx,resolution,'system.resolution-judged',selectors);return all.filter(row=>ids.includes(row.id));}
/** Materialize a persisted question at the same temporal/context snapshot as its slot. */
export async function readDispute(tx:SqlExecutor,contract:GraphContract,rows:readonly StoredAssertion[],selectors:Selectors):Promise<DisputeView|null>{
 return await withSpan('graph.dispute.read',{},async()=>{
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
   const evidenceValid=await resolutionEvidenceValid(tx,contract,resolution,selectors);
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
  if(state.historicalValidity!=='valid'||state.availability!=='available'||(support!==undefined&&state.currentApplicability!=='current'))return false;
 }
 return true;
 });
}
/** Call once after the operation's final assertions and deferred evidence, while its write lock is held. */
export interface AffectedDisputeSlot {readonly sort:'vertex'|'edge';readonly kind:string;readonly subjectId:number;readonly property:string;readonly language?:string|null}
export async function reconcileDisputes(tx:SqlExecutor,declared:GraphContract,affected?:readonly AffectedDisputeSlot[]):Promise<void>{
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
  const rows=await mergedAssertions(tx,sort,kind.name,[...new Set(changed.map(slot=>slot.property))],[...new Set(changed.map(slot=>slot.subjectId))],selectors);
  for(const row of rows){const key=JSON.stringify([sort,subject(row),row.property,row.language]);slots.set(key,[...(slots.get(key)??[]),row]);}
 }
 if(slots.size===0)return;
 await internal(tx,contract,async()=>{for(const rows of slots.values()){
  const instants=[...new Set([now,...rows.flatMap(row=>[row.validFrom,...(row.validTo===null?[]:[row.validTo])])])];
  for(const validAt of instants){
  const segmentSelectors={...selectors,validAt,recordedAt:(await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now};
  const selection=selectAssertions(rows,segmentSelectors);if(selection.candidates.length===0)continue;
  const existing=await readDispute(tx,contract,rows,segmentSelectors);
  if(existing){
   const desired=existing.state;
   const held=(await records(tx,'system.dispute-question',segmentSelectors)).get(existing.id);
   if(held?.['state']!==desired)await save(tx,contract,'system.dispute-question',existing.id,{state:desired,segment_from:segmentAt(selection.candidates.length?selection.candidates:rows,validAt).from,segment_to:segmentAt(selection.candidates.length?selection.candidates:rows,validAt).to},[]);
   continue;
  }
  if(!selection.contested)continue;
  const segment=segmentAt(selection.candidates,validAt);const uid=newUid();
  await save(tx,contract,'system.dispute-question',uid,{property:rows[0]!.property,language:rows[0]!.language,segment_from:segment.from,segment_to:segment.to,state:'OPEN'},[
   {kind:'system.dispute-anchor',target:rows[0]!.id,targetKind:'system.assertion'},
   ...selection.candidates.map(row=>({kind:'system.dispute-candidate',target:row.id,targetKind:'system.assertion'})),
  ]);
 }}});
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
 const selection=selectAssertions(rows,selectors);if(!selection.contested)throw new Error(`${import.meta.path}:176: REVISION_CONFLICT question is no longer disputed`);
 const current=selection.candidates;const expected=[...input.expectedCandidates].sort(byCodePoint);const actual=current.map(row=>row.id).sort(byCodePoint);
 if(JSON.stringify(expected)!==JSON.stringify(actual)||!actual.includes(input.chosenAssertionUid))throw new Error(`${import.meta.path}:161: REVISION_CONFLICT dispute candidates changed`);
 const uid=newUid();const previous=await links(tx,input.questionUid,'system.dispute-question-resolution',selectors);
 const currentSegment=segmentAt(current,now);question['segment_from']=currentSegment.from;question['segment_to']=currentSegment.to;
 await internal(tx,contract,async()=>{
  await save(tx,contract,'system.dispute-resolution',uid,{segment_from:question['segment_from'],segment_to:question['segment_to'],rationale:input.rationale},[
   ...current.map(row=>({kind:'system.resolution-judged',target:row.id,targetKind:'system.assertion'})),
   {kind:'system.dispute-resolution-question',target:input.questionUid,targetKind:'system.dispute-question'},
   {kind:'system.dispute-chosen',target:input.chosenAssertionUid,targetKind:'system.assertion'},
   ...previous.map(target=>({kind:'system.dispute-supersedes',target,targetKind:'system.dispute-resolution'})),
  ],input.evidence);
  for(const row of current){
   const segment={from:String(question['segment_from']),to:question['segment_to']===null?null:String(question['segment_to'])};
   const pin=candidateFingerprint(row,segment);const pinUid=newUid();
   const source=(await tx.query<{kind:string}>(`SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[row.source])).rows[0]!;
   await save(tx,contract,'system.dispute-pin',pinUid,{canonical_value:canonicalAssertionValue(row.operation==='retract'?null:row.value),digest:pin.digest,segment_from:segment.from,segment_to:segment.to},[
    {kind:'system.dispute-pin-resolution',target:uid,targetKind:'system.dispute-resolution'},
    {kind:'system.dispute-pin-assertion',target:row.id,targetKind:'system.assertion'},
    {kind:'system.dispute-pin-source',target:row.source,targetKind:source.kind},
   ]);
  }
  await save(tx,contract,'system.dispute-question',input.questionUid,{state:'RESOLVED'},[{kind:'system.dispute-question-resolution',target:uid,targetKind:'system.dispute-resolution'}]);
 },true);return uid;
 });
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
   const all=await mergedAssertions(tx,group.sort,group.kind,[...group.properties],[...group.subjects],selectors);
   for(const anchor of group.slots){
    const target=anchor.sort==='vertex'?(await tx.query<{id:number}>(`SELECT graph_merge_target($1::bigint,$2::bigint,$3::timestamptz,$4::timestamptz) AS id`,[anchor.subject_id,selectors.contexts[0],selectors.validAt,selectors.recordedAt])).rows[0]!.id:anchor.subject_id;
    const rows=all.filter(row=>row.subjectId===Number(target)&&row.property===anchor.property&&row.language===anchor.language);const dispute=await readDispute(tx,contract,rows,selectors);
    if(dispute)result.push({sort:group.sort,kind:group.kind,subjectId:Number(target),property:anchor.property,language:anchor.language,rows,dispute});
   }
  }
  return result;
 });
}

/** An Assertion envelope with resolution lineage and the chosen slot's validated typed value. */
export async function loadResolutionAssertion(tx:SqlExecutor,_contract:GraphContract,uid:string,rows:readonly StoredAssertion[],selectors:Selectors):Promise<StoredAssertion|null> {
 return await withSpan('graph.dispute.resolution-assertion',{},async()=>{
  const chosenUid=(await links(tx,uid,'system.dispute-chosen',selectors))[0];const chosen=rows.find(row=>row.id===chosenUid);if(!chosen)return null;
  const metadata=selectAssertions((await loadAssertions(tx,'vertex','system.dispute-resolution',['rationale'])).filter(row=>subject(row)===uid),selectors).selected as StoredAssertion|null;
  return metadata===null?null:{...chosen,id:uid,source:metadata.source,author:metadata.author,unit:metadata.unit,operationUid:metadata.operationUid,evidence:metadata.evidence,recordedAt:metadata.recordedAt,recordedSequence:metadata.recordedSequence};
 });
}

/** Installs the host's canonical reader for revision-fenced SQL existence projections. */
export async function installDisputeSelection(tx:SqlExecutor,declared:GraphContract):Promise<void> {
 bindSemanticRefresh(tx,()=>refreshDisputeSelection(tx,declared));
 await refreshDisputeSelection(tx,declared);
}
/** Rebuildable transaction-local read projection; stale or absent SQL projections fail closed. */
export async function refreshDisputeSelection(tx:SqlExecutor,declared:GraphContract):Promise<void> {
 return await withSpan('graph.dispute.refresh-existence',{},async()=>{
 const snapshot=(await tx.query<{txid:string;revision:string;at:string;recorded:string;held:string|null}>(`SELECT txid_current()::text AS txid,coalesce(nullif(current_setting('madarch.graph_revision',true),''),'0') AS revision,instant.at::text AS at,instant.at::text AS recorded,current_setting('${DISPUTE_EXISTENCE_SETTING}',true) AS held FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS at) instant`)).rows[0]!;
 if(snapshot.held){const held=JSON.parse(snapshot.held) as {txid?:string;revision?:string;at?:string};if(held.txid===snapshot.txid&&held.revision===snapshot.revision)return;}
 const contexts:Record<string,string[]>={};
 for(const row of (await tx.query<{id:string}>('SELECT id::text AS id FROM context ORDER BY id')).rows){
  const layers=await contextLayers(tx,row.id);
  const selectors:Selectors={validAt:snapshot.at,recordedAt:snapshot.recorded,contexts:layers.map(layer=>Number(layer.id)),contextRecordedThrough:Object.fromEntries(layers.map(layer=>[Number(layer.id),layer.recordedThrough]))};
  contexts[row.id]=(await listDisputeSlots(tx,declared,selectors)).filter(slot=>slot.property==='$exists'&&slot.dispute.state==='RESOLVED'&&slot.dispute.selectedAssertionUid!==null).map(slot=>slot.dispute.selectedAssertionUid!);
 }
 await tx.query(`SELECT set_config('${DISPUTE_EXISTENCE_SETTING}',$1,true)`,[JSON.stringify({txid:snapshot.txid,revision:snapshot.revision,at:snapshot.at,recordedAt:snapshot.recorded,contexts})]);
 });
}
