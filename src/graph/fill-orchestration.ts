/** Typed orchestration records in the one graph. */
import type { SqlExecutor } from '../sql-driver.js';
import type { OuterTransaction } from '../history-types.js';
import type { FillRun } from '../product/fill-runtime.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { raise, here, withLocation } from '../fill/fsm-core.js';
import { withSpan } from '../obs/trace.js';
import { FACT_RANK_FIELDS } from '../fill/facts.js';
import { readRunGraphUidIn, readUnitGraphUidIn, type FillStateDatabase, type FillStateSnapshotDatabase } from './fill-state.js';
import { readKindAssertions as readSelectedKindAssertions, type AssertionRecord } from './records.js';
import { EMPTY_CONTRACT, type GraphContract } from './contract.js';
import { startupBinding } from './manifest-publication.js';
import { withAssertionContract } from './system-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { publishGraphDrafts, acquireGraphWriteLock, bindWriteCapability, type WriteCapability } from './write.js';
import { newUid } from './uid.js';
const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
const transactionBindings=new WeakMap<SqlExecutor,{contract:GraphContract;binding:WriteCapability}>();
async function orchestrationBinding(tx:SqlExecutor):Promise<{contract:GraphContract;binding:WriteCapability}>{
 let held=transactionBindings.get(tx);
 if(!held){held=await startupBinding(tx,contract,'fill-orchestration');transactionBindings.set(tx,held);}
 bindWriteCapability(tx,held.binding);
 return held;
}
export type OrchestratorDatabase = FillStateDatabase;
async function transaction<R>(database:OrchestratorDatabase,kind:'write',work:(tx:OuterTransaction)=>Promise<R>):Promise<R>{
 const site=here();
 return withSpan('graph.orchestration.transaction',{'orchestration.kind':kind},()=>withLocation(site,'orchestration metadata',['node','edge','assertion'],()=>database.transaction(kind,async tx=>{
  if(kind==='write'){
   await acquireGraphWriteLock(tx);
  }
  const result=await work(tx);
  if(kind==='write'){
   await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  }
  return result;
 })));
}
async function snapshotTransaction<R>(database:FillStateSnapshotDatabase,work:(tx:OuterTransaction)=>Promise<R>):Promise<R>{
 const site=here();
 return withSpan('graph.orchestration.snapshot',{},()=>withLocation(site,'orchestration metadata',['node','edge','assertion'],()=>database.transaction('snapshot',work)));
}
export function writeOrchestration<R>(database:OrchestratorDatabase,work:(tx:OuterTransaction)=>Promise<R>):Promise<R>{
 return transaction(database,'write',work);
}
export async function createOrchestratorSchema(database: FillStateSnapshotDatabase): Promise<void> {
  return await withSpan('graph.orchestration.schema', {}, async () => {
    await snapshotTransaction(database, async tx => { await tx.query('SELECT 1 FROM assertion LIMIT 0'); });
  });
}
function membershipValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return { absent: true };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { invalid: 'date' } : value.toISOString();
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map((entry, index) => membershipValue(entry, `${path}[${index}]`));
  if (typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields).sort(byCodePoint)) {
      if (RANK_FIELD_NAMES.has(key)) continue;
      out[key] = membershipValue(fields[key], `${path}.${key}`);
    }
    return out;
  }
  raise(`a read answered ${typeof value} at ${path}, which no membership digest can hold: a query answers rows of plain values, and a value two digests cannot tell apart would hide a read that moved`);
}

/**
 * The fields a fact's own value holds as one measurement of the whole graph
 * rather than as an observation of the node (`FACT_RANK_FIELDS`, madarch-tzte.21.7):
 * the rank stage 5's PageRank measures over a repository. A read that answered
 * one of them is not stale because the measurement moved — the read was about the
 * node, not about the number a later run gave it — so the membership digest
 * leaves these names out, and a re-ranking makes no unit that read a file or a
 * symbol out of date. Only a rank is left out: a module's `members` moves when
 * the tree moves, which is what a read of that module is about. The names come
 * from the schema, so the kinds that declare a rank are the one place that says
 * which names are ranks; the digest sees plain rows and not facts, so it reads
 * the name.
 */
const RANK_FIELD_NAMES: ReadonlySet<string> = new Set(Object.values(FACT_RANK_FIELDS).flatMap((fields) => [...(fields ?? [])]));

