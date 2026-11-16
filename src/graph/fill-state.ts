/** Fill state machines persisted as typed graph assertions (decision 0039). */
import { withSpan } from '../obs/trace.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import { EMPTY_CONTRACT, type EdgeDraft, type EntityRefDraft, type GraphContract } from './contract.js';
import { withAssertionContract } from './system-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { installDisputeSelection, refreshDisputeSelection } from './disputes.js';
import { startupBinding } from './manifest-publication.js';
import { publishGraphDrafts, acquireGraphWriteLock, bindWriteCapability, type WriteCapability } from './write.js';
import { newUid } from './uid.js';
import { readKindAssertions as readAssertions, type AssertionRecord } from './records.js';
import { byCodePoint } from '../model/order.js';
import { here, raise, withLocation, type Refusal } from '../fill/fsm-core.js';
import { CHAIN_STATES, RUN_STATES, UNIT_STATES, chainMachine, newChainContext, newRunContext, newUnitContext, runMachine, unitMachine } from '../fill/fsm.js';
import type { ChainContext, ChainEvent, ChainState, RunContext, RunEvent, RunState, UnitAdvanceEvent, UnitContext, UnitEvent, UnitState, RunSelection } from '../fill/fsm.js';

export type FillStateSnapshotDatabase = Pick<DatabaseOwner, 'transaction'>;
export type FillStateDatabase = FillStateSnapshotDatabase & { readonly graphContract: GraphContract };
/** No private state tables: all records live in the ordinary graph. */
export const FILL_STATE_TABLES = ['node', 'edge', 'assertion'] as const;
export const FILL_STORE_STEPS = {
  createUnit: 'fill-store/unit--create-->planned',
  openGeneration: 'fill-store/generation--open-->planned',
  retryGeneration: 'fill-store/generation--retry-->planned',
} as const;
export const RETRYABLE_UNIT_STATES: readonly UnitState[] = ['failed', 'blocked', 'cancelled', 'skipped'];
/** A product's chain of runs as it is persisted. */
export interface ChainRecord {
  readonly product: string;
  readonly state: ChainState;
  readonly context: ChainContext;
  readonly updatedAt: number;
}

/** One fill run as it is persisted. */
export interface RunRecord {
  readonly runId: string;
  readonly product: string;
  readonly state: RunState;
  readonly context: RunContext;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One unit's current scheduler generation as it is persisted. */
export interface UnitRecord {
  readonly unitId: string;
  readonly product: string;
  /** The run that planned this generation. */
  readonly runId: string;
  readonly stageId: string;
  readonly scopeKey: string;
  /** The generation in force; older generations stay as their own records. */
  readonly generation: number;
  readonly state: UnitState;
  readonly inputsDigest: string;
  readonly context: UnitContext;
  readonly publishedAt: number | null;
  readonly staleAt: number | null;
  readonly updatedAt: number;

}


/** What a step did: the new record and the effects the caller must perform, or why the machine refused it. */
export type StoreStep<Record, State extends string> =
  | { readonly ok: true; readonly record: Record; readonly transition: string; readonly effects: readonly string[] }
  | { readonly ok: false; readonly refusal: Refusal<State>; readonly record: Record };


const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
/** A transaction must see assertions it just wrote after its transaction timestamp. */
async function readGraphRecords(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], subjectUids?: readonly string[]): Promise<AssertionRecord[]> {
  return await withSpan('graph.fill.records', {}, async () => {
    const clock = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    return await readAssertions(tx,sort,kind,fields,{validAt:clock,recordedAt:clock,...(subjectUids===undefined?{}:{subjectUids})});
  });
}

