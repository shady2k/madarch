/** Host-issued authority for the graph writer. No serialized object is a capability. */
import { databaseOwnerOf, type DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { withSpan } from '../obs/trace.js';
import { withAssertionContract } from './system-contract.js';
import { graphContractVersion } from './contract.js';
import { newUid } from './uid.js';
import { acquireGraphWriteLock, bootstrapWriteIdentity, writeAssertion, bindWriteCapability, type WriteCapability } from './write.js';

const WHERE = `${import.meta.path}:1`;
declare const principalBrand: unique symbol;
declare const bindingBrand: unique symbol;
export interface GraphPrincipal { readonly [principalBrand]: true; readonly producer: string; readonly version: string; readonly uid: string; readonly kind: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
export interface ProducerBinding { readonly [bindingBrand]: true; readonly producer: string; readonly version: string; readonly sourceUid: string; readonly contextId: number; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
interface PrincipalState { readonly owner: DatabaseOwner; readonly productUid: string; readonly producer: string; readonly version: string; readonly uid: string; readonly kind: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
export const MERGE_ACTION:ProducerAction='merge';
export type ProducerAction = 'assert' | 'retract-own' | 'resolve' | 'merge';
interface BindingState { readonly actions: ReadonlySet<ProducerAction>; readonly owner: DatabaseOwner; readonly contract: string; readonly principal: PrincipalState; readonly contextId: number; readonly scope: string; readonly vertices: ReadonlyMap<string, ReadonlySet<string>>; readonly edges: ReadonlyMap<string, ReadonlySet<string>> }
function contractFingerprint(contract: GraphContract): string {
  return JSON.stringify(withAssertionContract(contract), (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}

const OWNER_ID = new WeakMap<DatabaseOwner, DatabaseOwner>();
const PRINCIPALS = new WeakMap<object, PrincipalState>();
const BINDINGS = new WeakMap<object, BindingState>();

/** Called only by the host after installation; the source must actually stand in this graph. */
export async function registerGraphPrincipal(owner: DatabaseOwner, input: { readonly producer: string; readonly version: string; readonly uid: string; readonly kind: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }): Promise<GraphPrincipal> {
  return await withSpan('graph.source.register', {}, async () => {
    if (!input.producer || !input.version || !input.scope || input.uid !== input.sourceUid) throw new Error(`${WHERE}: a retained principal names its producer and version`);
    if (!['source', 'person', 'plugin', 'agent', 'agent-session'].includes(input.kind)) throw new Error(`${WHERE}: ${input.kind} is not a source or principal kind`);
    const found = await owner.run(async tx => {
      const actual = databaseOwnerOf(tx);
      if (actual === undefined) throw new Error(`${WHERE}: principal registration requires a host database owner`);
      OWNER_ID.set(owner, actual);
      return await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND graph_vertex_active(n.id,e.name,1)`, [input.uid, input.kind]);
    });
    if (found.rows.length !== 1) throw new Error(`${WHERE}: source ${input.kind}/${input.uid} is not retained in this product`);
    const products = await owner.run(async tx => await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.product' AND graph_vertex_active(n.id,k.name,1) ORDER BY n.uid"));
    if (products.rows.length !== 1) throw new Error(`${WHERE}: principal registration requires exactly one retained product`);
    const productUid = products.rows[0]!.uid;
    const author = await owner.run(async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND graph_vertex_active(n.id,e.name,1) AND (e.name IN ('person', 'agent-session') OR ($2::boolean AND e.name = $3))`, [input.principalUid, input.principalUid === input.sourceUid, input.kind]));
    if (author.rows.length !== 1) throw new Error(`${WHERE}: principal ${input.principalUid} is not retained in this product`);
    if (input.sessionUid !== undefined) {
      const session = await owner.run(async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = 'agent-session' AND graph_vertex_active(n.id,e.name,1)`, [input.sessionUid]));
      if (session.rows.length !== 1) throw new Error(`${WHERE}: execution session ${input.sessionUid} is not retained in this product`);
    }
    const token = Object.freeze({ ...input }) as unknown as GraphPrincipal;
    PRINCIPALS.set(token, { owner: OWNER_ID.get(owner) ?? owner, productUid, ...input });
    return token;
  });
}

/** A host binds a retained principal to one product contract, context and explicit property scope. */
export function bindGraphProducer(owner: DatabaseOwner, contract: GraphContract, input: { readonly principal: GraphPrincipal; readonly vertices: Readonly<Record<string, readonly string[]>>; readonly edges: Readonly<Record<string, readonly string[]>>; readonly contextId?: number; readonly scopeUid?: string; readonly actions?: readonly ProducerAction[] }): ProducerBinding {
  const principal = PRINCIPALS.get(input.principal);
  if (principal === undefined || principal.owner !== (OWNER_ID.get(owner) ?? owner)) throw new Error(`${WHERE}: a binding requires the host's retained principal for this product`);
  const permissions = (sort: 'vertex' | 'edge', values: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, ReadonlySet<string>> => new Map(Object.entries(values).flatMap(([name, fields]): [string, ReadonlySet<string>][] => {
    const kind = contract[sort].find(held => held.name === name);
    if (kind === undefined) throw new Error(`${WHERE}: undeclared ${sort} permission ${name}`);
    // A kind of a reserved capability is the engine's own metadata, written by the source serving it alone: a plugin
    // or a person never holds it as a slot, whatever the grant asked for.
    if (kind.reservedCapability === true) return [];
    for (const field of fields) if (!kind.fields.some(held => held.name === field)) throw new Error(`${WHERE}: undeclared property permission ${name}.${field}`);
    return [[name, new Set([...('key' in kind ? kind.key : []), ...fields])]];
  }));
  const contextId = input.contextId ?? 1;
  const scope = input.scopeUid ?? principal.productUid;
  if (scope.length !== 36 || [...scope].some((point, index) => [8, 13, 18, 23].includes(index) ? point !== '-' : !'0123456789abcdef'.includes(point))) throw new Error(`${WHERE}: permission scope must be a graph uid`);
  const state = { actions: new Set<ProducerAction>(input.actions ?? ['assert', 'retract-own']), owner: OWNER_ID.get(owner) ?? owner, contract: contractFingerprint(contract), principal, contextId, scope, vertices: permissions('vertex', input.vertices), edges: permissions('edge', input.edges) };
  const token = Object.freeze({ producer: principal.producer, version: principal.version, sourceUid: principal.sourceUid, principalUid: principal.principalUid, scope, ...(principal.sessionUid === undefined ? {} : { sessionUid: principal.sessionUid }), contextId }) as unknown as ProducerBinding;
  BINDINGS.set(token, state);
  return token;
}

/** Authenticate even an empty publication: journal-only writes still require authority. */
export function requirePublicationBinding(executor: SqlExecutor, contract: GraphContract, binding: ProducerBinding | undefined, contextId: number): ProducerBinding {
  const state = binding === undefined ? undefined : BINDINGS.get(binding);
  if (state === undefined || binding === undefined) throw new Error(`${WHERE}: a graph write requires a host-issued source binding`);
  if (state.owner !== databaseOwnerOf(executor)) throw new Error(`${WHERE}: source binding belongs to another product`);
  if (state.contract !== contractFingerprint(contract)) throw new Error(`${WHERE}: source binding belongs to another contract`);
  if (state.contextId !== contextId) throw new Error(`${WHERE}: source binding belongs to another context`);
  return binding;
}

export function requireProducerAction(binding: ProducerBinding, action: ProducerAction): void {
  const state = BINDINGS.get(binding);
  if (state === undefined || !state.actions.has(action)) throw new Error(`${WHERE}: source binding does not permit ${action}`);
}

/** Check before any statement, including declarations and removals. */
export function requireProducerBinding(executor: SqlExecutor, contract: GraphContract, binding: ProducerBinding | undefined, contextId: number, sort: 'vertex' | 'edge', kind: string, fields: readonly string[] = [], producer?: string, version?: string, action: ProducerAction = 'assert'): void {
  const state = binding === undefined ? undefined : BINDINGS.get(binding);
  if (state === undefined) throw new Error(`${WHERE}: a graph write requires a host-issued source binding`);
  if (state.owner !== databaseOwnerOf(executor)) throw new Error(`${WHERE}: source binding belongs to another product`);
  if (state.contract !== contractFingerprint(contract)) throw new Error(`${WHERE}: source binding belongs to another contract`);
  if (state.contextId !== contextId) throw new Error(`${WHERE}: source binding belongs to another context`);
  if ((producer !== undefined && producer !== state.principal.producer) || (version !== undefined && version !== state.principal.version)) throw new Error(`${WHERE}: caller producer differs from its host-issued source binding`);
  if (!state.actions.has(action)) throw new Error(`${WHERE}: source binding does not permit ${action}`);
  const permitted = (sort === 'vertex' ? state.vertices : state.edges).get(kind);
  if (permitted === undefined) throw new Error(`${WHERE}: source cannot write ${sort} ${kind}`);
  for (const field of fields) if (!permitted.has(field)) throw new Error(`${WHERE}: source cannot write property ${kind}.${field}`);
}

/** Display identity only after authenticating the host token. */
export function producerIdentityOf(binding: ProducerBinding): { readonly producer: string; readonly version: string; readonly kind: string; readonly uid: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string } {
  const state = BINDINGS.get(binding);
  if (state === undefined) throw new Error(`${WHERE}: a graph write requires a host-issued source binding`);
  return { producer: state.principal.producer, version: state.principal.version, kind: state.principal.kind, uid: state.principal.uid, sourceUid: state.principal.sourceUid, principalUid: state.principal.principalUid, scope: state.scope, ...(state.principal.sessionUid === undefined ? {} : { sessionUid: state.principal.sessionUid }) };
}

/** Activate only a retained host grant on its own transaction; serialized copies have no authority. */
export async function activateGraphProducer(executor: SqlExecutor, contract: GraphContract, binding: ProducerBinding, contextId = 1): Promise<WriteCapability> {
  return await withSpan('graph.source.activate', {}, async () => {
    requirePublicationBinding(executor, contract, binding, contextId);
    const state = BINDINGS.get(binding)!;
    const scope = await executor.query("SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid::text=$1 AND graph_vertex_active(n.id,k.name,$2::bigint)", [state.scope, contextId]);
    if (scope.rows.length !== 1) throw new Error(`${WHERE}: permission scope ${state.scope} is not retained in this product`);
    const permissions = [...state.vertices, ...state.edges].map(([kind, fields]) => ({ kind, properties: ['$exists', ...fields], assert: state.actions.has('assert'), retractOwn: state.actions.has('retract-own') }));
    await acquireGraphWriteLock(executor);
    const products = (await executor.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.product' AND graph_vertex_active(n.id,k.name,1) ORDER BY n.uid")).rows;
    if (products.length !== 1) throw new Error(`${WHERE}: activation requires exactly one retained product`);
    for (const uid of new Set([state.principal.sourceUid, state.principal.principalUid])) {
      const retained = await executor.query("SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid AND graph_vertex_active(n.id,k.name,$2::bigint)", [uid, contextId]);
      if (retained.rows.length !== 1) throw new Error(`${WHERE}: authenticated source or principal ${uid} is no longer active`);
    }
    const productUid = products[0]!.uid;
    const operationUid = newUid();
    await bootstrapWriteIdentity(executor, 'system.operation', operationUid, productUid, contextId);
    const capability: WriteCapability = { productUid, operationUid, sourceUid: state.principal.sourceUid, principalUid: state.principal.principalUid, context: contextId, scope: state.scope, contractVersion: graphContractVersion(withAssertionContract(contract)), capability: state.principal.producer, permissions };
    bindWriteCapability(executor, { ...capability, permissions: [{ kind: 'system.operation', properties: ['$exists'], assert: true, retractOwn: false }] });
    const operation = (await executor.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid=$1::uuid', [operationUid])).rows[0]!;
    await writeAssertion(executor, contract, { sort: 'vertex', kind: 'system.operation', subjectId: operation.id, property: '$exists', operation: 'assert', value: true }, contextId);
    bindWriteCapability(executor, capability);
    return capability;
  });
}
