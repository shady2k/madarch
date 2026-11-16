/** Same-kind duplicate resolution and reversible graph membership (0039 items 20,32). */
import type {SqlExecutor} from '../sql-driver.js';
import {type GraphContract,type EvidenceDraft,type EntityRefDraft,type FieldContract} from './contract.js';
import {reconcileDisputes} from './disputes.js';
import {withAssertionContract} from './system-contract.js';
import {readKindAssertions,type AssertionRecord} from './records.js';
import {publishGraphDrafts,requireWriteCapability,bindWriteCapability,requireAssertionScope,acquireGraphWriteLock,refreshWriteSemantics,writeAssertion} from './write.js';
import {MERGE_ACTION,requireProducerAction,requirePublicationBinding,requireProducerBinding,type ProducerBinding} from './producer-binding.js';
import {startupBinding} from './manifest-publication.js';
import {newUid} from './uid.js';
import {byCodePoint} from '../model/order.js';
import {withSpan} from '../obs/trace.js';

const WHERE=`${import.meta.path}:1`;
export interface DuplicateSignals {
 readonly kind:string; readonly name:string; readonly synonyms:string; readonly edges:readonly string[];
 /** A glossary concept's declared subject field relation. */
 readonly subjectFieldEdge?:string;
}
export interface DuplicateCandidate {readonly left:string;readonly right:string;readonly signals:readonly string[];readonly score:number}
/** Scores explain observations, not confidence or permission to merge. No name-only automatic decision. */
export async function duplicateCandidates(tx:SqlExecutor,declared:GraphContract,signals:DuplicateSignals,context=1):Promise<DuplicateCandidate[]> {
 return await withSpan('graph.merge.candidates',{},async()=>{
 const contract=withAssertionContract(declared),kind=contract.vertex.find(k=>k.name===signals.kind);
 if(!kind||!kind.fields.some(f=>f.name===signals.name&&f.type==='text')||!kind.fields.some((f:FieldContract)=>f.name===signals.synonyms&&f.type==='json'))throw new Error(`${WHERE}: SCHEMA_INVALID declared name/synonym signals required`);
 if(kind.duplicateSubjectRequired&&!kind.duplicateSubjectEdge)throw new Error(`${WHERE}: SCHEMA_INVALID glossary subject field relation required`);
 if(kind.duplicateSubjectEdge){if(signals.subjectFieldEdge&&signals.subjectFieldEdge!==kind.duplicateSubjectEdge)throw new Error(`${WHERE}: SCHEMA_INVALID subject field cannot override contract`);signals={...signals,subjectFieldEdge:kind.duplicateSubjectEdge};}
 for(const name of [...signals.edges,...(signals.subjectFieldEdge?[signals.subjectFieldEdge]:[])])if(!contract.edge.some(edge=>edge.name===name&&(edge.from.includes(kind.name)||edge.to.includes(kind.name))))throw new Error(`${WHERE}: END_KIND_INVALID signal edge ${name}`);
 const nodes=await readKindAssertions(tx,'vertex',kind.name,[signals.name,signals.synonyms],{contract,contexts:[context]});
 const scopes=(await tx.query<{id:number;scope:string}>(`SELECT id,identity_scope::text AS scope FROM node WHERE id=ANY($1::bigint[])`,[nodes.map(n=>n.id)])).rows;
 const relations=new Map<number,Set<string>>();const subjects=new Map<number,Set<string>>();
 for(const edgeName of [...new Set([...signals.edges,...(signals.subjectFieldEdge?[signals.subjectFieldEdge]:[])])]){
  for(const edge of await readKindAssertions(tx,'edge',edgeName,[],{contract,contexts:[context]}))for(const [id,other,side] of [[edge.from!,edge.to!,'from'],[edge.to!,edge.from!,'to']] as const){
   const target=edgeName===signals.subjectFieldEdge?subjects:relations;const set=target.get(id)??new Set();set.add(JSON.stringify([edgeName,side,other]));target.set(id,set);
  }
 }
 const names=(node:AssertionRecord)=>[node.values[signals.name],...(Array.isArray(node.values[signals.synonyms])?node.values[signals.synonyms] as unknown[]:[])].filter((v):v is string=>typeof v==='string'&&v.length>0).map(v=>v.normalize('NFC').toLowerCase());
 const result:DuplicateCandidate[]=[];
 for(let i=0;i<nodes.length;i++)for(const b of nodes.slice(i+1)){
  const a=nodes[i]!;if(scopes.find(s=>Number(s.id)===a.id)?.scope!==scopes.find(s=>Number(s.id)===b.id)?.scope)continue;
  if(signals.subjectFieldEdge&&(!(subjects.get(a.id)?.size)||!(subjects.get(b.id)?.size)))continue;
  if(signals.subjectFieldEdge&&JSON.stringify([...(subjects.get(a.id)??[])].sort(byCodePoint))!==JSON.stringify([...(subjects.get(b.id)??[])].sort(byCodePoint)))continue;
  const matched:string[]=[];
  if(names(a).some(name=>names(b).includes(name)))matched.push('name-or-synonym');
  for(const relation of relations.get(a.id)??[])if(relations.get(b.id)?.has(relation))matched.push(`edge:${relation}`);
  if(matched.length)result.push({left:[a.uid,b.uid].sort(byCodePoint)[0]!,right:[a.uid,b.uid].sort(byCodePoint)[1]!,signals:matched.sort(byCodePoint),score:matched.length});
 }
 return result.sort((a,b)=>byCodePoint(a.left,b.left)||byCodePoint(a.right,b.right));
 });
}
export interface MergeInput {
 readonly members:readonly [EntityRefDraft,EntityRefDraft]; readonly signals:DuplicateSignals;
 readonly decision:'sure'|'unsure';readonly reason:string;readonly evidence:readonly EvidenceDraft[];
}
interface Member extends Record<string,unknown> {id:number;uid:string;kind:string;scope:string}
async function members(tx:SqlExecutor,input:MergeInput):Promise<Member[]> {
 return await withSpan('graph.merge.members',{},async()=>{
 const uids=input.members.map(ref=>ref.uid);if(uids.some(uid=>!uid)||uids[0]===uids[1])throw new Error(`${WHERE}: SCHEMA_INVALID two distinct member uids required`);
 const rows=(await tx.query<Member>(`SELECT n.id,n.uid::text,k.name AS kind,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[]) ORDER BY n.id FOR UPDATE OF n`,[uids])).rows;
 if(rows.length!==2)throw new Error(`${WHERE}: TARGET_MISSING merge member`);
 if(rows.some(row=>row.kind!==input.signals.kind)||rows[0]!.scope!==rows[1]!.scope||input.members.some(ref=>ref.kind!==input.signals.kind))throw new Error(`${WHERE}: END_KIND_INVALID merge requires one kind and compatible scope`);
 return rows.sort((a,b)=>Number(a.id)-Number(b.id)||byCodePoint(a.uid,b.uid));
 });
}
async function save(tx:SqlExecutor,contract:GraphContract,kind:string,uid:string,values:Record<string,unknown>,edges:readonly {kind:string;target:EntityRefDraft}[],evidence:readonly EvidenceDraft[]):Promise<void>{
 return await withSpan('graph.merge.save',{},async()=>{
 const prior=requireWriteCapability(tx);const internal=await startupBinding(tx,contract,'system.merges');
 try{
  bindWriteCapability(tx,{...internal.binding,context:prior.context,principalUid:prior.principalUid,operationUid:prior.operationUid,...(prior.unitUid?{unitUid:prior.unitUid}:{}),permissions:[...contract.vertex,...contract.edge].filter(k=>k.name.startsWith('system.merge')).map(k=>({kind:k.name,properties:['*'],assert:true,retractOwn:true}))});
  const from={kind,key:{},uid};await publishGraphDrafts(tx,contract,{vertices:[{...from,values,evidence,producer:'system.merges',producerVersion:'1'}],removals:[],edges:edges.map(edge=>({kind:edge.kind,from,to:edge.target,discriminator:edge.target.uid,producer:'system.merges',producerVersion:'1'}))},prior.context);
 }finally{bindWriteCapability(tx,prior);}
 });
}
/** Called inside the fenced operation host, never as a publication buffer. */
export async function resolveDuplicate(tx:SqlExecutor,declared:GraphContract,binding:ProducerBinding,input:MergeInput):Promise<{kind:string;uid:string}> {
 return await withSpan('graph.merge.resolve',{},async()=>{
 await acquireGraphWriteLock(tx);requireProducerAction(binding,MERGE_ACTION);const capability=requireWriteCapability(tx),contract=withAssertionContract(declared);
 requirePublicationBinding(tx,contract,binding,capability.context);
 if(binding.sourceUid!==capability.sourceUid||binding.principalUid!==capability.principalUid)throw new Error(`${WHERE}: SOURCE_FORBIDDEN merge principal`);
 if(!input.reason||!input.evidence.length)throw new Error(`${WHERE}: EVIDENCE_INVALID merge needs reason and evidence`);
 const pair=await members(tx,input);
 const canonical=(await tx.query<{uid:string}>(`SELECT DISTINCT target.uid::text FROM node n JOIN node target ON target.id=graph_merge_target(n.id,$2::bigint) WHERE n.uid=ANY($1::uuid[])`,[pair.map(member=>member.uid),capability.context])).rows.map(row=>row.uid);
 if(canonical.length!==2)throw new Error(`${WHERE}: REVISION_CONFLICT members already equivalent`);
 for(const member of pair){requireProducerBinding(tx,contract,binding,capability.context,'vertex',member.kind,[],undefined,undefined,MERGE_ACTION);await requireAssertionScope(tx,contract,capability,{sort:'vertex',subjectId:String(member.id)},capability.context);}
 const candidates=await duplicateCandidates(tx,contract,input.signals,capability.context);const candidate=candidates.find(candidate=>canonical.every(uid=>[candidate.left,candidate.right].includes(uid)));
 if(!candidate)throw new Error(`${WHERE}: REVISION_CONFLICT pair is no longer a duplicate candidate`);
 const before=await readKindAssertions(tx,'vertex',input.signals.kind,[input.signals.name,input.signals.synonyms],{contract,contexts:[capability.context]});
 const refs=pair.map(member=>({kind:member.kind,key:{},uid:member.uid}));const uid=newUid();
 if(input.decision==='unsure'||!candidate.signals.some(signal=>signal.startsWith('edge:'))){
  await save(tx,contract,'system.merge-question',uid,{state:'OPEN',reason:input.reason},refs.map(target=>({kind:'system.merge-question-member',target})),input.evidence);return {kind:'system.merge-question',uid};
 }
 const survivor=(await tx.query<Member>(`SELECT n.id,n.uid::text,k.name AS kind,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[]) ORDER BY (n.key<>'{}'::jsonb) DESC,n.id LIMIT 1`,[canonical])).rows[0]!;
 const losing=before.find(row=>canonical.includes(row.uid)&&row.uid!==survivor.uid)!;
 await save(tx,contract,'system.merge',uid,{state:'ACTIVE',reason:input.reason},[...refs.map(target=>({kind:'system.merge-member',target})),{kind:'system.merge-survivor',target:{kind:survivor.kind,key:{},uid:survivor.uid}}],input.evidence);
 const current=await readKindAssertions(tx,'vertex',survivor.kind,[input.signals.name,input.signals.synonyms],{contract,contexts:[capability.context],subjectUids:[survivor.uid]});
 const original=losing.values[input.signals.name];
 const prior=requireWriteCapability(tx);
 try{
  bindWriteCapability(tx,{...prior,permissions:[...prior.permissions,{kind:survivor.kind,properties:[input.signals.synonyms],assert:true,retractOwn:false}]});
  const held=current[0]?.values[input.signals.synonyms];
  await writeAssertion(tx,contract,{sort:'vertex',kind:survivor.kind,subjectId:String(survivor.id),property:input.signals.synonyms,operation:'assert',value:[...new Set([...(Array.isArray(held)?held:[]),...(Array.isArray(losing.values[input.signals.synonyms])?losing.values[input.signals.synonyms] as unknown[]:[]),...(typeof original==='string'?[original]:[])])].sort(byCodePoint),evidence:input.evidence},prior.context);
 }finally{bindWriteCapability(tx,prior);}
 await reconcileDisputes(tx,contract,contract.vertex.filter(kind=>kind.name===survivor.kind).flatMap(kind=>kind.fields.map(field=>({sort:'vertex' as const,kind:kind.name,subjectId:Number(survivor.id),property:field.name}))));
 await refreshWriteSemantics(tx);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');
 return {kind:'system.merge',uid};
 });
}
export interface UnmergeInput {readonly mergeUid:string;readonly reason:string;readonly evidence:readonly EvidenceDraft[];readonly allocations?:readonly {readonly assertionUid:string;readonly memberUid:string;readonly direction?:'from'|'to'}[]}
/** Later survivor-only edits are not allocated by guess. The question is committed while membership stays active. */
export async function unmerge(tx:SqlExecutor,declared:GraphContract,binding:ProducerBinding,input:UnmergeInput):Promise<{kind:string;uid:string}> {
 return await withSpan('graph.merge.unmerge',{},async()=>{
 await acquireGraphWriteLock(tx);requireProducerAction(binding,MERGE_ACTION);const capability=requireWriteCapability(tx),contract=withAssertionContract(declared);
 requirePublicationBinding(tx,contract,binding,capability.context);
 if(binding.sourceUid!==capability.sourceUid||binding.principalUid!==capability.principalUid)throw new Error(`${WHERE}: SOURCE_FORBIDDEN unmerge principal`);
 if(!input.reason||!input.evidence.length)throw new Error(`${WHERE}: EVIDENCE_INVALID unmerge needs reason and evidence`);
 const record=(await readKindAssertions(tx,'vertex','system.merge',['state'],{contract,contexts:[capability.context],subjectUids:[input.mergeUid]}))[0];
 if(record?.values.state!=='ACTIVE')throw new Error(`${WHERE}: REVISION_CONFLICT merge is not active`);
 const links=(await tx.query<Member>(`SELECT target.id,target.uid::text,k.name AS kind,target.identity_scope::text AS scope FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node target ON target.id=e.to_node JOIN entity k ON k.id=target.entity_id WHERE e.from_node=$1::bigint AND ek.name='system.merge-member' ORDER BY target.id FOR UPDATE OF target`,[record.id])).rows;
 for(const member of links){requireProducerBinding(tx,contract,binding,capability.context,'vertex',member.kind,[],undefined,undefined,MERGE_ACTION);await requireAssertionScope(tx,contract,capability,{sort:'vertex',subjectId:String(member.id)},capability.context);}
 const survivor=(await tx.query<{id:number}>(`SELECT graph_merge_target($1::bigint,$2::bigint) AS id`,[links[0]!.id,capability.context])).rows[0]!.id;
 const revision=record.selectedAssertions.find(a=>a.property==='state')!.recordedSequence;
 const edits=(await tx.query<{uid:string;direction:null|'from'|'to'}>(`WITH RECURSIVE layers AS (
 SELECT c.id,c.parent,c.parent_recorded_seq,NULL::bigint AS cutoff FROM context c WHERE c.id=$4::bigint
 UNION ALL SELECT c.id,c.parent,c.parent_recorded_seq,least(l.cutoff,l.parent_recorded_seq) FROM context c JOIN layers l ON c.id=l.parent
 ) SELECT n.uid::text,endpoint.direction FROM assertion a JOIN node n ON n.id=a.assertion_id JOIN layers layer ON layer.id=a.context_id AND (layer.cutoff IS NULL OR a.recorded_sequence<=layer.cutoff) LEFT JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id LEFT JOIN edge subject ON subject.id=av.subject_edge_id LEFT JOIN assertion_edge_subject ae ON ae.assertion_id=a.assertion_id LEFT JOIN edge relation ON relation.id=ae.edge_id JOIN entity subject_kind ON subject_kind.id=coalesce(relation.entity_id,(SELECT entity_id FROM node WHERE id=subject.to_node)) CROSS JOIN LATERAL (SELECT NULL::text AS direction WHERE (subject.to_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(subject.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp())=$1::bigint AND graph_assertion_target(subject.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp())<>graph_merge_target(subject.to_node,$4::bigint))) UNION ALL SELECT 'from' WHERE (relation.from_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(relation.from_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'from')=$1::bigint AND graph_assertion_target(relation.from_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'from')<>graph_merge_target(relation.from_node,$4::bigint))) UNION ALL SELECT 'to' WHERE (relation.to_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(relation.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'to')=$1::bigint AND graph_assertion_target(relation.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'to')<>graph_merge_target(relation.to_node,$4::bigint)))) endpoint WHERE $1::bigint IS NOT NULL AND a.recorded_at<=clock_timestamp() AND subject_kind.name NOT LIKE 'system.%' AND NOT (subject_kind.name=ANY($6::text[])) AND NOT (av.assertion_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_to_recordset($7::jsonb) identity_field(kind text,property text) WHERE identity_field.kind=subject_kind.name AND identity_field.property=a.property)) AND ((subject.to_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(subject.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp())=$1::bigint AND graph_assertion_target(subject.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp())<>graph_merge_target(subject.to_node,$4::bigint))) OR (relation.from_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(relation.from_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'from')=$1::bigint AND graph_assertion_target(relation.from_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'from')<>graph_merge_target(relation.from_node,$4::bigint))) OR (relation.to_node=graph_merge_target($5::bigint,$4::bigint,a.valid_from,a.recorded_at) OR (graph_assertion_target(relation.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'to')=$1::bigint AND graph_assertion_target(relation.to_node,a.assertion_id,$4::bigint,clock_timestamp(),clock_timestamp(),'to')<>graph_merge_target(relation.to_node,$4::bigint)))) AND a.recorded_sequence>$2::bigint AND NOT EXISTS(SELECT 1 FROM edge own JOIN edge merged ON own.to_node=merged.to_node JOIN entity ok ON ok.id=own.entity_id AND ok.name='system.assertion-operation' JOIN entity mk ON mk.id=merged.entity_id AND mk.name='system.assertion-operation' JOIN node state ON state.uid=$3::uuid WHERE own.from_node=a.assertion_id AND (merged.from_node=state.id OR EXISTS(SELECT 1 FROM assertion_vertex_subject ms JOIN edge me ON me.id=ms.subject_edge_id JOIN node mn ON mn.id=me.to_node JOIN entity mt ON mt.id=mn.entity_id AND mt.name='system.merge' WHERE ms.assertion_id=merged.from_node)))`,[survivor,revision.toString(),record.selectedAssertions.find(a=>a.property==='state')!.id,capability.context,links[0]!.id,contract.vertex.flatMap(kind=>(kind.keyEdges??[]).map(role=>role.edge)),JSON.stringify(contract.vertex.flatMap(kind=>kind.key.map(property=>({kind:kind.name,property}))))])).rows;
 const allocations=input.allocations??[];
 if(new Set(allocations.map(a=>JSON.stringify([a.assertionUid,a.direction??null]))).size!==allocations.length||allocations.some(a=>!edits.some(edit=>edit.uid===a.assertionUid&&edit.direction===(a.direction??null))||!links.some(member=>member.uid===a.memberUid)))throw new Error(`${WHERE}: SCHEMA_INVALID allocation must name a later assertion and original member`);
 if(edits.some(edit=>!allocations.some(a=>a.assertionUid===edit.uid&&(a.direction??null)===edit.direction))){const uid=newUid();await save(tx,contract,'system.merge-question',uid,{state:'OPEN',reason:'Explicit allocation required: '+input.reason},[{kind:'system.merge-question-merge',target:{kind:'system.merge',key:{},uid:input.mergeUid}},...links.map(member=>({kind:'system.merge-question-member',target:{kind:member.kind,key:{},uid:member.uid}}))],input.evidence);return {kind:'system.merge-question',uid};}
 for(const allocation of allocations){const member=links.find(member=>member.uid===allocation.memberUid)!;await save(tx,contract,'system.merge-allocation',newUid(),allocation.direction?{direction:allocation.direction}:{},[{kind:'system.merge-allocation-merge',target:{kind:'system.merge',key:{},uid:input.mergeUid}},{kind:'system.merge-allocation-assertion',target:{kind:'system.assertion',key:{},uid:allocation.assertionUid}},{kind:'system.merge-allocation-member',target:{kind:member.kind,key:{},uid:member.uid}}],input.evidence);}
 await save(tx,contract,'system.merge',input.mergeUid,{state:'UNDONE' ,reason:input.reason},[],input.evidence);
 await reconcileDisputes(tx,contract,links.flatMap(member=>contract.vertex.find(kind=>kind.name===member.kind)!.fields.map(field=>({sort:'vertex' as const,kind:member.kind,subjectId:Number(member.id),property:field.name}))));
 await refreshWriteSemantics(tx);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');return {kind:'system.merge',uid:input.mergeUid};
 });
}