/**
 * The digest of one read's answer: the membership of the rows it answered, in a
 * canonical order of its own, so a row added, removed or changed moves it and a
 * graph that answers the same rows in another order does not. An empty answer is
 * the empty list, which is a value of its own — "nothing here yet" is a statement
 * a later read can turn false, and decision 0027 rechecks it like any other.
 */
export function readMembership(rows: readonly unknown[]): string {
  // Each row is serialized into its digest once and the digests decide the order (madarch-tzte.21.11):
  // a read of a whole repository answers tens of thousands of rows, and a comparator that serialized its
  // two sides again on every comparison did it O(n log n) times — gigabytes of transient strings for the
  // modules stage's read of 28 392 symbols — where one pass is a digest per row. The order is the same
  // one the comparator gave (equal digests are equal rows, and a stable sort keeps their order), so a
  // membership recorded before this change still equals the one this computes.
  const members = rows.map((row) => membershipValue(row, 'row'));
  const ordered = members
    .map((row) => ({ row, digest: canonicalJsonDigest(row) }))
    .sort((left, right) => byCodePoint(left.digest, right.digest));
  return canonicalJsonDigest(ordered.map((entry) => entry.row));
}

export interface TrackedRead {
  readonly unitId: string;
  readonly generation: number;
  /** The query's own digest, the row's key: a query is remembered once per generation, whatever it says. */
  readonly queryDigest: string;
  readonly query: string;
  /** The digest of the rows the read answered, empty answers included. */
  readonly membership: string;
  /** How many rows the read answered. */
  readonly members: number;
  readonly seq: number;
  readonly at: number;
}

export interface SealedChild {
  readonly unitId: string;
  readonly generation: number;
  readonly sealedAt: number;
}

export interface PublicationRecord {
  readonly unitId: string;
  readonly generation: number;
  readonly digest: string;
  /** How many facts the generation wrote through the graph operation host. */
  readonly facts: number;
  readonly publishedAt: number;
}

export interface FillEnd {
  readonly runId: string;
  readonly state: string;
  readonly message?: string;
  readonly unread?: readonly { readonly repository: string; readonly path: string; readonly reason: string }[];
}

export interface RunConfigurationRecord {
  readonly runId: string;
  /** The digest `snapshotStageConfigurations` answers for the resolved stages: what the run planned with. */
  readonly digest: string;
  readonly snapshot: RunSnapshot;
  readonly recordedAt: number;
}

export interface RunStageRecord {
  readonly runId: string;
  readonly stageId: string;
  /** When the stage's latest planning attempt stood. */
  readonly plannedAt: number;
  /** How many units the stage's latest attempt named. */
  readonly units: number;
  /**
   * How many publications the run had made when the attempt stood: the
   * watermark a re-planning reads the run's publications against
   * (madarch-tzte.26.3).
   */
  readonly publications: number;
}

export interface RunPublicationStage {
  readonly stageId: string;
  readonly publications: number;
}

export interface UnitPlanRecord {
  readonly unitId: string;
  readonly generation: number;
  readonly runId: string;
  /** The stage the unit belongs to, as the registry names it. */
  readonly stageId: string;
  /** The unit's own id in that stage's plan: the stage's vocabulary, never the store's namespaced id. */
  readonly stageUnitId: string;
  /** What the unit covers, in the graph's own terms, as the plan named it. */
  readonly scope: string;
  /** Where the stage stands in the run's derived order; a lower number plans earlier. */
  readonly stagePosition: number;
  /** Where the stage's own plan named this unit, most important first (the PageRank-like importance). */
  readonly planPosition: number;
  readonly plannedAt: number;
  /**
   * The versions the unit's cache key held when it was planned: the stage's `id@version` and its own prompt,
   * answer-schema and model versions (`stageCacheVersions`). Absent for a plan row a build before this recorded
   * none, which a run reports as an unknown version rather than as an unchanged one.
   */
  readonly cacheVersions?: Readonly<Record<string, string>>;
}

export interface UnitPlanOptions {
  readonly unitId: string;
  readonly generation: number;
  readonly runId: string;
  readonly stageId: string;
  readonly stageUnitId: string;
  readonly scope: string;
  readonly stagePosition: number;
  readonly planPosition: number;
  readonly at: number;
  /** The versions the unit's cache key holds at this planning (`stageCacheVersions`), recorded with the plan. */
  readonly cacheVersions?: Readonly<Record<string, string>>;
  /** The planning owner's lease token; a planning write refuses when it is no longer in force. */
  readonly ownerToken?: string;
  readonly ownerAt?: number;
}

