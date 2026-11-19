/** Fill state machines persisted as typed graph assertions (decision 0039). */
import { withSpan } from '../obs/trace.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import { EMPTY_CONTRACT, assertionValueTableName, type EdgeDraft, type EntityRefDraft, type GraphContract } from './contract.js';
import { withAssertionContract } from './system-contract.js';
import { withManifestContract } from './manifest-contract.js';
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
type Identity = { readonly id: number; readonly uid: string; readonly key: Readonly<Record<string, unknown>>;
  /** An edge subject's own ends and discriminator, as its record holds them. */
  readonly from_node?: number; readonly to_node?: number; readonly discriminator?: string };
/** A transaction must see assertions it just wrote after its transaction timestamp. */
async function readGraphRecords(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], subjectUids?: readonly string[]): Promise<AssertionRecord[]> {
  return await withSpan('graph.fill.records', {}, async () => {
    const clock = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    return await readAssertions(tx,sort,kind,fields,{validAt:clock,recordedAt:clock,...(subjectUids===undefined?{}:{subjectUids})});
  });
}
/** The records of subjects already named, read without a pass over their kind. */
export async function readRecordsIn(tx: SqlExecutor, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], ids: readonly number[]): Promise<AssertionRecord[]> {
  if (ids.length === 0) return [];
  return await withSpan('graph.fill.records', {}, async () => {
    const clock = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const identities: Identity[] = [];
    if (sort === 'vertex') {
      const held = (await tx.query<{id:string;uid:string;key:Record<string,unknown>}>(`SELECT id::text AS id,uid::text AS uid,key FROM node WHERE id=ANY($1::bigint[])`, [ids])).rows;
      for (const row of held) identities.push({ id: Number(row.id), uid: row.uid, key: row.key });
    } else {
      // An edge subject is an `edge` row: `node` holds no row for it, and its ends are its own.
      const held = (await tx.query<{id:string;uid:string;from_node:string;to_node:string;discriminator:string}>(`SELECT id::text AS id,uid::text AS uid,from_node::text AS from_node,to_node::text AS to_node,discriminator FROM edge WHERE id=ANY($1::bigint[])`, [ids])).rows;
      for (const row of held) identities.push({ id: Number(row.id), uid: row.uid, key: {}, from_node: Number(row.from_node), to_node: Number(row.to_node), discriminator: row.discriminator });
    }
    return await readAssertions(tx,sort,kind,fields,{validAt:clock,recordedAt:clock,identities});
  });
}
/**
 * The subjects a lookup field's value names: value table → assertion → subject (decision 0039, item 25). The
 * value tables are read by their primary key, and a lookup field's value column carries the generated index,
 * so the walk meets the assertions that state this value and no other subject of the kind. A subject that
 * stated the value more than once is one subject: the rows are distinct on the subject, not one per assertion.
 */
export async function readSubjectsByValueIn(tx: SqlExecutor, kind: string, field: string, value: unknown): Promise<Identity[]> {
  const table = assertionValueTableName(kind, 'vertex', field);
  const held = await withSpan('graph.fill.lookup', { 'graph.kind': kind }, async () => await tx.query<{id:string;uid:string;key:Record<string,unknown>}>(`SELECT DISTINCT n.id::text AS id,n.uid::text AS uid,n.key
    FROM "${table}" v
    JOIN assertion_vertex_subject s ON s.assertion_id=v.assertion_id
    JOIN edge e ON e.id=s.subject_edge_id
    JOIN node n ON n.id=e.to_node
    WHERE v.value=$1`, [value]));
  return held.rows.map(row => ({ id: Number(row.id), uid: row.uid, key: row.key }));
}
/** The records of a kind whose lookup field states this value, as the field's current stream reads them. */
async function readNamedRecords(tx: SqlExecutor, kind: keyof typeof namedFields, field: string, value: unknown): Promise<AssertionRecord[]> {
  return await withSpan('graph.fill.lookup', {}, async () => {
    const subjects = await readSubjectsByValueIn(tx, kind, field, value);
    if (subjects.length === 0) return [];
    const clock = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    return await readAssertions(tx, 'vertex', kind, namedFields[kind]!, { validAt: clock, recordedAt: clock, identities: subjects });
  });
}
/** The node named by a uid, the first step of a read that starts from one node. */
export async function readNodeIdIn(tx: SqlExecutor, uid: string): Promise<number | undefined> {
  return await withSpan('graph.fill.node', {}, async () => {
    const held = (await tx.query<{id:string}>(`SELECT id::text AS id FROM node WHERE uid=$1::uuid`, [uid])).rows[0];
    return held === undefined ? undefined : Number(held.id);
  });
}
/** Unit records by node id, with the fields every unit read holds; no id names every unit (a request without a subject). */
export async function readUnitsIn(tx: SqlExecutor, ids?: readonly number[]): Promise<AssertionRecord[]> {
  return ids === undefined ? await rows(tx, 'unit') : await readRecordsIn(tx, 'vertex', 'system.unit', fields.unit, ids);
}
/** An edge kind's rows met at one end: its own ends, never a pass over the kind. */
export async function edgeRowsIn(tx: SqlExecutor, relation: string, end: 'from' | 'to', ids: readonly number[]): Promise<{ readonly id: number; readonly from: number; readonly to: number }[]> {
  if (ids.length === 0) return [];
  return await withSpan('graph.fill.edges', { 'graph.kind': relation }, async () => {
    const held = await tx.query<{id:string;from_node:string;to_node:string}>(`SELECT e.id::text AS id,e.from_node::text AS from_node,e.to_node::text AS to_node
      FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name=$1 AND e.${end === 'from' ? 'from_node' : 'to_node'}=ANY($2::bigint[]) ORDER BY e.id`, [relation, ids]);
    return held.rows.map(row => ({ id: Number(row.id), from: Number(row.from_node), to: Number(row.to_node) }));
  });
}

