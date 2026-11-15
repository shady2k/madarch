/** Host-issued authority for the graph writer. No serialized object is a capability. */
import { databaseOwnerOf, type DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { withSpan } from '../obs/trace.js';
import { SYSTEM_CONTRACT } from './system-contract.js';

const WHERE = 'src/graph/producer-binding.ts:1';
declare const principalBrand: unique symbol;
declare const bindingBrand: unique symbol;
export interface GraphPrincipal { readonly [principalBrand]: true; readonly producer: string; readonly version: string; readonly uid: string; readonly kind: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
export interface ProducerBinding { readonly [bindingBrand]: true; readonly producer: string; readonly version: string; readonly sourceUid: string; readonly contextId: number; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
interface PrincipalState { readonly owner: DatabaseOwner; readonly producer: string; readonly version: string; readonly uid: string; readonly kind: string; readonly sourceUid: string; readonly principalUid: string; readonly scope: string; readonly sessionUid?: string }
export type ProducerAction = 'assert' | 'retract-own' | 'resolve' | 'merge';
interface BindingState { readonly actions: ReadonlySet<ProducerAction>; readonly owner: DatabaseOwner; readonly contract: string; readonly principal: PrincipalState; readonly contextId: number; readonly vertices: ReadonlyMap<string, ReadonlySet<string>>; readonly edges: ReadonlyMap<string, ReadonlySet<string>> }
function contractFingerprint(contract: GraphContract): string {
  return JSON.stringify(contract, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
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
      return await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND NOT n.removed`, [input.uid, input.kind]);
    });
    if (found.rows.length !== 1) throw new Error(`${WHERE}: source ${input.kind}/${input.uid} is not retained in this product`);
    const author = await owner.run(async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND NOT n.removed AND (e.name IN ('person', 'agent-session') OR ($2::boolean AND e.name = $3))`, [input.principalUid, input.principalUid === input.sourceUid, input.kind]));
    if (author.rows.length !== 1) throw new Error(`${WHERE}: principal ${input.principalUid} is not retained in this product`);
    if (input.sessionUid !== undefined) {
      const session = await owner.run(async tx => await tx.query(`SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = 'agent-session' AND NOT n.removed`, [input.sessionUid]));
      if (session.rows.length !== 1) throw new Error(`${WHERE}: execution session ${input.sessionUid} is not retained in this product`);
    }
    const token = Object.freeze({ ...input }) as unknown as GraphPrincipal;
    PRINCIPALS.set(token, { owner: OWNER_ID.get(owner) ?? owner, ...input });
    return token;
  });
}

/** A host binds a retained principal to one product contract, context and explicit property scope. */
export function bindGraphProducer(owner: DatabaseOwner, contract: GraphContract, input: { readonly principal: GraphPrincipal; readonly vertices: Readonly<Record<string, readonly string[]>>; readonly edges: Readonly<Record<string, readonly string[]>>; readonly contextId?: number; readonly actions?: readonly ProducerAction[] }): ProducerBinding {
  const principal = PRINCIPALS.get(input.principal);
  if (principal === undefined || principal.owner !== (OWNER_ID.get(owner) ?? owner)) throw new Error(`${WHERE}: a binding requires the host's retained principal for this product`);
  const permissions = (sort: 'vertex' | 'edge', values: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, ReadonlySet<string>> => new Map(Object.entries(values).map(([name, fields]) => {
    const kind = contract[sort].find(held => held.name === name);
    if (kind === undefined) throw new Error(`${WHERE}: undeclared ${sort} permission ${name}`);
    for (const field of fields) if (!kind.fields.some(held => held.name === field)) throw new Error(`${WHERE}: undeclared property permission ${name}.${field}`);
    return [name, new Set(fields)];
  }));
  const contextId = input.contextId ?? 1;
  const state = { actions: new Set<ProducerAction>(input.actions ?? ['assert', 'retract-own']), owner: OWNER_ID.get(owner) ?? owner, contract: contractFingerprint(contract), principal, contextId, vertices: permissions('vertex', input.vertices), edges: permissions('edge', input.edges) };
  const token = Object.freeze({ producer: principal.producer, version: principal.version, sourceUid: principal.sourceUid, principalUid: principal.principalUid, scope: principal.scope, ...(principal.sessionUid === undefined ? {} : { sessionUid: principal.sessionUid }), contextId }) as unknown as ProducerBinding;
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
  return { producer: state.principal.producer, version: state.principal.version, kind: state.principal.kind, uid: state.principal.uid, sourceUid: state.principal.sourceUid, principalUid: state.principal.principalUid, scope: state.principal.scope, ...(state.principal.sessionUid === undefined ? {} : { sessionUid: state.principal.sessionUid }) };
}

export function graphProducerOf(binding: ProducerBinding): { readonly producer: string; readonly version: string } {
  return producerIdentityOf(binding);
}

/** Only the host's installer uses this bounded capability to bootstrap retained identities. */
export function issueSystemBootstrapBinding(owner: DatabaseOwner, contract: GraphContract): ProducerBinding {
  for (const sort of ['vertex', 'edge'] as const) for (const kind of SYSTEM_CONTRACT[sort]) {
    const held = contract[sort].find(candidate => candidate.name === kind.name);
    const baseFieldsStand = kind.fields.every(field => held?.fields.some(candidate => JSON.stringify(candidate) === JSON.stringify(field)));
    if (held === undefined || !baseFieldsStand || JSON.stringify({ ...held, fields: kind.fields }) !== JSON.stringify(kind)) throw new Error(`${WHERE}: bootstrap requires canonical system ${sort} ${kind.name}`);
  }
  const principal = Object.freeze({ producer: 'system', version: '1', uid: '', kind: 'source', sourceUid: '', principalUid: '', scope: 'system-installation' }) as unknown as GraphPrincipal;
  PRINCIPALS.set(principal, { owner, producer: 'system', version: '1', uid: '', kind: 'source', sourceUid: '', principalUid: '', scope: 'system-installation' });
  return bindGraphProducer(owner, contract, { principal,
    vertices: Object.fromEntries(SYSTEM_CONTRACT.vertex.filter(kind => ['source', 'person', 'plugin', 'agent', 'agent-session'].includes(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])),
    edges: Object.fromEntries(SYSTEM_CONTRACT.edge.map(kind => [kind.name, kind.fields.map(field => field.name)])),
  });
}