export interface FillProgressEvent {
  readonly runId: string;
  /** The event's own sequence within its run, from 1: a reader follows a run by it. */
  readonly seq: number;
  readonly at: number;
  /** The registry's stage id, or `''` for an event about the run itself. */
  readonly stage: string;
  /** The unit the event is about, or `''` for an event about the run or a stage. */
  readonly unitId: string;
  readonly generation: number | null;
  readonly kind: ProgressKind;
  readonly summary: string;
}
export type RunSnapshot = FillRun["productSnapshot"];
const PROGRESS_KINDS = [
  'run-planned', 'run-started', 'run-blocked', 'run-paused', 'run-resumed', 'run-cancelling', 'run-cancelled',
  'run-completed', 'run-completed-partial', 'run-failed', 'run-replanned', 'run-refused',
  'stage-found-nothing', 'stage-planned', 'kind-abstained',
  'unit-planned', 'unit-admitted', 'unit-leased', 'unit-started', 'unit-read', 'unit-progress', 'unit-drafted', 'unit-validating',
  'unit-published', 'unit-split', 'unit-joined', 'unit-blocked', 'unit-unblocked', 'unit-retried', 'unit-failed',
  'unit-stale', 'unit-inherited', 'unit-cancelled', 'unit-skipped', 'unit-requeued', 'unit-refused', 'run-waiting',
] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];


export const queryDigest = (query: string): string => canonicalJsonDigest({ query });

