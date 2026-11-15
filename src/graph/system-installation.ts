/** Host installation identities are retained graph vertices, never client producer labels. */
import { withSpan } from '../obs/trace.js';
import { createHash, randomBytes } from 'node:crypto';
import { generatedTableName } from './contract.js';
import { homedir, userInfo } from 'node:os';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, VertexDraft, EdgeDraft } from './contract.js';
import { SYSTEM_CONTRACT, withSystemContract } from './system-contract.js';
import { installSystemGraphDrafts } from './write.js';
import { registerGraphPrincipal, bindGraphProducer, type GraphPrincipal, type ProducerBinding } from './producer-binding.js';
export { SYSTEM_CONTRACT, withSystemContract } from './system-contract.js';

export interface InstalledSource {
  readonly producer: string;
  readonly version: string;
  readonly kind: string;
  readonly uid: string;
  readonly sourceUid: string;
  readonly principal: GraphPrincipal;
}
function installationUid(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function identity(parts: readonly string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function localIdentity(): string { return identity([String(userInfo().uid), homedir()]); }
async function install(owner: DatabaseOwner, contract: GraphContract, kind: string, key: string, values: Record<string, string>, links: readonly EdgeDraft[] = []): Promise<string> {
  return await withSpan('graph.system.install', { 'graph.system.kind': kind }, async () => await owner.transaction('write', async (tx) => await withSpan('graph.system.install.transaction', {}, async () => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`system-installation:${kind}:${key}`]);
    const found = await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id JOIN "${generatedTableName(kind, 'vertex')}" p ON p.node_id = n.id WHERE e.name = $1 AND p.installation = $2 AND p.state = 'open' AND n.context_id = 1 AND NOT n.removed`, [kind, key]);
    const uid = found.rows[0]?.uid ?? installationUid();
    const draft: VertexDraft = { kind, key: {}, uid, values: { installation: key, ...values }, selectedFields: Object.keys({ installation: key, ...values }), producer: 'system', producerVersion: '1' };
    await installSystemGraphDrafts(tx, contract, { vertices: [draft], edges: links });
    return uid;
  })));
}
export async function registerSystemSource(owner: DatabaseOwner, contract: GraphContract, options: {
  readonly type: 'plugin' | 'agent' | 'system'; readonly installationKey: string; readonly scope: string;
  readonly version: string; readonly label?: string; readonly principalUid?: string;
}): Promise<InstalledSource> {
  return await withSpan('graph.system.source', { 'graph.source.type': options.type }, async () => {
  const kind = options.type === 'system' ? 'source' : options.type;
  const key = identity([kind, options.installationKey, options.scope]);
  const uid = await install(owner, contract, kind, key, { label: options.label ?? options.installationKey, version: options.version, scope: options.scope });
  if (options.principalUid !== undefined) {
    await owner.transaction('write', async (tx) => await withSpan('graph.system.principal', {}, async () => {
      const person = await tx.query<{ key: Record<string, string> }>("SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = 'person' AND n.context_id = 1 AND NOT n.removed", [options.principalUid]);
      if (person.rows[0] === undefined) throw new Error(`${import.meta.path}:1: source principal ${options.principalUid} does not resolve`);
      await installSystemGraphDrafts(tx, contract, { edges: [{ kind: 'source-principal', from: { kind, key: {}, uid }, to: { kind: 'person', key: {}, uid: options.principalUid }, producer: 'system', producerVersion: '1' }] });
    }));
  }
  const producer = options.type === 'system' || options.type === 'plugin' ? options.installationKey : `${kind}:${uid}`;
  const principal = await registerGraphPrincipal(owner, { producer, version: options.version, kind, uid, sourceUid: uid, principalUid: options.principalUid ?? uid, scope: options.scope });
  return { producer, version: options.version, kind, uid, sourceUid: uid, principal };
  });
}
export async function installSystemSources(owner: DatabaseOwner, contract: GraphContract): Promise<{ system: InstalledSource; person: InstalledSource }> {
  const system = await registerSystemSource(owner, contract, { type: 'system', installationKey: 'madarch', scope: owner.location, version: '1', label: 'Madarch' });
  const uid = await install(owner, contract, 'person', localIdentity(), { label: userInfo().username, scope: 'local-unverified', version: '1' });
  const producer = `person:${uid}`;
  const principal = await registerGraphPrincipal(owner, { producer, version: '1', kind: 'person', uid, sourceUid: uid, principalUid: uid, scope: 'local-unverified' });
  return { system, person: { producer, version: '1', kind: 'person', uid, sourceUid: uid, principal } };
}
export async function installAgentSession(owner: DatabaseOwner, contract: GraphContract, session: string): Promise<InstalledSource & { sessionUid: string }> {
  const { person } = await installSystemSources(owner, contract);
  const agent = await registerSystemSource(owner, contract, { type: 'agent', installationKey: `${person.uid}:mcp`, scope: owner.location, version: '1', label: 'Local MCP agent', principalUid: person.uid });
  const key = identity([agent.uid, session]);
  const sessionUid = await install(owner, contract, 'agent-session', key, { label: session, scope: owner.location, version: '1' });
  await owner.transaction('write', async (tx) => await installSystemGraphDrafts(tx, contract, { edges: [{ kind: 'session-agent', from: { kind: 'agent-session', key: {}, uid: sessionUid }, to: { kind: 'agent', key: {}, uid: agent.uid }, producer: 'system', producerVersion: '1' }] }));
  const principal = await registerGraphPrincipal(owner, { producer: agent.producer, version: agent.version, kind: agent.kind, uid: agent.uid, sourceUid: agent.uid, principalUid: person.uid, scope: owner.location, sessionUid });
  return { ...agent, principal, sessionUid };
}
function writableSlots(contract: GraphContract): { vertices: Record<string, readonly string[]>; edges: Record<string, readonly string[]> } {
  const vertices = contract.vertex.flatMap((kind) => {
    const base = SYSTEM_CONTRACT.vertex.find((system) => system.name === kind.name);
    const fields = kind.fields.filter((field) => !base?.fields.some((system) => system.name === field.name)).map((field) => field.name);
    return base !== undefined && fields.length === 0 ? [] : [[kind.name, fields] as const];
  });
  return { vertices: Object.fromEntries(vertices),
    edges: Object.fromEntries(contract.edge.filter((kind) => !SYSTEM_CONTRACT.edge.some((system) => system.name === kind.name)).map((kind) => [kind.name, kind.fields.map((field) => field.name)])) };
}
const BUILTIN_BINDINGS = new WeakMap<DatabaseOwner, Map<string, ProducerBinding>>();
export async function builtinBinding(owner: DatabaseOwner, contract: GraphContract, producer: string): Promise<ProducerBinding> {
  const key = JSON.stringify([producer, contract], (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const held = BUILTIN_BINDINGS.get(owner);
  const existing = held?.get(key);
  if (existing !== undefined) return existing;
  const installed = await registerSystemSource(owner, withSystemContract(contract), { type: 'system', installationKey: producer, scope: owner.location, version: '1' });
  const binding = bindGraphProducer(owner, contract, { principal: installed.principal, ...writableSlots(contract) });
  const bindings = held ?? new Map<string, ProducerBinding>();
  bindings.set(key, binding);
  BUILTIN_BINDINGS.set(owner, bindings);
  return binding;
}
export async function personBinding(owner: DatabaseOwner, contract: GraphContract, _description?: { readonly name?: string; readonly email?: string }): Promise<ProducerBinding> {
  const { person } = await installSystemSources(owner, withSystemContract(contract));
  return bindGraphProducer(owner, contract, { principal: person.principal, ...writableSlots(contract) });
}
