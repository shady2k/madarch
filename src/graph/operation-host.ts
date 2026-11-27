/** Immediate checked writes and graph receipts, decision 0039 item 24. */
import { assertOutcomeApplicability } from './applicability.js';
import {withFillStateIn,readRunGraphUidIn,readUnitGraphUidIn,type GraphWriteContext} from './fill-state.js';
import {startupBinding} from './manifest-publication.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history-types.js';
import { byCodePoint } from '../model/order.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { withSpan } from '../obs/trace.js';
import { assertionValueTableName, type GraphContract } from './contract.js';
import { loadAssertionsBatch } from './assertion-read.js';
import { acquireGraphWriteLock, bindWriteCapability, bootstrapWriteIdentity, canonicalJson, publishGraphDrafts, subjectUid, writeAssertion, writeAssertions, type WriteCapability, type WriteSubject } from './write.js';
import { newUid } from './uid.js';
import { reconcileDisputes } from './disputes.js';
import type { ClaimedJob, EnqueueRequest, QueueService } from '../fill/queue.js';

const WHERE = new URL(import.meta.url).pathname;

/** A fenced operation cannot write after its queue attempt loses authority. */
export class AttemptStaleError extends Error {}
/**
 * One precondition of an operation (0039 item 24): a subject's graph revision as a person's read answered it, named by
 * uid, or this source's stream position for a subject a plugin's reconcile named by identity. A subject precondition
 * with no sequence states that this source never asserted the subject.
 */
export type OperationPrecondition =
  | { readonly uid: string; readonly recordedSequence: string }
  | { readonly subject: WriteSubject; readonly recordedSequence?: string };
/** A read decided this operation from a sequence the graph no longer holds: the producer rereads and replans. */
class RevisionConflictError extends Error { readonly code = 'REVISION_CONFLICT'; }
export interface OperationRequest {
  readonly key: string;
  readonly request: unknown;
  readonly preconditions?: readonly OperationPrecondition[];
  readonly completion?: {readonly unitState?:'retry_wait'; readonly output:object; readonly enqueue:readonly EnqueueRequest[];readonly outcome?:import('../fill/producer-outcomes.js').ProducerOutcomeDraft};
}
export interface OperationReceiptRequest {
  readonly request: OperationRequest['request'];
  readonly preconditions: NonNullable<OperationRequest['preconditions']>;
  readonly completion: NonNullable<OperationRequest['completion']> | null;
}
export function canonicalOperationRequest(request: OperationRequest): string {
  const receipt: OperationReceiptRequest = { request: request.request, preconditions: request.preconditions ?? [], completion: request.completion ?? null };
  return canonicalJson({ ...receipt, completion: receipt.completion === null ? null : {
    ...receipt.completion,
    enqueue: receipt.completion.enqueue.map(({ startAfter, ...enqueue }) => ({ ...enqueue, ...(startAfter === undefined ? {} : { startAfter: startAfter.toISOString() }) })),
  } });
}
export interface OperationHostOptions {
  readonly owner:DatabaseOwner; readonly queue:QueueService; readonly job:ClaimedJob;
  readonly contract:GraphContract; readonly capability:WriteCapability;
  readonly runUid:string; readonly unitUid:string; readonly context?:number;
}
export interface OperationWriteContext extends GraphWriteContext { readonly binding:WriteCapability; }
export interface OperationHost {
  fail(reason:string,apply?:(tx:OuterTransaction,context:OperationWriteContext)=>Promise<void>):Promise<boolean>;
  execute<Result>(request:OperationRequest,apply:(tx:OuterTransaction,context:OperationWriteContext)=>Promise<Result>):Promise<Result>;
}