const fields = {
  chain: ['product_name', 'state', 'updated_at'],
  run: ['run_name', 'product_name', 'state', 'planning_epoch', 'planning_closed', 'has_selection', 'created_at', 'updated_at'],
  unit: ['unit_name', 'product_name', 'stage_name', 'scope', 'generation', 'state', 'inputs_digest', 'fence', 'attempt', 'retries_left', 'retry_at', 'replacement_generation', 'skipped_because', 'published_at', 'stale_at', 'updated_at',
    'produced_kind', 'producer', 'outcome', 'produced', 'reason', 'producer_version'],
} as const;
/** The field list of each kind a name is looked up in, keyed by the contract's kind name. */
const namedFields: Readonly<Record<string, readonly string[]>> = { 'system.chain': fields.chain, 'system.run': fields.run, 'system.unit': fields.unit };
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
      }
      const result = await work(tx);
      if (kind === 'write') {
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
const transactionBindings=new WeakMap<SqlExecutor,Map<GraphContract,WriteCapability>>();
export interface GraphWriteContext { readonly contract: GraphContract; readonly operationUid: string; readonly unitUid: string; }
/** Machine authority stays with fill-state; an operation supplies only assertion lineage. */
export async function bindFillStateIn(tx: SqlExecutor, declared: GraphContract = contract, context?: Pick<GraphWriteContext,'operationUid'> & {readonly unitUid?:string}, assertionContext = 1): Promise<WriteCapability> {
 let bindings=transactionBindings.get(tx);
 if(!bindings){bindings=new Map();transactionBindings.set(tx,bindings);}
 let binding=bindings.get(declared);
 if(!binding){binding=(await startupBinding(tx,declared,'fill-state')).binding;bindings.set(declared,binding);}
 const held={...binding,context:assertionContext,...(context?{operationUid:context.operationUid,unitUid:context.unitUid}:{})};
 bindWriteCapability(tx,held);
 return held;
}
export async function putFillVertexIn(tx: SqlExecutor, kind: string, uid: string, values: Record<string, unknown>, edges: readonly EdgeDraft[] = [], context?: GraphWriteContext): Promise<void> {
  await bindFillStateIn(tx,context?.contract ?? contract,context);
  await publishGraphDrafts(tx, context?.contract ?? contract, {vertices: [{kind, key: {}, uid, values, producer: 'fill-state', producerVersion: '1'}], edges, removals: []});
}
async function rows(tx: SqlExecutor, kind: keyof typeof fields, subjectUids?: readonly string[]): Promise<AssertionRecord[]> { return await readGraphRecords(tx, 'vertex', `system.${kind}`, fields[kind],subjectUids); }
/** The run a name states: value → assertions → subject, then the subject's current record (0039.25). */
async function runNode(tx: SqlExecutor, runId: string): Promise<AssertionRecord | undefined> {
  return (await readNamedRecords(tx, 'system.run', 'run_name', runId)).find(row => row.values['run_name'] === runId);
}
/** The unit a name (and optionally a generation) states, in the generation that is not replaced. */
async function unitNode(tx: SqlExecutor, unitId: string, generation?: number): Promise<AssertionRecord | undefined> {
  // The index finds every subject that ever stated the name; only a subject that states it now is that unit.
  const candidates = (await readNamedRecords(tx, 'system.unit', 'unit_name', unitId))
    .filter(row => row.values['unit_name'] === unitId)
    .filter(row => generation === undefined || number(row.values['generation']) === generation);
  // A replacement closes a generation: the link is written once and never withdrawn (`system.unit-replacement`).
  const replaced = generation === undefined && candidates.length > 0
    ? new Set((await edgeRowsIn(tx, 'system.unit-replacement', 'from', candidates.map(row => row.id))).map(edge => edge.from))
    : new Set<number>();
  const current = candidates.filter(row => !replaced.has(row.id));
  if(current.length > 1) raise(`graph system.unit: ambiguous generation of ${unitId}`);
  return current[0];
}
/** The run's own record, by its name: what a read that starts from a run begins with. */
export async function readRunNodeIn(tx: SqlExecutor, runId: string): Promise<AssertionRecord | undefined> { return await runNode(tx, runId); }
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
  const node = (await readNamedRecords(tx, 'system.chain', 'product_name', product)).find(row => row.values['product_name'] === product);
  if (!node) return null;
  // The chain's own edges: the run it follows, and the runs it has made.
  const active = await withSpan('graph.fill.activeRun', {}, async () => (await tx.query<{to_node:string}>(`SELECT e.to_node::text AS to_node FROM edge e JOIN entity k ON k.id=e.entity_id
    WHERE k.name='system.chain-active-run' AND e.from_node=$1::bigint AND graph_edge_active(e.id,k.name,1) ORDER BY e.id LIMIT 1`, [node.id])).rows[0]);
  const run = active === undefined ? undefined : (await readRecordsIn(tx, 'vertex', 'system.run', ['run_name'], [Number(active.to_node)]))[0];
  return {node, record: chainRecord(node, run === undefined ? null : text(run.values['run_name']))};
}
async function selection(tx: SqlExecutor, run: AssertionRecord): Promise<RunSelection | undefined> {
  if (run.values['has_selection'] !== true) return undefined;
  const edges = await edgeRowsIn(tx, 'system.run-selection-run', 'to', [run.id]);
  const entries = (await readRecordsIn(tx, 'vertex', 'system.run-selection', ['role','position','name','group_name','plugin_name','stage_unit_name'], edges.map(edge => edge.from))).sort((a,b) => number(a.values['position']) - number(b.values['position']));
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
  return {runId: text(v['run_name']), product: text(v['product_name']), state: requireState(RUN_STATES,v['state'],'system.run',row.uid), context, createdAt:number(v.created_at),updatedAt:number(v['updated_at'])};
}
async function unitRecord(tx: SqlExecutor, row: AssertionRecord): Promise<UnitRecord> {
  const link = (await edgeRowsIn(tx, 'system.unit-run', 'from', [row.id]))[0];
  const run = link === undefined ? undefined : (await readRecordsIn(tx, 'vertex', 'system.run', ['run_name'], [link.to]))[0];
  if (!run) raise(`graph system.unit, vertex ${row.uid}: no owning run`);
  const v = row.values, generation = number(v['generation']);
  return {unitId:text(v['unit_name']),product:text(v['product_name']),runId:text(run.values['run_name']),stageId:text(v['stage_name']),scopeKey:text(v.scope),generation,
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
    await bindFillStateIn(tx);
    // The chain's own edges: the run it followed, and the runs it has made.
    for(const held of await edgeRowsIn(tx,'system.chain-active-run','from',[current.node.id])){
      const target=(await readRecordsIn(tx,'vertex','system.run',['run_name'],[held.to]))[0];
      if(target===undefined)raise(`graph system.run: no run at the chain's active edge ${String(held.to)}`);
      await publishGraphDrafts(tx,contract,{vertices:[],removals:[],edgeRemovals:[{...fillEdge('system.chain-active-run','system.chain',current.node.uid,'system.run',target.uid)}]});
    }
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
/** A product's runs, from its chain: the chain names its runs by its own edges (0039.25). */
async function productRuns(tx: SqlExecutor, product: string): Promise<RunRecord[]> {
  const chain = (await readNamedRecords(tx, 'system.chain', 'product_name', product)).find(row => row.values['product_name'] === product);
  if (chain === undefined) return [];
  const edges = await edgeRowsIn(tx, 'system.chain-run', 'from', [chain.id]);
  const runs = await readRecordsIn(tx, 'vertex', 'system.run', fields.run, edges.map(edge => edge.to));
  return await Promise.all(runs.filter(row => row.values['product_name'] === product).map(row => runRecord(tx, row)));
}
const newest=(a:RunRecord,b:RunRecord):number=>b.createdAt-a.createdAt||byCodePoint(b.runId,a.runId);
export async function readRuns(database:FillStateSnapshotDatabase,product:string):Promise<readonly RunRecord[]>{return await snapshotRun(here(),database,`readRuns(${product})`,async tx=>(await productRuns(tx,product)).sort(newest));}
export async function readLatestRun(database:FillStateSnapshotDatabase,product:string):Promise<RunRecord|null>{return (await readRuns(database,product))[0]??null;}
const LIVE_RUN_STATES: readonly RunState[] = ['created','planning','running','pausing','cancelling'];
export async function readLiveRun(database:FillStateSnapshotDatabase,product:string):Promise<RunRecord|null>{return await snapshotRun(here(),database,'readLiveRun',async tx=>(await productRuns(tx,product)).filter(r=>LIVE_RUN_STATES.includes(r.state)).sort(newest)[0]??null);}
/** Whether a run of this product has ever succeeded: the chain's runs, never every run of the store. */
export async function hasSuccessfulFill(database:FillStateSnapshotDatabase,product:string):Promise<boolean>{return await snapshotRun(here(),database,'hasSuccessfulFill',async tx=>(await productRuns(tx,product)).some(r=>r.state==='succeeded'));}
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
async function recordsOfUnits(tx:SqlExecutor,ids:readonly number[],currentOnly:boolean):Promise<UnitRecord[]>{
  const all=await readRecordsIn(tx,'vertex','system.unit',fields.unit,ids);
  // A replacement closes a generation: the link is written once and never withdrawn (`system.unit-replacement`).
  const replaced = currentOnly && all.length > 0 ? new Set((await edgeRowsIn(tx,'system.unit-replacement','from',all.map(row=>row.id))).map(edge=>edge.from)) : new Set<number>();
  return (await Promise.all(all.filter(row=>!replaced.has(row.id)).map(row=>unitRecord(tx,row)))).sort((a,b)=>byCodePoint(a.unitId,b.unitId)||a.generation-b.generation);
}
/** A run's units, from the run: its own `system.unit-run` edges name them. */
export async function readRunUnitsIn(tx:SqlExecutor,runId:string,currentOnly=true):Promise<readonly UnitRecord[]>{
  const run = await runNode(tx, runId); if (run === undefined) return [];
  return await recordsOfUnits(tx, (await edgeRowsIn(tx,'system.unit-run','to',[run.id])).map(edge=>edge.from), currentOnly);
}
export async function readRunUnits(database:FillStateSnapshotDatabase,runId:string):Promise<readonly UnitRecord[]>{return await snapshotRun(here(),database,`readRunUnits(${runId})`,tx=>readRunUnitsIn(tx,runId));}
export async function readRunUnitHistory(database:FillStateSnapshotDatabase,runId:string):Promise<readonly UnitRecord[]>{return await snapshotRun(here(),database,`readRunUnitHistory(${runId})`,tx=>readRunUnitsIn(tx,runId,false));}
/**
 * A product's units in one state. No subject names this set — the product's units are not one node's edges —
 * so it reads the kind; it is not on the fill service's poll path (madarch-64o5.74 leaves `prepare-store.ts:40`
 * and the whole-kind product reads aside).
 */
export async function readProductUnits(database:FillStateSnapshotDatabase,options:{readonly product:string;readonly state:UnitState}):Promise<readonly UnitRecord[]>{
  return await snapshotRun(here(),database,`readProductUnits(${options.product})`,async tx=>{
    const all=await rows(tx,'unit');
    const replaced=new Set((await edgeRowsIn(tx,'system.unit-replacement','from',all.map(row=>row.id))).map(edge=>edge.from));
    const current=all.filter(row=>!replaced.has(row.id));
    return (await Promise.all(current.map(row=>unitRecord(tx,row)))).filter(r=>r.product===options.product&&r.state===options.state).sort((a,b)=>byCodePoint(a.unitId,b.unitId)||a.generation-b.generation);
  });
}
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
