/** Host installation identities are retained graph vertices, never client producer labels. */
import { withSpan } from '../obs/trace.js';
import { createHash, randomBytes } from 'node:crypto';
import { startupBinding } from './manifest-publication.js';
import { installDisputeSelection, refreshDisputeSelection } from './disputes.js';
import { readKindAssertions } from './records.js';
import { publishGraphDrafts } from './write.js';
import { homedir, userInfo } from 'node:os';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { SYNONYMS_FIELD, type GraphContract, type VertexDraft, type EdgeDraft } from './contract.js';
import { withSystemContract, withAssertionContract } from './system-contract.js';
import { registerGraphPrincipal, bindGraphProducer, type GraphPrincipal, type ProducerBinding } from './producer-binding.js';
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
    await installDisputeSelection(tx, withAssertionContract(contract));
    const installed = await startupBinding(tx, contract, 'system-installation');
    const now = (await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const found = (await readKindAssertions(tx, 'vertex', kind, ['installation'], { validAt: now, recordedAt: now })).filter(record => record.values['installation'] === key);
    if (found.length > 1) throw new Error(`${import.meta.path}:37: duplicate retained ${kind} installation ${key}`);
    const uid = found[0]?.uid ?? installationUid();
    const draft: VertexDraft = { kind, key: {}, uid, values: { installation: key, ...values }, selectedFields: Object.keys({ installation: key, ...values }), producer: 'system', producerVersion: '1' };
    await publishGraphDrafts(tx, installed.contract, { vertices: [draft], edges: links, removals: [] });
    await refreshDisputeSelection(tx, installed.contract);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
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
      await installDisputeSelection(tx, withAssertionContract(contract));
      const person = await tx.query<{ key: Record<string, string> }>("SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = 'person' AND n.context_id = 1 AND graph_vertex_active(n.id,e.name,1)", [options.principalUid]);
      if (person.rows[0] === undefined) throw new Error(`${import.meta.path}:1: source principal ${options.principalUid} does not resolve`);
      const installed = await startupBinding(tx, contract, 'system-installation');
      await publishGraphDrafts(tx, installed.contract, { vertices: [], removals: [], edges: [{ kind: 'source-principal', from: { kind, key: {}, uid }, to: { kind: 'person', key: {}, uid: options.principalUid }, producer: 'system', producerVersion: '1' }] });
      await refreshDisputeSelection(tx, installed.contract);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
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
  await owner.transaction('write', async (tx) => await withSpan('graph.system.session', {}, async () => {
    await installDisputeSelection(tx, withAssertionContract(contract));
    const installed = await startupBinding(tx, contract, 'system-installation');
    await publishGraphDrafts(tx, installed.contract, { vertices: [], removals: [], edges: [{ kind: 'session-agent', from: { kind: 'agent-session', key: {}, uid: sessionUid }, to: { kind: 'agent', key: {}, uid: agent.uid }, producer: 'system', producerVersion: '1' }] });
    await refreshDisputeSelection(tx, installed.contract);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  }));
  const principal = await registerGraphPrincipal(owner, { producer: agent.producer, version: agent.version, kind: agent.kind, uid: agent.uid, sourceUid: agent.uid, principalUid: person.uid, scope: owner.location, sessionUid });
  return { ...agent, principal, sessionUid };
}
function writableSlots(declared: GraphContract): { vertices: Record<string, readonly string[]>; edges: Record<string, readonly string[]> } {
  // The contract the write is checked against: the system's own kinds and the fields every entity holds are in it.
  const contract = withAssertionContract(declared);
  const protectedContract = withAssertionContract({ vertex: [], edge: [], dictionary: [] });
  const vertices = contract.vertex.flatMap((kind) => {
    const base = protectedContract.vertex.find((system) => system.name === kind.name);
    // The common synonyms field the system gives every entity is the entity's own names, so a source states it (0039 item 6).
    const fields = kind.fields.filter((field) => field.name === SYNONYMS_FIELD || !base?.fields.some((system) => system.name === field.name)).map((field) => field.name);
    return base !== undefined && fields.length === 0 ? [] : [[kind.name, fields] as const];
  });
  return { vertices: Object.fromEntries(vertices),
    edges: Object.fromEntries(contract.edge.filter((kind) => !protectedContract.edge.some((system) => system.name === kind.name)).map((kind) => [kind.name, kind.fields.map((field) => field.name)])) };
}
export async function personBinding(owner: DatabaseOwner, contract: GraphContract, _description?: { readonly name?: string; readonly email?: string }): Promise<ProducerBinding> {
  const { person } = await installSystemSources(owner, withSystemContract(contract));
  return bindGraphProducer(owner, contract, { principal: person.principal, ...writableSlots(contract) });
}

/** The MCP host assigns a stable agent source; client names never select its identity. */
export async function agentBinding(owner: DatabaseOwner, contract: GraphContract, session: string): Promise<ProducerBinding> {
  const agent = await installAgentSession(owner, contract, session);
  return bindGraphProducer(owner, contract, { principal: agent.principal, ...writableSlots(contract) });
}

/** Local host commands receive only their declared operational marker slots. */
export async function personOperationBinding(owner: DatabaseOwner, contract: GraphContract, operation: 'problem-task' | 'authored-import'): Promise<ProducerBinding> {
  const { person } = await installSystemSources(owner, contract);
  const slots = writableSlots(contract);
  const kinds = new Set(operation === 'problem-task'
    ? ['system.problem', 'system.problem-about', 'system.content-snapshot']
    : ['system.authored-import', 'system.authored-import-target', 'system.authored-import-source', 'system.authored-import-product']);
  return bindGraphProducer(owner, contract, {
    principal: person.principal,
    vertices: { ...slots.vertices, ...Object.fromEntries(contract.vertex.filter(kind => kinds.has(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])) },
    edges: { ...slots.edges, ...Object.fromEntries(contract.edge.filter(kind => kinds.has(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])) },
  });
}