const fields = {
  chain: ['product_name', 'state', 'updated_at'],
  run: ['run_name', 'product_name', 'state', 'planning_epoch', 'planning_closed', 'has_selection', 'created_at', 'updated_at'],
  unit: ['unit_name', 'product_name', 'stage_name', 'scope', 'generation', 'state', 'inputs_digest', 'fence', 'attempt', 'retries_left', 'retry_at', 'replacement_generation', 'skipped_because', 'published_at', 'stale_at', 'updated_at'],
} as const;
const number = (value: unknown): number => Number(value);
const optionalNumber = (value: unknown): number | null => value == null ? null : number(value);
const text = (value: unknown): string => String(value);
function requireState<State extends string>(states: readonly State[], value: unknown, kind: string, uid: string): State {
  if (!states.includes(value as State)) raise(`graph ${kind}, vertex ${uid}: invalid state ${String(value)}`);
  return value as State;
}
async function run<R>(site: string, database: FillStateDatabase, operation: string, work: (tx: SqlExecutor) => Promise<R>, kind: 'write'): Promise<R> {
  return await withSpan('graph.fillstate.run', { 'fillstate.operation': operation, 'fillstate.kind': kind }, async () =>
    await withLocation(site, operation, FILL_STATE_TABLES, async () => await database.transaction(kind, async tx => {
      if (kind === 'write') {
        await acquireGraphWriteLock(tx);
        await installDisputeSelection(tx, database.graphContract);
      }
      const result = await work(tx);
      if (kind === 'write') {
        await refreshDisputeSelection(tx, database.graphContract);
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      }
      return result;
    })));
}
async function snapshotRun<R>(site: string, database: FillStateSnapshotDatabase, operation: string, work: (tx: SqlExecutor) => Promise<R>): Promise<R> {
  return await withSpan('graph.fillstate.snapshot', { 'fillstate.operation': operation }, async () =>
    await withLocation(site, operation, FILL_STATE_TABLES, async () => await database.transaction('snapshot', work)));
}
const ref = (kind: string, uid: string): EntityRefDraft => ({ kind, uid, key: {} });
export function fillEdge(kind: string, fromKind: string, from: string, toKind: string, to: string): EdgeDraft {
  return {kind, from: ref(fromKind, from), to: ref(toKind, to), ...(kind === 'system.chain-run' ? {discriminator: to} : {}), producer: 'fill-state', producerVersion: '1'};
}
const transactionBindings=new WeakMap<SqlExecutor,WriteCapability>();
async function bind(tx: SqlExecutor): Promise<void> {
 let binding=transactionBindings.get(tx);
 if(!binding){binding=(await startupBinding(tx,contract,'fill-state')).binding;transactionBindings.set(tx,binding);}
 bindWriteCapability(tx,binding);
}
export interface GraphWriteContext { readonly contract: GraphContract; readonly binding: WriteCapability; }
export async function putFillVertexIn(tx: SqlExecutor, kind: string, uid: string, values: Record<string, unknown>, edges: readonly EdgeDraft[] = [], context?: GraphWriteContext): Promise<void> {
  if(context) bindWriteCapability(tx,context.binding); else await bind(tx);
  await publishGraphDrafts(tx, context?.contract ?? contract, {vertices: [{kind, key: {}, uid, values, producer: 'fill-state', producerVersion: '1'}], edges, removals: []});
}
async function rows(tx: SqlExecutor, kind: keyof typeof fields, subjectUids?: readonly string[]): Promise<AssertionRecord[]> { return await readGraphRecords(tx, 'vertex', `system.${kind}`, fields[kind],subjectUids); }
async function runNode(tx: SqlExecutor, runId: string): Promise<AssertionRecord | undefined> {
  const identity=(await readGraphRecords(tx,'vertex','system.run',['run_name'])).find(row=>row.values['run_name']===runId);
  return identity===undefined?undefined:(await rows(tx,'run',[identity.uid]))[0];
}
async function unitNode(tx: SqlExecutor, unitId: string, generation?: number): Promise<AssertionRecord | undefined> {
  const candidates = (await readGraphRecords(tx,'vertex','system.unit',['unit_name','generation'])).filter(row => row.values['unit_name'] === unitId && (generation === undefined || number(row.values['generation']) === generation));
  const replaced = generation === undefined ? new Set((await readGraphRecords(tx,'edge','system.unit-replacement',[])).map(link => link.from)) : new Set<number | undefined>();
  const current = candidates.filter(row => !replaced.has(row.id));
  if(current.length > 1) raise(`graph system.unit: ambiguous generation of ${unitId}`);
  return current[0]===undefined?undefined:(await rows(tx,'unit',[current[0].uid]))[0];
}
/** Serialize admission with graph operations before taking the owning run identity lock. */
export async function lockFillScope(tx: SqlExecutor, runId: string): Promise<void> {
  return await withSpan('graph.fill.lock', {}, async () => {
    await acquireGraphWriteLock(tx);
    const uid = await readRunGraphUidIn(tx, runId);
    if (uid === undefined) raise(`graph system.run: no run ${runId}`);
    await tx.query('SELECT id FROM node WHERE uid=$1::uuid FOR UPDATE', [uid]);
  });
}
/** Graph identities for host admission; descriptors never become graph identity keys. */
export async function readRunGraphUidIn(tx: SqlExecutor, runId: string): Promise<string | undefined> { return (await runNode(tx, runId))?.uid; }
export async function readUnitGraphUidIn(tx: SqlExecutor, unitId: string, generation?: number): Promise<string | undefined> { return (await unitNode(tx, unitId, generation))?.uid; }
function chainRecord(row: AssertionRecord, activeRunId: string | null): ChainRecord {
  return {product: text(row.values['product_name']), state: requireState(CHAIN_STATES, row.values['state'], 'system.chain', row.uid), context: {activeRunId}, updatedAt: number(row.values['updated_at'])};
}
async function readChainIn(tx: SqlExecutor, product: string): Promise<{node: AssertionRecord; record: ChainRecord} | null> {
  const node = (await rows(tx, 'chain')).find(row => row.values['product_name'] === product);
  if (!node) return null;
  const active = (await readGraphRecords(tx, 'edge', 'system.chain-active-run', [])).find(row => row.from === node.id);
  const run = active === undefined ? undefined : (await rows(tx,'run')).find(row => row.id === active.to);
  return {node, record: chainRecord(node, run === undefined ? null : text(run.values['run_name']))};
}
async function selection(tx: SqlExecutor, run: AssertionRecord): Promise<RunSelection | undefined> {
  if (run.values['has_selection'] !== true) return undefined;
  const edges = await readGraphRecords(tx, 'edge', 'system.run-selection-run', []);
  const ids = new Set(edges.filter(e => e.to === run.id).map(e => e.from));
  const entries = (await readGraphRecords(tx, 'vertex', 'system.run-selection', ['role','position','name','group_name','plugin_name','stage_unit_name'])).filter(row => ids.has(row.id)).sort((a,b) => number(a.values['position']) - number(b.values['position']));
  return {
    selected: entries.filter(row => row.values['role'] === 'selected').map(row => text(row.values['name'])),
    order: entries.filter(row => row.values['role'] === 'order').map(row => text(row.values['name'])),
    ...(entries.find(row => row.values['role'] === 'vertex') === undefined ? {} : {vertex: text(entries.find(row => row.values['role'] === 'vertex')!.values['name'])}),
    groups: entries.filter(row => row.values['role'] === 'group').map(row => ({kind: text(row.values['name']), group: row.values['group_name'] == null ? null : text(row.values['group_name']), plugin: text(row.values['plugin_name']), stageUnitId: text(row.values['stage_unit_name'])})),
  };
}
async function runRecord(tx: SqlExecutor, row: AssertionRecord): Promise<RunRecord> {
  const v = row.values, selected = await selection(tx, row);
  const context: RunContext = {planningEpoch: number(v['planning_epoch']), planningClosed: v['planning_closed'] === true, ...(selected === undefined ? {} : {selection:selected})};
  return {runId: text(v['run_name']), product: text(v['product_name']), state: requireState(RUN_STATES,v['state'],'system.run',row.uid), context, createdAt:number(v['created_at']),updatedAt:number(v['updated_at'])};
}
async function unitRecord(tx: SqlExecutor, row: AssertionRecord): Promise<UnitRecord> {
  const links = await readGraphRecords(tx, 'edge', 'system.unit-run', []);
  const run = (await rows(tx,'run')).find(run => run.id === links.find(link => link.from === row.id)?.to);
  if (!run) raise(`graph system.unit, vertex ${row.uid}: no owning run`);
  const v = row.values, generation = number(v['generation']);
  return {unitId:text(v['unit_name']),product:text(v['product_name']),runId:text(run.values['run_name']),stageId:text(v['stage_name']),scopeKey:text(v['scope']),generation,
    state:requireState(UNIT_STATES,v['state'],'system.unit',row.uid),inputsDigest:text(v['inputs_digest']),
    context:{generation,fence:number(v['fence']),attempt:number(v['attempt']),retriesLeft:number(v['retries_left']),retryAt:optionalNumber(v['retry_at']),replacedBy:optionalNumber(v['replacement_generation']),skippedBecause:v['skipped_because']==null?null:text(v['skipped_because'])},
    publishedAt:optionalNumber(v['published_at']),staleAt:optionalNumber(v['stale_at']),updatedAt:number(v['updated_at'])};
}
async function journal(tx: SqlExecutor, subjectKind: 'chain' | 'run' | 'unit', uid: string, step: string, from: string, to: string, event: string, at: number, fence: number | null = null, context?: GraphWriteContext): Promise<void> {
  const id = newUid();
  await putFillVertexIn(tx, 'system.fill-transition', id, {step,from_state:from,to_state:to,event,at,fence}, [fillEdge('system.fill-transition-subject','system.fill-transition',id,`system.${subjectKind}`,uid)], context);
}
function changedValues(previous: Record<string,unknown>, next: Record<string,unknown>): Record<string,unknown> {
  return Object.fromEntries(Object.entries(next).filter(([name,value])=>!Object.is(previous[name],value)));
}
function runValues(state: RunState, context: RunContext, at: number): Record<string,unknown> {
  return {state,planning_epoch:context.planningEpoch,planning_closed:context.planningClosed,updated_at:at};
}
function unitValues(record: UnitRecord): Record<string,unknown> {
  const c = record.context;
  return {unit_name:record.unitId,product_name:record.product,stage_name:record.stageId,scope:record.scopeKey,generation:record.generation,state:record.state,inputs_digest:record.inputsDigest,fence:c.fence,attempt:c.attempt,retries_left:c.retriesLeft,retry_at:c.retryAt,replacement_generation:c.replacedBy,skipped_because:c.skippedBecause??null,published_at:record.publishedAt,stale_at:record.staleAt,updated_at:record.updatedAt};
}
export async function openChain(database: FillStateDatabase, options: {readonly product:string;readonly at:number}): Promise<ChainRecord> {
  return await run(here(),database,`openChain(${options.product})`,async tx => {
    const old = await readChainIn(tx,options.product); if (old) return old.record;
    await putFillVertexIn(tx,'system.chain',newUid(),{product_name:options.product,state:'idle',updated_at:options.at});
    return {product:options.product,state:'idle',context:newChainContext(),updatedAt:options.at};
  },'write');
}
export async function readChain(database: FillStateSnapshotDatabase, product: string): Promise<ChainRecord|null> {return await snapshotRun(here(),database,`readChain(${product})`,async tx => (await readChainIn(tx,product))?.record??null);}
export async function advanceChain(database: FillStateDatabase, options:{readonly product:string;readonly event:ChainEvent}):Promise<StoreStep<ChainRecord,ChainState>> {
  return await run(here(),database,`advanceChain(${options.product})`,async tx => {
    const current = await readChainIn(tx,options.product); if (!current) raise(`graph system.chain: no chain for ${options.product}`);
    const step=chainMachine.step(current.record,options.event); if(!step.ok)return {ok:false,record:current.record,refusal:step.refusal} as const;
    await putFillVertexIn(tx,'system.chain',current.node.uid,{state:step.state,updated_at:options.event.at});
    const previous=(await readGraphRecords(tx,'edge','system.chain-active-run',[])).filter(e=>e.from===current.node.id);
    await bind(tx);
    for(const held of previous){const target=(await rows(tx,'run')).find(r=>r.id===held.to)!;await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edgeRemovals:[{...fillEdge('system.chain-active-run','system.chain',current.node.uid,'system.run',target.uid)}]});}
    if(step.context.activeRunId!==null){const target=await runNode(tx,step.context.activeRunId);if(!target)raise(`graph system.run: no run ${step.context.activeRunId}`);await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edges:[fillEdge('system.chain-active-run','system.chain',current.node.uid,'system.run',target.uid)]});}
    await journal(tx,'chain',current.node.uid,step.transition,current.record.state,step.state,options.event.type,options.event.at);
    return {ok:true,record:{...current.record,state:step.state,context:step.context,updatedAt:options.event.at},transition:step.transition,effects:step.effects} as const;
  },'write');
}
export async function createRun(database:FillStateDatabase,options:{readonly runId:string;readonly product:string;readonly at:number;readonly selection?:RunSelection}):Promise<RunRecord> {
  return await run(here(),database,`createRun(${options.runId})`,async tx=>{
    if(await runNode(tx,options.runId))raise(`graph system.run: duplicate run ${options.runId}`);
    const uid=newUid(),context={...newRunContext(null),...(options.selection===undefined?{}:{selection:options.selection})};
    let chain=await readChainIn(tx,options.product);
    if(!chain){await putFillVertexIn(tx,'system.chain',newUid(),{product_name:options.product,state:'idle',updated_at:options.at});chain=await readChainIn(tx,options.product);}
    await putFillVertexIn(tx,'system.run',uid,{run_name:options.runId,product_name:options.product,...runValues('created',context,options.at),created_at:options.at,has_selection:options.selection!==undefined},[fillEdge('system.chain-run','system.chain',chain!.node.uid,'system.run',uid)]);
    if(options.selection?.vertex!==undefined){const id=newUid();await putFillVertexIn(tx,'system.run-selection',id,{role:'vertex',position:0,name:options.selection.vertex},[fillEdge('system.run-selection-run','system.run-selection',id,'system.run',uid)]);}
    for(const role of ['selected','order','group'] as const){const entries=role==='group'?options.selection?.groups??[]:options.selection?.[role]??[];for(const [position,entry] of entries.entries()){
      const id=newUid();const group=typeof entry==='string'?undefined:entry;
      await putFillVertexIn(tx,'system.run-selection',id,{role,position,name:typeof entry==='string'?entry:entry.kind,group_name:group?.group??null,plugin_name:group?.plugin??null,stage_unit_name:group?.stageUnitId??null},[fillEdge('system.run-selection-run','system.run-selection',id,'system.run',uid)]);
    }}
    return {runId:options.runId,product:options.product,state:'created',context,createdAt:options.at,updatedAt:options.at};
  },'write');
}
export async function readRunIn(tx:SqlExecutor,runId:string):Promise<RunRecord|null>{const row=await runNode(tx,runId);return row?await runRecord(tx,row):null;}
export async function readRun(database:FillStateSnapshotDatabase,runId:string):Promise<RunRecord|null>{return await snapshotRun(here(),database,`readRun(${runId})`,tx=>readRunIn(tx,runId));}
async function runRecords(tx:SqlExecutor):Promise<RunRecord[]>{return await Promise.all((await rows(tx,'run')).map(row=>runRecord(tx,row)));}
const newest=(a:RunRecord,b:RunRecord):number=>b.createdAt-a.createdAt||byCodePoint(b.runId,a.runId);
export async function readRuns(database:FillStateSnapshotDatabase,product:string):Promise<readonly RunRecord[]>{return await snapshotRun(here(),database,`readRuns(${product})`,async tx=>(await runRecords(tx)).filter(r=>r.product===product).sort(newest));}
export async function readLatestRun(database:FillStateSnapshotDatabase,product:string):Promise<RunRecord|null>{return (await readRuns(database,product))[0]??null;}
export async function readLiveRun(database:FillStateSnapshotDatabase):Promise<RunRecord|null>{return await snapshotRun(here(),database,'readLiveRun',async tx=>(await runRecords(tx)).filter(r=>['created','planning','running','pausing','cancelling'].includes(r.state)).sort(newest)[0]??null);}
export async function hasSuccessfulFill(database:FillStateSnapshotDatabase):Promise<boolean>{return await snapshotRun(here(),database,'hasSuccessfulFill',async tx=>(await rows(tx,'run')).some(r=>r.values['state']==='succeeded'));}
export async function readStoreStamp(database:FillStateSnapshotDatabase):Promise<string>{return await withSpan('graph.fill.stamp', {}, async () => await snapshotRun(here(),database,'readStoreStamp',async tx=>{const result=await tx.query<{stamp:string}>("SELECT coalesce(max(recorded_sequence)::text,'-') AS stamp FROM assertion");return result.rows[0]?.stamp??'-';}));}
export async function advanceRun(database:FillStateDatabase,options:{readonly runId:string;readonly event:RunEvent;readonly expectedState?:RunState}):Promise<StoreStep<RunRecord,RunState>>{
  const at=here();return await run(at,database,`advanceRun(${options.runId})`,async tx=>{
    const node=await runNode(tx,options.runId);if(!node)raise(`graph system.run: no run ${options.runId}`);const current=await runRecord(tx,node);
    if(options.expectedState!==undefined&&current.state!==options.expectedState)return {ok:false,record:current,refusal:{code:'fill-run/guard-refused',reason:`${at}: run ${current.runId} is ${current.state}, expected ${options.expectedState}`,state:current.state,event:options.event.type,guard:'expected-state',guards:['expected-state'],transitions:runMachine.from(current.state).filter(t=>t.event===options.event.type).map(t=>t.id)}} as const;
    const step=runMachine.step(current,options.event);if(!step.ok)return {ok:false,record:current,refusal:step.refusal} as const;
    await putFillVertexIn(tx,'system.run',node.uid,changedValues(runValues(current.state,current.context,current.updatedAt),runValues(step.state,step.context,options.event.at)));await journal(tx,'run',node.uid,step.transition,current.state,step.state,options.event.type,options.event.at);
    return {ok:true,record:{...current,state:step.state,context:step.context,updatedAt:options.event.at},transition:step.transition,effects:step.effects} as const;
  },'write');
}