const systemPermissions = [
  ...['system.run','system.unit'].map(kind=>({kind,properties:Object.keys({committed_operations:true,last_progress:true,reason:true,outcome:true,produced_kind:true,producer:true,produced:true,producer_version:true,plan_scope:true,$exists:true}),assert:true,retractOwn:true})),
  ...['system.operation','system.operation-unit','system.operation-author','system.kind-applicability','system.applicability-kind','system.applicability-product'].map(kind=>({kind,properties:['*'],assert:true,retractOwn:true})),
];
function trusted(binding:WriteCapability,operationUid:string,unitUid:string):WriteCapability {
  return {...binding,operationUid,unitUid,permissions:[...binding.permissions,...systemPermissions]};
}
async function node(tx:OuterTransaction,uid:string):Promise<string> {
  return await withSpan('graph.operation.node', {}, async () => {
    const row=(await tx.query<{id:string}>('SELECT id::text AS id FROM node WHERE uid=$1::uuid',[uid])).rows[0];
    if(!row)throw new Error(`${WHERE}:38: TARGET_MISSING ${uid}`);
    return row.id;
  });
}
async function selectedFieldBatch(tx:OuterTransaction,requests:readonly {kind:string;id:string;properties:readonly string[]}[],context:number):Promise<Record<string,unknown>[]> {
  const batches=await loadAssertionsBatch(tx,requests.map(({kind,id,properties})=>({sort:'vertex' as const,kind,properties,subjectIds:[Number(id)]})),{currentStatement:true,contexts:[context],currentValues:true});
  return batches.map(rows=>Object.fromEntries(rows.filter(row=>row.selected).map(row=>[row.property,row.value])));
}
async function selectedFields(tx:OuterTransaction,kind:string,uid:string,properties:readonly string[],context:number):Promise<Record<string,unknown>> {
  return await withSpan('graph.operation.selected', {}, async () => (await selectedFieldBatch(tx,[{kind,id:await node(tx,uid),properties}],context))[0]!);
}
async function selected(tx:OuterTransaction,kind:string,uid:string,property:string,context:number):Promise<unknown> {
  return (await selectedFields(tx,kind,uid,[property],context))[property];
}
async function set(tx:OuterTransaction,contract:GraphContract,kind:string,uid:string,property:string,value:unknown,context:number):Promise<string> {
  return await writeAssertion(tx,contract,{sort:'vertex',kind,subjectId:await node(tx,uid),property,operation:'assert',value},context);
}
/** Only the handler calls this when admitting a run/unit, not a producer RPC. */
export async function initializeOperationScope(tx:OuterTransaction,contract:GraphContract,binding:WriteCapability,runUid:string,unitUid:string,context=1):Promise<void> {
  await withSpan('fill.operation.scope',{},async()=>{
    await acquireGraphWriteLock(tx);
    for(const [kind,uid] of [['system.operation',binding.operationUid],['system.run',runUid],['system.unit',unitUid]] as const) await bootstrapWriteIdentity(tx,kind,uid,binding.productUid,context);
    bindWriteCapability(tx,trusted(binding,binding.operationUid,unitUid));
    const identities=(await tx.query<{id:string;uid:string}>('SELECT id::text,uid::text FROM node WHERE uid=ANY($1::uuid[])',[[runUid,unitUid]])).rows;
    const ids=new Map(identities.map(row=>[row.uid,row.id]));
    await withFillStateIn(tx,contract,{operationUid:binding.operationUid,unitUid},async()=>{
      const runState=await selected(tx,'system.run',runUid,'state',context);
      await writeAssertions(tx,contract,[
        {sort:'vertex',kind:'system.run',subjectId:ids.get(runUid)!,property:'$exists',operation:'assert',value:true},
        {sort:'vertex',kind:'system.unit',subjectId:ids.get(unitUid)!,property:'$exists',operation:'assert',value:true},
        ...(runState===undefined?[{sort:'vertex' as const,kind:'system.run',subjectId:ids.get(runUid)!,property:'state',operation:'assert' as const,value:'running'}]:[]),
        {sort:'vertex',kind:'system.unit',subjectId:ids.get(unitUid)!,property:'state',operation:'assert',value:'running'},
      ],context);
    },context);
    await writeAssertions(tx,contract,[
      {sort:'vertex',kind:'system.unit',subjectId:ids.get(unitUid)!,property:'committed_operations',operation:'assert',value:0},
      {sort:'vertex',kind:'system.unit',subjectId:ids.get(unitUid)!,property:'last_progress',operation:'assert',value:'admitted'},
    ],context);
  });
}
/** Resolve persisted UUIDv7 run/unit graph identities. The legacy scheduler names are lookup properties, never identity keys. */
export async function resolveOperationScope(tx:OuterTransaction,contract:GraphContract,binding:WriteCapability,input:{runId:string;unitId:string;generation:number;scope?:string;parentUids?:readonly string[]},context=1):Promise<{runUid:string;unitUid:string}> {
  return await withSpan('graph.operation.scope.resolve', {}, async () => {
    await acquireGraphWriteLock(tx);
    const runKey=canonicalJson([binding.productUid,input.runId]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[runKey]);
    const oldRun=await readRunGraphUidIn(tx,input.runId),oldUnit=await readUnitGraphUidIn(tx,input.unitId,input.generation);
    const runUid=oldRun??newUid(),unitUid=oldUnit??newUid();
    if(!oldUnit){
      await initializeOperationScope(tx,contract,binding,runUid,unitUid,context);
      await withFillStateIn(tx,contract,{operationUid:binding.operationUid,unitUid},async()=>{
        const identities=(await tx.query<{id:string;uid:string}>('SELECT id::text,uid::text FROM node WHERE uid=ANY($1::uuid[])',[[runUid,unitUid]])).rows;
        const ids=new Map(identities.map(row=>[row.uid,row.id]));
        await writeAssertions(tx,contract,[
          {sort:'vertex',kind:'system.run',subjectId:ids.get(runUid)!,property:'run_name',operation:'assert',value:input.runId},
          ...Object.entries({unit_name:input.unitId,generation:input.generation,...(input.scope===undefined?{}:{scope:input.scope})}).map(([property,value])=>({sort:'vertex' as const,kind:'system.unit',subjectId:ids.get(unitUid)!,property,operation:'assert' as const,value})),
        ],context);
        await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edges:[{kind:'system.unit-run',from:{kind:'system.unit',uid:unitUid,key:{}},to:{kind:'system.run',uid:runUid,key:{}},producer:binding.sourceUid,producerVersion:binding.contractVersion??'system'}]},context);
        },context);
    }
    if((input.parentUids?.length??0)>0)await withFillStateIn(tx,contract,{operationUid:binding.operationUid,unitUid},async()=>{
      for(const parentUid of input.parentUids??[])await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edges:[{kind:'system.unit-parent',from:{kind:'system.unit',uid:unitUid,key:{}},to:{kind:'system.unit',uid:parentUid,key:{}},discriminator:unitUid,producer:binding.sourceUid,producerVersion:binding.contractVersion}]},context);
    },context);
    return {runUid,unitUid};
  });
}
/** State changes serialize with writes on the run row; accepted facts stay visible. */
export async function changeOperationRunState(tx:OuterTransaction,contract:GraphContract,binding:WriteCapability,runUid:string,state:'running'|'paused'|'cancelled',context=1):Promise<void> {
  await withSpan('fill.operation.run-state',{},async()=>{
    await acquireGraphWriteLock(tx);
    await tx.query('SELECT id FROM node WHERE uid=$1::uuid FOR UPDATE',[runUid]);
    await withFillStateIn(tx,contract,{operationUid:binding.operationUid,unitUid:binding.unitUid},async()=>{
      await set(tx,contract,'system.run',runUid,'state',state,context);
    },context);
  });
}
export async function setProductOperationRunState(owner:DatabaseOwner,contract:GraphContract,runId:string,state:'running'|'paused'|'cancelled',transaction?:OuterTransaction):Promise<void>{
  return await withSpan('graph.operation.run-state.product', {}, async () => {
   const apply=async(tx:OuterTransaction)=>{
    await acquireGraphWriteLock(tx);
    const rows=(await tx.query<{id:string;uid:string}>(`SELECT n.id::text,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.run' ORDER BY n.uid`)).rows;
    for(const row of rows){
     if(await selected(tx,'system.run',row.uid,'run_name',1)!==runId)continue;
     const {binding}=await startupBinding(tx,contract,'engine-control',[]);
     await changeOperationRunState(tx,contract,binding,row.uid,state);
    }
    if (!transaction) await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
   };
   if(transaction)await apply(transaction);else await owner.transaction('write',apply);
  });
}