async function readKindAssertions(tx:SqlExecutor,sort:'vertex'|'edge',kind:string,properties:readonly string[],subjectUids?:readonly string[],subjectIds?:readonly number[]):Promise<AssertionRecord[]>{
  return await withSpan('graph.orchestration.records', {}, async () => {
   const clock=(await tx.query<{now:string|Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const now=new Date(clock).toISOString();
   return readSelectedKindAssertions(tx,sort,kind,properties,{validAt:now,recordedAt:now,...(subjectUids===undefined?{}:{subjectUids}),...(subjectIds===undefined?{}:{subjectIds})});
  });
}
const fields: Record<string, readonly string[]> = {
 'system.tracked-read':['query_digest','query','membership','members','seq','at'],
 'system.run-stage':['stage_name','planned_at','units','publications'],
 'system.progress':['seq','at','stage','unit_name','generation','kind','summary'],
 'system.run-target':['role','name','position'],
 'system.unit-cache-version':['name','version'],
 'system.unread':['repository','path','reason'],
 'system.operation':['key','digest','result'],
};
const runFields=['run_name','configuration_digest','configuration_recorded_at','repository','default_branch','commit','registry_hash','target_vertex','target_plugins_only','targets_present','end_state','end_message','end_recorded','control_action','control_at'];
const unitFields=['unit_name','generation','stage_name','plan_stage_name','plan_stage_unit_name','plan_scope','plan_stage_position','plan_position','planned_at','state','outcome','produced','updated_at','published_at'];
async function read(tx:SqlExecutor,kind:string,uid:string):Promise<AssertionRecord|undefined>{
 return (await readKindAssertions(tx,'vertex',kind,kind==='system.run'?runFields:kind==='system.unit'?unitFields:fields[kind]??[],[uid]))[0];
}
async function requiredRun(tx:SqlExecutor,id:string):Promise<string>{
 const uid=await readRunGraphUidIn(tx,id); if(!uid)throw new Error(`${import.meta.path}: required run ${id} is missing`); return uid;
}
async function requiredUnit(tx:SqlExecutor,id:string,generation:number):Promise<string>{
 const uid=await readUnitGraphUidIn(tx,id,generation); if(!uid)throw new Error(`${import.meta.path}: required unit ${id}/${generation} is missing`); return uid;
}
async function write(tx:SqlExecutor,kind:string,uid:string,values:Record<string,unknown>):Promise<void>{
 const {contract,binding}=await orchestrationBinding(tx);
 await publishGraphDrafts(tx,contract,{vertices:[{kind,uid,key:{},values,producer:binding.sourceUid,producerVersion:binding.contractVersion}],removals:[]});
}
async function related(tx:SqlExecutor,kind:string,relation:string,target:string):Promise<AssertionRecord[]>{
  return await withSpan('graph.orchestration.related', {}, async () => {
   const candidates=(await tx.query<{id:number}>(`SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node target ON target.id=e.to_node WHERE k.name=$1 AND target.uid=$2::uuid ORDER BY e.id`,[relation,target])).rows.map(row=>Number(row.id));
   const edges=await readKindAssertions(tx,'edge',relation,[],undefined,candidates);
   const subjects=[...new Set(edges.map(edge=>edge.from!))];
   return readKindAssertions(tx,'vertex',kind,fields[kind]??[],undefined,subjects);
  });
}
async function child(tx:SqlExecutor,kind:string,relation:string,targetKind:string,target:string,values:Record<string,unknown>,uid=newUid()):Promise<string>{
 const {contract,binding}=await orchestrationBinding(tx);
 await publishGraphDrafts(tx,contract,{vertices:[{kind,uid,key:{},values,producer:binding.sourceUid,producerVersion:binding.contractVersion}],removals:[],edges:[{kind:relation,from:{kind,uid,key:{}},to:{kind:targetKind,uid:target,key:{}},producer:binding.sourceUid,producerVersion:binding.contractVersion}]}); return uid;
}
async function locked(tx:SqlExecutor):Promise<void>{await acquireGraphWriteLock(tx);}

async function recordUnitReadBatchIn(tx:SqlExecutor,reads:readonly Parameters<typeof recordUnitReadIn>[1][]):Promise<readonly TrackedRead[]>{
 if(!reads.length)return [];
 await locked(tx);
 const first=reads[0]!,uid=await requiredUnit(tx,first.unitId,first.generation);
 const rows=await related(tx,'system.tracked-read','system.tracked-read-unit',uid);
 let seq=Math.max(0,...rows.map(row=>Number(row.values.seq)));
 const identities=new Map(rows.map(row=>[String(row.values.query_digest),row.uid]));
 const out:TrackedRead[]=[];
 for(const options of reads){
  const digest=queryDigest(options.query),membership=options.membership??readMembership(options.rows);
  const selectedSeq=++seq;
  const retained=await child(tx,'system.tracked-read','system.tracked-read-unit','system.unit',uid,{query_digest:digest,query:options.query,membership,members:options.rows.length,seq:selectedSeq,at:options.at},identities.get(digest));
  identities.set(digest,retained);
  out.push({unitId:options.unitId,generation:options.generation,queryDigest:digest,query:options.query,membership,members:options.rows.length,seq:selectedSeq,at:options.at});
 }
 return out;
}
export async function recordUnitReadIn(tx:SqlExecutor,options:{readonly unitId:string;readonly generation:number;readonly query:string;readonly rows:readonly unknown[];readonly at:number;readonly membership?:string}):Promise<TrackedRead>{
 return (await recordUnitReadBatchIn(tx,[options]))[0]!;
}
export async function recordUnitReads(database:OrchestratorDatabase,reads:readonly Parameters<typeof recordUnitReadIn>[1][]):Promise<readonly TrackedRead[]>{
 if(!reads.length)return [];const first=reads[0]!;
 if(reads.some(row=>row.unitId!==first.unitId||row.generation!==first.generation))throw new Error(`${import.meta.path}: recordUnitReads requires one unit generation`);
 return transaction(database,'write',tx=>recordUnitReadBatchIn(tx,reads));
}
export async function readUnitReads(database:FillStateSnapshotDatabase,unitId:string,generation:number):Promise<readonly TrackedRead[]>{return snapshotTransaction(database,async tx=>{
 const uid=await readUnitGraphUidIn(tx,unitId,generation);if(!uid)return [];
 return (await related(tx,'system.tracked-read','system.tracked-read-unit',uid)).map(({values:v})=>({unitId,generation,queryDigest:String(v.query_digest),query:String(v.query),membership:String(v.membership),members:Number(v.members),seq:Number(v.seq),at:Number(v.at)})).sort((a,b)=>a.seq-b.seq);
});}
export async function sealSplitIn(tx:SqlExecutor,options:{readonly parentUnitId:string;readonly parentGeneration:number;readonly children:readonly {readonly unitId:string;readonly generation:number}[];readonly at:number}):Promise<readonly SealedChild[]>{
 await locked(tx);const parent=await requiredUnit(tx,options.parentUnitId,options.parentGeneration);
 const {contract,binding}=await orchestrationBinding(tx);
 for(const item of options.children){const uid=await requiredUnit(tx,item.unitId,item.generation);
 await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edges:[{kind:'system.unit-parent',from:{kind:'system.unit',uid,key:{}},to:{kind:'system.unit',uid:parent,key:{}},discriminator:uid,values:{sealed_at:options.at},producer:binding.sourceUid,producerVersion:binding.contractVersion}]});}
 return options.children.map(item=>({...item,sealedAt:options.at}));
}
async function splits(tx:SqlExecutor,unitId:string,generation:number,parents:boolean):Promise<readonly SealedChild[]>{
 const uid=await readUnitGraphUidIn(tx,unitId,generation);if(!uid)return [];
 const own=await read(tx,'system.unit',uid);if(!own)return [];
 const edges=await readKindAssertions(tx,'edge','system.unit-parent',['sealed_at']);
 const units=await readKindAssertions(tx,'vertex','system.unit',['unit_name','generation']);
 return edges.filter(edge=>(parents?edge.from:edge.to)===own.id&&edge.values.sealed_at!==undefined).map(edge=>{const unit=units.find(row=>row.id===(parents?edge.to:edge.from));if(!unit)throw new Error(`${import.meta.path}: split endpoint missing`);return {unitId:String(unit.values.unit_name),generation:Number(unit.values.generation),sealedAt:Number(edge.values.sealed_at)};}).sort((a,b)=>byCodePoint(a.unitId,b.unitId));
}
export async function readSealedChildren(database:FillStateSnapshotDatabase,id:string,generation:number):Promise<readonly SealedChild[]>{return snapshotTransaction(database,tx=>splits(tx,id,generation,false));}
export async function readSplitParents(database:FillStateSnapshotDatabase,id:string,generation:number):Promise<readonly SealedChild[]>{return snapshotTransaction(database,tx=>splits(tx,id,generation,true));}
export async function readPublicationIn(tx:SqlExecutor,unitId:string,generation:number):Promise<PublicationRecord|null>{
 const uid=await readUnitGraphUidIn(tx,unitId,generation);if(!uid)return null;
 const unit=await read(tx,'system.unit',uid);if(!unit||unit.values.state!=='published')return null;
 const operations=await related(tx,'system.operation','system.operation-unit',uid);
 const terminal=operations.find(row=>row.values.key==='complete');if(!terminal)return null;
 return {unitId,generation,digest:String(terminal.values.digest),facts:Number(unit.values.produced??0),publishedAt:Number(unit.values.published_at??unit.values.updated_at??0)};
}
export async function writeFillEnd(database:OrchestratorDatabase,end:FillEnd):Promise<void>{await transaction(database,'write',async tx=>{
 await locked(tx);const uid=await requiredRun(tx,end.runId);await write(tx,'system.run',uid,{end_recorded:true,end_state:end.state,end_message:end.message??''});
 const previous=await related(tx,'system.unread','system.unread-run',uid),{contract,binding}=await orchestrationBinding(tx);
 await publishGraphDrafts(tx,contract,{vertices:[],removals:previous.map(row=>({kind:'system.unread',uid:row.uid,key:{},producer:binding.sourceUid}))});
 for(const row of end.unread??[])await child(tx,'system.unread','system.unread-run','system.run',uid,{repository:row.repository,path:row.path,reason:row.reason});
});}
export async function readFillEnd(database:FillStateSnapshotDatabase,runId:string):Promise<FillEnd|null>{return snapshotTransaction(database,async tx=>{
 const uid=await readRunGraphUidIn(tx,runId);if(!uid)return null;const run=await read(tx,'system.run',uid);if(!run?.values.end_recorded)return null;
 const unread=(await related(tx,'system.unread','system.unread-run',uid)).map(row=>({repository:String(row.values.repository),path:String(row.values.path),reason:String(row.values.reason)}));
 return {runId,state:String(run.values.end_state),...(run.values.end_message?{message:String(run.values.end_message)}:{}),...(unread.length?{unread}:{})};
});}
export async function askRunControl(database:OrchestratorDatabase,request:{readonly runId:string;readonly action:'pause'|'stop';readonly at:number}):Promise<void>{await transaction(database,'write',async tx=>{await locked(tx);await write(tx,'system.run',await requiredRun(tx,request.runId),{control_action:request.action,control_at:request.at});});}
export async function readRunControl(database:OrchestratorDatabase,runId:string):Promise<'pause'|'stop'|null>{return transaction(database,'write',async tx=>{
 await locked(tx);const uid=await readRunGraphUidIn(tx,runId);if(!uid)return null;const row=await read(tx,'system.run',uid),action=row?.values.control_action;
 if(action!=='pause'&&action!=='stop')return null;await write(tx,'system.run',uid,{control_action:''});return action;
});}