export interface UnitCreateOptions { readonly unitId:string;readonly product:string;readonly runId:string;readonly stageId:string;readonly scopeKey:string;readonly inputsDigest:string;readonly retries:number;readonly at:number; }
export async function createUnit(database:FillStateDatabase,options:UnitCreateOptions):Promise<UnitRecord>{return await run(here(),database,`createUnit(${options.unitId})`,tx=>createUnitIn(tx,options),'write');}
export async function createUnitIn(tx:SqlExecutor,options:UnitCreateOptions):Promise<UnitRecord>{
  await acquireGraphWriteLock(tx);
  const existing=(await rows(tx,'unit')).filter(r=>r.values['product_name']===options.product&&r.values['stage_name']===options.stageId&&r.values['scope']===options.scopeKey).sort((a,b)=>number(b.values['generation'])-number(a.values['generation']))[0];
  if(existing)return await unitRecord(tx,existing);
  const owner=await runNode(tx,options.runId);if(!owner)raise(`graph system.run: no run ${options.runId}`);
  const record:UnitRecord={unitId:options.unitId,product:options.product,runId:options.runId,stageId:options.stageId,scopeKey:options.scopeKey,generation:1,state:'planned',inputsDigest:options.inputsDigest,context:newUnitContext({generation:1,retries:options.retries}),publishedAt:null,staleAt:null,updatedAt:options.at};
  const uid=newUid();await putFillVertexIn(tx,'system.unit',uid,unitValues(record),[fillEdge('system.unit-run','system.unit',uid,'system.run',owner.uid)]);
  await journal(tx,'unit',uid,FILL_STORE_STEPS.createUnit,'(none)','planned','create',options.at,0);return record;
}
export async function readUnitIn(tx:SqlExecutor,unitId:string):Promise<UnitRecord|null>{const node=await unitNode(tx,unitId);return node?await unitRecord(tx,node):null;}
export async function readUnitGenerationIn(tx:SqlExecutor,unitId:string,generation:number):Promise<UnitRecord|null>{const node=await unitNode(tx,unitId,generation);return node?await unitRecord(tx,node):null;}
export async function readUnit(database:FillStateSnapshotDatabase,unitId:string):Promise<UnitRecord|null>{return await snapshotRun(here(),database,`readUnit(${unitId})`,tx=>readUnitIn(tx,unitId));}
export async function readUnitGeneration(database:FillStateSnapshotDatabase,unitId:string,generation:number):Promise<UnitRecord|null>{return await snapshotRun(here(),database,`readUnitGeneration(${unitId}/${generation})`,tx=>readUnitGenerationIn(tx,unitId,generation));}
async function allUnitRecords(tx:SqlExecutor,currentOnly:boolean):Promise<UnitRecord[]>{
  const all=await rows(tx,'unit');
  const replaced = currentOnly ? new Set((await readGraphRecords(tx,'edge','system.unit-replacement',[])).map(link=>link.from)) : new Set<number | undefined>();
  return (await Promise.all(all.filter(row=>!replaced.has(row.id)).map(row=>unitRecord(tx,row)))).sort((a,b)=>byCodePoint(a.unitId,b.unitId)||a.generation-b.generation);
}
export async function readRunUnitsIn(tx:SqlExecutor,runId:string,currentOnly=true):Promise<readonly UnitRecord[]>{return (await allUnitRecords(tx,currentOnly)).filter(r=>r.runId===runId);}
export async function readRunUnits(database:FillStateSnapshotDatabase,runId:string):Promise<readonly UnitRecord[]>{return await snapshotRun(here(),database,`readRunUnits(${runId})`,tx=>readRunUnitsIn(tx,runId));}
export async function readRunUnitHistory(database:FillStateSnapshotDatabase,runId:string):Promise<readonly UnitRecord[]>{return await snapshotRun(here(),database,`readRunUnitHistory(${runId})`,tx=>readRunUnitsIn(tx,runId,false));}
export async function readProductUnits(database:FillStateSnapshotDatabase,options:{readonly product:string;readonly state:UnitState}):Promise<readonly UnitRecord[]>{return await snapshotRun(here(),database,`readProductUnits(${options.product})`,async tx=>(await allUnitRecords(tx,true)).filter(r=>r.product===options.product&&r.state===options.state));}
export async function advanceUnitIn(tx:SqlExecutor,options:{readonly unitId:string;readonly event:UnitAdvanceEvent},context?:GraphWriteContext):Promise<StoreStep<UnitRecord,UnitState>>{
  await acquireGraphWriteLock(tx);
  const node=await unitNode(tx,options.unitId);if(!node)raise(`graph system.unit: no unit ${options.unitId}`);
  const current=await unitRecord(tx,node),event=options.event as UnitEvent;
  if(event.type!=='cancel'){
    const owner=await readRunIn(tx,current.runId);
    if(owner&&['cancelling','cancelled','failed'].includes(owner.state))return {ok:false,record:current,refusal:{code:'fill-unit/no-transition',reason:`fill-unit: the run of unit "${options.unitId}" generation ${String(current.generation)} is ${owner.state}, which revoked the authority of the units it planned, so "${event.type}" is not taken; the cancel is the step such a run's units take`,state:current.state,event:event.type,guard:null,guards:[],transitions:[]}};
  }
  const step=unitMachine.step(current,event);if(!step.ok)return {ok:false,record:current,refusal:step.refusal};
  const record:UnitRecord={...current,state:step.state,context:step.context,publishedAt:step.state==='published'?event.at:current.publishedAt,staleAt:step.state==='stale'?event.at:current.staleAt,updatedAt:event.at};
  await putFillVertexIn(tx,'system.unit',node.uid,changedValues(unitValues(current),unitValues(record)),[],context);await journal(tx,'unit',node.uid,step.transition,current.state,step.state,event.type,event.at,step.context.fence,context);
  return {ok:true,record,transition:step.transition,effects:step.effects};
}
export async function advanceUnit(database:FillStateDatabase,options:{readonly unitId:string;readonly event:UnitAdvanceEvent}):Promise<StoreStep<UnitRecord,UnitState>>{return await run(here(),database,`advanceUnit(${options.unitId}, ${options.event.type})`,tx=>advanceUnitIn(tx,options),'write');}
interface ReplacementOptions {readonly unitId:string;readonly runId:string;readonly inputsDigest:string;readonly retries:number;readonly at:number;}
async function replace(database:FillStateDatabase,options:ReplacementOptions,retry:boolean):Promise<StoreStep<UnitRecord,UnitState>>{
 return await run(here(),database,`${retry?'retryGeneration':'replaceStaleGeneration'}(${options.unitId})`,async tx=>{
  const node=await unitNode(tx,options.unitId);if(!node)raise(`graph system.unit: no unit ${options.unitId}`);const current=await unitRecord(tx,node);
  if(retry?!RETRYABLE_UNIT_STATES.includes(current.state):current.state!=='stale')return {ok:false,record:current,refusal:{code:retry?'fill-store/unit-not-retryable':'fill-store/unit-not-replaceable',reason:retry?`fill-unit: unit "${current.unitId}" stands ${current.state}; a generation is retried only from ${RETRYABLE_UNIT_STATES.join(', ')}, and a ${current.state} one stays as its record`:`fill-unit: unit "${current.unitId}" is ${current.state}; only a stale generation is replaced, and a ${current.state} one stays as its record`,state:current.state,event:retry?'retry-generation':'open-generation',guard:null,guards:[],transitions:[]}} as const;
  const generation=current.generation+1;if(!retry&&current.context.replacedBy!==null&&current.context.replacedBy!==generation)raise(`graph system.unit, vertex ${node.uid}: invalid replacement generation ${current.context.replacedBy}`);
  const owner=await runNode(tx,options.runId);if(!owner)raise(`graph system.run: no run ${options.runId}`);
  const record:UnitRecord={...current,runId:options.runId,generation,state:'planned',inputsDigest:options.inputsDigest,context:newUnitContext({generation,retries:options.retries,fence:current.context.fence}),publishedAt:null,staleAt:null,updatedAt:options.at};
  const uid=newUid(),transition=retry?FILL_STORE_STEPS.retryGeneration:FILL_STORE_STEPS.openGeneration;
  await putFillVertexIn(tx,'system.unit',uid,unitValues(record),[fillEdge('system.unit-run','system.unit',uid,'system.run',owner.uid),fillEdge('system.unit-replacement','system.unit',node.uid,'system.unit',uid)]);
  await journal(tx,'unit',uid,transition,current.state,'planned',retry?'retry-generation':'open-generation',options.at,record.context.fence);
  return {ok:true,record,transition,effects:[]} as const;
 },'write');
}
export async function replaceStaleGeneration(database:FillStateDatabase,options:ReplacementOptions):Promise<StoreStep<UnitRecord,UnitState>>{return await replace(database,options,false);}
export async function retryGeneration(database:FillStateDatabase,options:ReplacementOptions):Promise<StoreStep<UnitRecord,UnitState>>{return await replace(database,options,true);}