export async function operationReceipt(tx:OuterTransaction,_contract:GraphContract,unitUid:string,key:string,context=1):Promise<{canonicalRequest:string;digest:string;result:string|undefined}|undefined>{
  return await withSpan('graph.operation.receipt', {}, async () => {
    const receipt=(await tx.query<{uid:string}>(`SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id JOIN edge e ON e.from_node=n.id JOIN entity ek ON ek.id=e.entity_id JOIN node u ON u.id=e.to_node WHERE k.name='system.operation' AND ek.name='system.operation-unit' AND u.uid=$1::uuid AND n.id IN (SELECT attachment_edge.to_node FROM assertion a JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id JOIN edge attachment_edge ON attachment_edge.id=attachment.subject_edge_id JOIN "${assertionValueTableName('system.operation','vertex','key')}" v ON v.assertion_id=a.assertion_id WHERE a.property='key' AND v.value=$2)`,[unitUid,key])).rows[0];
    if(!receipt)return undefined;
    const fields=await selectedFields(tx,'system.operation',receipt.uid,['canonical_request','digest','result'],context);
    return {canonicalRequest:fields.canonical_request as string,digest:fields.digest as string,result:fields.result as string|undefined};
  });
}

interface OperationPreflight {
  readonly runId:string|null; readonly unitId:string|null;
  readonly principalKind:string|null; readonly locked:readonly {id:string;uid:string}[];
}