async function configurationIn(tx:SqlExecutor,runId:string):Promise<RunConfigurationRecord|null>{
 const uid=await readRunGraphUidIn(tx,runId);if(!uid)return null;const run=await read(tx,'system.run',uid),v=run?.values;if(!v||v.configuration_digest===undefined)return null;
 const targets=await related(tx,'system.run-target','system.run-target-run',uid);
 const names=(role:string)=>targets.filter(row=>row.values.role===role).sort((a,b)=>Number(a.values.position)-Number(b.values.position)).map(row=>String(row.values.name));
 return {runId,digest:String(v.configuration_digest),recordedAt:Number(v.configuration_recorded_at),snapshot:{repository:String(v.repository),defaultBranch:String(v.default_branch),commit:String(v.commit),registryHash:String(v.registry_hash),...(v.targets_present?{targets:{kinds:names('kind'),...(v.target_vertex?{vertex:String(v.target_vertex)}:{}),...(targets.some(row=>row.values.role==='requested')?{requested:names('requested')}:{}),...(v.target_plugins_only===undefined?{}:{pluginsOnly:Boolean(v.target_plugins_only)})}}:{})}};
}
export async function recordRunConfiguration(database:OrchestratorDatabase,options:{readonly runId:string;readonly digest:string;readonly snapshot:RunSnapshot;readonly at:number;readonly ownerToken?:string;readonly ownerAt?:number}):Promise<RunConfigurationRecord>{return transaction(database,'write',async tx=>{
 await locked(tx);const existing=await configurationIn(tx,options.runId);if(existing)return existing;
 const uid=await requiredRun(tx,options.runId),s=options.snapshot;
 await write(tx,'system.run',uid,{configuration_digest:options.digest,configuration_recorded_at:options.at,repository:s.repository,default_branch:s.defaultBranch,commit:s.commit,registry_hash:s.registryHash,targets_present:s.targets!==undefined,...(s.targets?{target_vertex:s.targets.vertex??'',...(s.targets.pluginsOnly===undefined?{}:{target_plugins_only:s.targets.pluginsOnly})}:{})});
 for(const [role,names] of [['kind',s.targets?.kinds??[]],['requested',s.targets?.requested??[]]] as const)for(const [position,name] of names.entries())await child(tx,'system.run-target','system.run-target-run','system.run',uid,{role,name,position});
 return {runId:options.runId,digest:options.digest,snapshot:s,recordedAt:options.at};
});}
export async function readRunConfiguration(database:FillStateSnapshotDatabase,runId:string):Promise<RunConfigurationRecord|null>{return snapshotTransaction(database,tx=>configurationIn(tx,runId));}
export async function recordRunStagePlanned(database:OrchestratorDatabase,options:{readonly runId:string;readonly stageId:string;readonly units:number;readonly publications:number;readonly at:number;readonly ownerToken?:string;readonly ownerAt?:number}):Promise<RunStageRecord>{return transaction(database,'write',async tx=>{
 await locked(tx);const uid=await requiredRun(tx,options.runId),rows=await related(tx,'system.run-stage','system.run-stage-run',uid);
 await child(tx,'system.run-stage','system.run-stage-run','system.run',uid,{stage_name:options.stageId,planned_at:options.at,units:options.units,publications:options.publications},rows.find(row=>row.values.stage_name===options.stageId)?.uid);
 return {runId:options.runId,stageId:options.stageId,plannedAt:options.at,units:options.units,publications:options.publications};
});}
export async function readRunStagePlans(database:FillStateSnapshotDatabase,runId:string):Promise<readonly RunStageRecord[]>{return snapshotTransaction(database,async tx=>{
 const uid=await readRunGraphUidIn(tx,runId);if(!uid)return [];
 return (await related(tx,'system.run-stage','system.run-stage-run',uid)).map(row=>({runId,stageId:String(row.values.stage_name),plannedAt:Number(row.values.planned_at),units:Number(row.values.units),publications:Number(row.values.publications)})).sort((a,b)=>byCodePoint(a.stageId,b.stageId));
});}
async function runUnits(tx:SqlExecutor,runId:string):Promise<AssertionRecord[]>{
 const uid=await readRunGraphUidIn(tx,runId);if(!uid)return [];
 const edges=await readKindAssertions(tx,'edge','system.unit-run',[]),run=await read(tx,'system.run',uid);if(!run)return [];
 const ids=new Set(edges.filter(edge=>edge.to===run.id).map(edge=>edge.from));
 return (await readKindAssertions(tx,'vertex','system.unit',unitFields)).filter(row=>ids.has(row.id));
}
async function publications(tx:SqlExecutor,runId:string):Promise<{record:PublicationRecord;stageId:string}[]>{
 const out:{record:PublicationRecord;stageId:string}[]=[];
 for(const unit of await runUnits(tx,runId)){
  const record=await readPublicationIn(tx,String(unit.values.unit_name),Number(unit.values.generation));
  if(record)out.push({record,stageId:String(unit.values.stage_name)});
 }
 return out;
}
export async function readRunPublicationStages(database:FillStateSnapshotDatabase,runId:string):Promise<readonly RunPublicationStage[]>{return snapshotTransaction(database,async tx=>{
 const groups=new Map<string,number>();for(const row of await publications(tx,runId))groups.set(row.stageId,(groups.get(row.stageId)??0)+1);
 return [...groups].sort(([a],[b])=>byCodePoint(a,b)).map(([stageId,publications])=>({stageId,publications}));
});}
export async function readRunPublicationCount(database:FillStateSnapshotDatabase,runId:string):Promise<number>{return snapshotTransaction(database,async tx=>(await publications(tx,runId)).length);}
export async function readRunPublicationFacts(database:FillStateSnapshotDatabase,runId:string):Promise<number>{return snapshotTransaction(database,async tx=>(await publications(tx,runId)).reduce((sum,row)=>sum+row.record.facts,0));}
async function unitPlanIn(tx:SqlExecutor,unitId:string,generation:number):Promise<UnitPlanRecord|null>{
 const uid=await readUnitGraphUidIn(tx,unitId,generation);if(!uid)return null;
 const unit=await read(tx,'system.unit',uid),v=unit?.values;if(!v||v.planned_at===undefined)return null;
 const versions=await related(tx,'system.unit-cache-version','system.unit-cache-version-unit',uid);
 const edges=await readKindAssertions(tx,'edge','system.unit-run',[]),edge=edges.find(edge=>edge.from===unit!.id);
 const run=(await readKindAssertions(tx,'vertex','system.run',['run_name'])).find(row=>row.id===edge?.to);
 if(!run)throw new Error(`${import.meta.path}: planned unit ${unitId}/${generation} has no run`);
 return {unitId,generation,runId:String(run.values.run_name),stageId:String(v.plan_stage_name),stageUnitId:String(v.plan_stage_unit_name),scope:String(v.plan_scope),stagePosition:Number(v.plan_stage_position),planPosition:Number(v.plan_position),plannedAt:Number(v.planned_at),...(versions.length?{cacheVersions:Object.fromEntries(versions.map(row=>[String(row.values.name),String(row.values.version)]))}:{})};
}
export async function recordUnitPlanIn(tx:SqlExecutor,options:UnitPlanOptions):Promise<UnitPlanRecord>{
 await locked(tx);const uid=await requiredUnit(tx,options.unitId,options.generation);
 await write(tx,'system.unit',uid,{plan_stage_name:options.stageId,plan_stage_unit_name:options.stageUnitId,plan_scope:options.scope,plan_stage_position:options.stagePosition,plan_position:options.planPosition,planned_at:options.at});
 const versions=await related(tx,'system.unit-cache-version','system.unit-cache-version-unit',uid);
 const {contract,binding}=await orchestrationBinding(tx);
 await publishGraphDrafts(tx,contract,{vertices:[],removals:versions.filter(row=>!(String(row.values.name) in (options.cacheVersions??{}))).map(row=>({kind:'system.unit-cache-version',uid:row.uid,key:{},producer:binding.sourceUid}))});
 for(const [name,version] of Object.entries(options.cacheVersions??{}))await child(tx,'system.unit-cache-version','system.unit-cache-version-unit','system.unit',uid,{name,version},versions.find(row=>row.values.name===name)?.uid);
 return {...options,plannedAt:options.at};
}
export async function recordUnitPlan(database:OrchestratorDatabase,options:UnitPlanOptions):Promise<UnitPlanRecord>{return transaction(database,'write',tx=>recordUnitPlanIn(tx,options));}
export async function readUnitPlan(database:FillStateSnapshotDatabase,unitId:string,generation:number):Promise<UnitPlanRecord|null>{return snapshotTransaction(database,tx=>unitPlanIn(tx,unitId,generation));}
export async function readRunPlans(database:FillStateSnapshotDatabase,runId:string,options:{readonly history?:boolean}={}):Promise<readonly UnitPlanRecord[]>{return snapshotTransaction(database,async tx=>{
 const out:UnitPlanRecord[]=[];
 for(const row of await runUnits(tx,runId)){
  const id=String(row.values.unit_name),generation=Number(row.values.generation);
  if(!options.history&&await readUnitGraphUidIn(tx,id)!==row.uid)continue;
  const plan=await unitPlanIn(tx,id,generation);if(plan)out.push(plan);
 }
 return out.sort((a,b)=>byCodePoint(a.unitId,b.unitId));
});}
export async function appendProgress(database:OrchestratorDatabase,event:Omit<FillProgressEvent,'seq'>):Promise<FillProgressEvent>{
 return (await appendProgresses(database,[event]))[0]!;
}
async function appendProgressBatchIn(tx:SqlExecutor,events:readonly Omit<FillProgressEvent,'seq'>[]):Promise<readonly FillProgressEvent[]>{
 await locked(tx);
 const first=events[0]!,uid=await requiredRun(tx,first.runId),existing=await related(tx,'system.progress','system.progress-run',uid);
 let seq=Math.max(0,...existing.map(row=>Number(row.values.seq)));
 const {contract,binding}=await orchestrationBinding(tx);
 const vertices:import('./contract.js').VertexDraft[]=[],edges:import('./contract.js').EdgeDraft[]=[];
 const unitUids=new Map<string,string>(),out:FillProgressEvent[]=[];
 for(const event of events){
  const progressUid=newUid(),selectedSeq=++seq;
  vertices.push({kind:'system.progress',uid:progressUid,key:{},values:{seq:selectedSeq,at:event.at,stage:event.stage,unit_name:event.unitId,generation:event.generation??0,kind:event.kind,summary:event.summary},producer:binding.sourceUid,producerVersion:binding.contractVersion});
  const from={kind:'system.progress',uid:progressUid,key:{}};
  edges.push({kind:'system.progress-run',from,to:{kind:'system.run',uid,key:{}},producer:binding.sourceUid,producerVersion:binding.contractVersion});
  if(event.unitId&&event.generation!==null){
   const key=JSON.stringify([event.unitId,event.generation]);
   let unitUid=unitUids.get(key);
   if(unitUid===undefined){unitUid=await requiredUnit(tx,event.unitId,event.generation);unitUids.set(key,unitUid);}
   edges.push({kind:'system.progress-unit',from,to:{kind:'system.unit',uid:unitUid,key:{}},producer:binding.sourceUid,producerVersion:binding.contractVersion});
  }
  out.push({...event,seq:selectedSeq});
 }
 await publishGraphDrafts(tx,contract,{vertices,edges,removals:[]});
 return out;
}
export async function appendProgresses(database:OrchestratorDatabase,events:readonly Omit<FillProgressEvent,'seq'>[]):Promise<readonly FillProgressEvent[]>{
 if(!events.length)return [];if(events.some(event=>event.runId!==events[0]!.runId))throw new Error(`${import.meta.path}: appendProgresses requires one run`);
 return transaction(database,'write',tx=>appendProgressBatchIn(tx,events));
}
export async function readProgress(database:FillStateSnapshotDatabase,runId:string,options:{readonly limit?:number}={}):Promise<readonly FillProgressEvent[]>{return snapshotTransaction(database,async tx=>{
 const uid=await readRunGraphUidIn(tx,runId);if(!uid)return [];
 const events=(await related(tx,'system.progress','system.progress-run',uid)).map(({values:v}):FillProgressEvent=>({runId,seq:Number(v.seq),at:Number(v.at),stage:String(v.stage),unitId:String(v.unit_name),generation:Number(v.generation)||null,kind:v.kind as ProgressKind,summary:String(v.summary)})).sort((a,b)=>a.seq-b.seq);
 return options.limit===undefined?events:events.slice(Math.max(0,events.length-options.limit));
});}

export async function recordInheritedUnit(database:OrchestratorDatabase,options:{readonly runId:string;readonly unitId:string;readonly generation:number}):Promise<void>{
 await transaction(database,'write',async tx=>{
  await locked(tx);
  const runUid=await requiredRun(tx,options.runId),unitUid=await requiredUnit(tx,options.unitId,options.generation);
  if((await read(tx,'system.unit',unitUid))?.values.state!=='published')raise(`cannot inherit unpublished unit ${options.unitId}/${options.generation}`);
  const {contract,binding}=await orchestrationBinding(tx);
  await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edges:[{kind:'system.run-inherited-unit',discriminator:unitUid,from:{kind:'system.run',uid:runUid,key:{}},to:{kind:'system.unit',uid:unitUid,key:{}},producer:binding.sourceUid,producerVersion:binding.contractVersion}]});
 });
}