/**
 * The last recorded sequence of a subject set (0039 item 24), named by subject uid: the whole subject stream a person's
 * read states, or — with a source — that source's own statements, which is what a plugin's reconcile was decided from. A
 * retraction is a statement of the stream, so a withdrawn subject has a sequence too; a subject with no statement has 0.
 */
async function subjectStreamRevisions(tx:OuterTransaction,uids:readonly string[],sourceUid?:string):Promise<Map<string,string>>{
 if(uids.length===0)return new Map();
 return await withSpan('graph.operation.subject-revisions',{},async()=>{
 const array=sourceUid===undefined?'$1':'$2';
 const subjectRows=`SELECT n.uid AS subject_uid,s.assertion_id FROM assertion_vertex_subject s JOIN edge attachment ON attachment.id=s.subject_edge_id JOIN node n ON n.id=attachment.to_node WHERE n.uid=ANY(${array}::uuid[])
    UNION ALL
    SELECT e.uid AS subject_uid,s.assertion_id FROM assertion_edge_subject s JOIN edge e ON e.id=s.edge_id WHERE e.uid=ANY(${array}::uuid[])`;
 const scoped=`JOIN edge source ON source.from_node=a.assertion_id
      JOIN entity source_kind ON source_kind.id=source.entity_id AND source_kind.name='system.assertion-source' AND source_kind.sort='edge'
      JOIN node source_node ON source_node.id=source.to_node
    WHERE source_node.uid::text=$1`;
 const rows=(await tx.query<{uid:string;revision:string}>(`WITH subject_rows AS (${subjectRows})
    SELECT subject_rows.subject_uid::text AS uid,${sourceUid===undefined?'coalesce(max(a.recorded_sequence),0)':'max(a.recorded_sequence)'}::text AS revision
    FROM subject_rows JOIN assertion a ON a.assertion_id=subject_rows.assertion_id
    ${sourceUid===undefined?'':scoped}
    GROUP BY subject_rows.subject_uid`,sourceUid===undefined?[uids]:[sourceUid,uids])).rows;
 return new Map(rows.map(row=>[row.uid,String(row.revision)]));
 });
}

/** The subjects the graph holds, locked in uid order (0039 item 24): a subject nothing holds yet has nothing to lock. */
async function heldSubjects(tx:OuterTransaction,uids:readonly string[]):Promise<{nodes:Set<string>;edges:Set<string>}>{
 return await withSpan('graph.operation.subject-locks',{},async()=>{
 const ordered=[...new Set(uids)].sort(byCodePoint);
 const nodes=new Set<string>(),edges=new Set<string>();
 if(ordered.length===0)return {nodes,edges};
 for(const row of (await tx.query<{uid:string}>('SELECT uid::text AS uid FROM node WHERE uid=ANY($1::uuid[]) ORDER BY uid::text COLLATE "C" FOR UPDATE',[ordered])).rows)nodes.add(row.uid);
 for(const row of (await tx.query<{uid:string}>('SELECT uid::text AS uid FROM edge WHERE uid=ANY($1::uuid[]) ORDER BY uid::text COLLATE "C" FOR UPDATE',[ordered])).rows)edges.add(row.uid);
 return {nodes,edges};
 });
}

/**
 * Refuse an operation whose read is stale (0039 item 24). A uid precondition names a subject's whole graph revision, as
 * a person's read states it; a subject precondition names this source's stream position for a subject a plugin's
 * reconcile addressed by identity, so another source's statement on the same subject never makes it stale.
 */
async function checkPreconditions(tx:OuterTransaction,options:OperationHostOptions,preconditions:readonly OperationPrecondition[],context:number):Promise<void>{
 if(preconditions.length===0)return;
 // Identity is derived from the authenticated capability, and the operation's own bind follows this check.
 bindWriteCapability(tx,options.capability);
 const stated=new Map<string,string>(),own=new Map<string,{subject:WriteSubject;expected:string|undefined}>();
 for(const condition of preconditions){
  if('uid' in condition){stated.set(condition.uid,condition.recordedSequence);continue;}
  const uid=await subjectUid(tx,options.contract,condition.subject,context);
  if(own.has(uid))throw new Error(`${WHERE}:92: MALFORMED_PRECONDITION repeated subject ${uid}`);
  own.set(uid,{subject:condition.subject,expected:condition.recordedSequence});
 }
 const held=await heldSubjects(tx,[...stated.keys(),...own.keys()]);
 if(stated.size>0){
  const revisions=await subjectStreamRevisions(tx,[...stated.keys()]);
  for(const [uid,expected] of stated){
   if(!held.nodes.has(uid)&&!held.edges.has(uid))throw new Error(`${WHERE}:92: TARGET_MISSING revision ${uid}`);
   if((revisions.get(uid)??'0')!==expected)throw new RevisionConflictError(`${WHERE}:92: REVISION_CONFLICT ${uid}`);
  }
 }
 if(own.size>0){
  const revisions=await subjectStreamRevisions(tx,[...own.keys()],options.capability.sourceUid);
  for(const [uid,{subject,expected}] of own){
   if((revisions.get(uid)??'0')!==(expected??'0'))throw new RevisionConflictError(`${WHERE}:92: REVISION_CONFLICT ${subject.kind} ${uid}`);
  }
 }
}
async function operationPreflight(tx:OuterTransaction,options:OperationHostOptions):Promise<OperationPreflight>{
  return await withSpan('graph.operation.preflight',{},async()=>{
  const uids=[...new Set([options.runUid,options.unitUid])].sort(byCodePoint);
  const row=(await tx.query<{run_id:string|null;unit_id:string|null;principal_kind:string|null;locked:{id:string;uid:string}[]}>(`WITH identities AS MATERIALIZED (
    SELECT n.id::text AS id,n.uid,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[])
  ), locked AS MATERIALIZED (
    SELECT n.id::text AS id,n.uid::text AS uid FROM node n WHERE n.uid=ANY($2::uuid[]) ORDER BY n.uid::text COLLATE "C" FOR UPDATE OF n
  ) SELECT (SELECT id FROM identities WHERE uid=$3::uuid) AS run_id,
    (SELECT id FROM identities WHERE uid=$4::uuid) AS unit_id,
    (SELECT kind FROM identities WHERE uid=$5::uuid) AS principal_kind,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'uid',uid)),'[]'::jsonb) FROM locked) AS locked`,[[...uids,options.capability.principalUid],uids,options.runUid,options.unitUid,options.capability.principalUid])).rows[0]!;
  return {runId:row.run_id,unitId:row.unit_id,principalKind:row.principal_kind,locked:row.locked};
  });
}

export function createOperationHost(options:OperationHostOptions):OperationHost {
  const context=options.context??1;
  return {fail:async(reason,apply)=>await withSpan('fill.operation.failure',{'madarch.unit':options.unitUid},async()=>await options.owner.transaction('write',async tx=>{
    await acquireGraphWriteLock(tx);
    if(!await options.queue.isActive(options.job,tx))return false;
    await tx.query('SELECT id FROM node WHERE uid=ANY($1::uuid[]) ORDER BY uid::text COLLATE "C" FOR UPDATE',[[options.runUid,options.unitUid].sort(byCodePoint)]);
    const operationUid=newUid();
    await bootstrapWriteIdentity(tx,'system.operation',operationUid,options.capability.productUid,context);
    bindWriteCapability(tx,trusted(options.capability,operationUid,options.unitUid));
    const principal=(await tx.query<{kind:string}>(`SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`,[options.capability.principalUid])).rows[0];
    if(!principal)throw new Error(`${WHERE}:120: TARGET_MISSING principal ${options.capability.principalUid}`);
    // The operation's own record and its two links enter as one admission, not a statement each.
    await publishGraphDrafts(tx,options.contract,{vertices:[{kind:'system.operation',uid:operationUid,key:{},values:{},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion}],removals:[],edges:[{kind:'system.operation-unit',from:{kind:'system.operation',uid:operationUid,key:{}},to:{kind:'system.unit',uid:options.unitUid,key:{}},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion},{kind:'system.operation-author',from:{kind:'system.operation',uid:operationUid,key:{}},to:{kind:principal.kind,uid:options.capability.principalUid,key:{}},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion}]},context);
    if(apply){await apply(tx,{contract:options.contract,operationUid,unitUid:options.unitUid,binding:trusted(options.capability,operationUid,options.unitUid)});bindWriteCapability(tx,trusted(options.capability,operationUid,options.unitUid));}
    else {
      await withFillStateIn(tx,options.contract,{operationUid,unitUid:options.unitUid},async()=>{
        await set(tx,options.contract,'system.unit',options.unitUid,'state','failed',context);
      },context);
    }
    await set(tx,options.contract,'system.unit',options.unitUid,'reason',reason,context);
    const fields = await selectedFields(tx,'system.unit',options.unitUid,['produced_kind','producer','plan_scope','scope'],context);
    const producedKind = fields.produced_kind;
    const producer = fields.producer;
    if (typeof producedKind === 'string' && typeof producer === 'string') {
      const evidenceUid = await set(tx,options.contract,'system.unit',options.unitUid,'outcome','failed',context);
      await assertOutcomeApplicability(tx,options.contract,{kind:producedKind,plugin:producer,outcome:'failed',produced:0,reason},evidenceUid,String(fields.plan_scope ?? fields.scope ?? options.unitUid));
    }
    await set(tx,options.contract,'system.unit',options.unitUid,'last_progress',reason,context);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    if(!await options.queue.fence(options.job,tx))throw new AttemptStaleError(`${WHERE}:169: ATTEMPT_STALE failure`);
    await options.queue.fail(options.job.queue,options.job,reason,tx);
    return true;
  })),execute:async<Result>(request:OperationRequest,apply:(tx:OuterTransaction,context:OperationWriteContext)=>Promise<Result>):Promise<Result>=> {
    return await withSpan('fill.operation',{'madarch.unit':options.unitUid,'madarch.attempt':options.job.attempt},async()=> {
      const canonical=canonicalOperationRequest(request);
      const digest=canonicalJsonDigest({canonical});
      return await options.owner.transaction('write',async tx=>{
    await acquireGraphWriteLock(tx);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson([options.unitUid,request.key])]);
        const receipt=await operationReceipt(tx,options.contract,options.unitUid,request.key,context);
        if(receipt){
          if(receipt.canonicalRequest!==canonical||receipt.digest!==digest)throw new Error(`${WHERE}:81: IDEMPOTENCY_CONFLICT ${request.key}`);
          if(request.completion&&await options.queue.fence(options.job,tx)){
            if(!await options.queue.complete(options.job.queue,options.job,request.completion.output,tx))throw new AttemptStaleError(`${WHERE}:81: ATTEMPT_STALE completion`);
          }
          return (receipt.result === undefined ? undefined : JSON.parse(receipt.result)) as Result;
        }
        if(!await options.queue.isActive(options.job,tx))throw new AttemptStaleError(`${WHERE}:84: ATTEMPT_STALE`);
        const preflight=await operationPreflight(tx,options);
        // The states this operation may write are read as one batch, and only they: the counter it raises and the
        // scope an outcome is cited from are read after `apply`, which may state both itself (madarch-64o5.176).
        const fields=await selectedFieldBatch(tx,[{kind:'system.run',id:preflight.runId??'0',properties:['state']},{kind:'system.unit',id:preflight.unitId??'0',properties:['state']}],context);
        const uids=[...new Set([options.runUid,options.unitUid])].sort(byCodePoint);
        const runState=fields[0]!.state,unitState=fields[1]!.state;
        if(preflight.locked.length!==uids.length || runState!=='running' || unitState!=='running')throw new Error(`${WHERE}:87: RUN_NOT_WRITABLE run ${String(runState)} unit ${String(unitState)}`);
        await checkPreconditions(tx,options,request.preconditions??[],context);
        const operationUid=newUid();
        await bootstrapWriteIdentity(tx,'system.operation',operationUid,options.capability.productUid,context);
        bindWriteCapability(tx,trusted(options.capability,operationUid,options.unitUid));
        const principal=preflight.principalKind===null?undefined:{kind:preflight.principalKind};
        if(!principal)throw new Error(`${WHERE}:116: TARGET_MISSING principal ${options.capability.principalUid}`);
        // The operation and its two links are stated before anything writes under it: a producer inside `apply`
        // may name this operation (a mention of the operation it writes under) and the validator reads that
        // target as active then, not only after the receipt arrives. One admission carries the three.
        await publishGraphDrafts(tx,options.contract,{vertices:[
          {kind:'system.operation',uid:operationUid,key:{},values:{},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion??'system'},
        ],removals:[],edges:[{kind:'system.operation-unit',from:{kind:'system.operation',uid:operationUid,key:{}},to:{kind:'system.unit',uid:options.unitUid,key:{}},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion??'system'},{kind:'system.operation-author',from:{kind:'system.operation',uid:operationUid,key:{}},to:{kind:principal.kind,uid:options.capability.principalUid,key:{}},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion??'system'}]},context);
        const result=await apply(tx,{contract:options.contract,operationUid,unitUid:options.unitUid,binding:trusted(options.capability,operationUid,options.unitUid)});
        bindWriteCapability(tx,trusted(options.capability,operationUid,options.unitUid));
        const canonicalResult = result === undefined ? undefined : canonicalJson(result);
        // What `apply` stated is what the receipt completes: the raised counter and the scope an outcome is cited
        // from are read now, both in one batch, so a producer's own write of either is accounted for.
        const measured=(await selectedFieldBatch(tx,[{kind:'system.unit',id:preflight.unitId!,properties:['committed_operations','plan_scope','scope']}],context))[0]!;
        const count=Number(measured.committed_operations??0);
        const outcome=request.completion?.outcome;
        await publishGraphDrafts(tx,options.contract,{vertices:[
          {kind:'system.operation',uid:operationUid,key:{},values:{key:request.key,canonical_request:canonical,digest,...(canonicalResult === undefined ? {} : {result:canonicalResult})},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion??'system'},
          {kind:'system.unit',uid:options.unitUid,key:{},values:{committed_operations:count+1,last_progress:request.key},producer:options.capability.sourceUid,producerVersion:options.capability.contractVersion??'system'},
        ],removals:[]},context);
        await reconcileDisputes(tx,options.contract);
        if(request.completion){
          await withFillStateIn(tx,options.contract,{operationUid,unitUid:options.unitUid},async()=>{
            await set(tx,options.contract,'system.unit',options.unitUid,'state',request.completion!.unitState??'published',context);
          },context);
          if(outcome) {
            // What the attempt made of the unit is one admission of its own: every field it states enters together,
            // and the outcome's assertion is the evidence the applicability mark cites.
            const values = {produced_kind:outcome.kind,producer:outcome.plugin,outcome:outcome.outcome,produced:outcome.produced,...(outcome.reason===undefined?{}:{reason:outcome.reason}),...(outcome.producerVersion===undefined?{}:{producer_version:outcome.producerVersion})};
            const inputs = Object.entries(values).map(([property,value]) => ({sort:'vertex' as const,kind:'system.unit',subjectId:preflight.unitId!,property,operation:'assert' as const,value}));
            const assertionUids = await writeAssertions(tx,options.contract,inputs,context);
            await assertOutcomeApplicability(tx,options.contract,outcome,Object.fromEntries(inputs.map((input,index)=>[input.property,assertionUids[index]])).outcome!,String(measured.plan_scope ?? measured.scope ?? options.unitUid));
          }
        }
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        // All graph writes remain provisional until authority is locked through commit.
        if(!await options.queue.fence(options.job,tx))throw new AttemptStaleError(`${WHERE}:106: ATTEMPT_STALE publication`);
        if(request.completion){
          if(!await options.queue.complete(options.job.queue,options.job,request.completion.output,tx))throw new AttemptStaleError(`${WHERE}:106: ATTEMPT_STALE completion`);
          for(const enqueue of request.completion.enqueue)await options.queue.enqueue({...enqueue,transaction:tx});
        }
        return result;
      });
    });
  }};
}

/** Serialize queue-start metadata with graph writes under the same active attempt. */
export async function fencedAttemptStart<Result>(queue:QueueService,job:ClaimedJob,tx:OuterTransaction,apply:()=>Promise<Result>):Promise<Result>{
 await acquireGraphWriteLock(tx);
 if(!await queue.fence(job,tx))throw new AttemptStaleError(`${WHERE}:190: ATTEMPT_STALE start`);
 return await apply();
}
