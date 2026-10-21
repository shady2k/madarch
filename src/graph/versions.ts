/**
 * The graph's write path (decision 0028, "Time" and "Reads"): opening a
 * version, correcting one, ending validity with the cascade, and endpoint
 * integrity on insert. Every function takes the transaction it runs in and
 * the recorded instant `at`; none commits.
 *
 * Append-only: a version is never updated except to close its `recorded_to`
 * (with who closed it and why), and never deleted. A correction closes the
 * old version and inserts the versions now believed. The database enforces
 * this too (`graph_append_only` trigger), so a bug here cannot rewrite
 * history.
 */
import type { OuterTransaction } from '../history/types.js';
import { claimDigest as digestOfClaim, edgeKeyHash, edgePayloadDigest, nodePayloadDigest, sha256Hex, type ByteSpan, type ClaimContent, type GraphId } from './digest.js';
import { GraphError, databaseCode, databaseMessage, type GraphOrigin } from './errors.js';
import { ALL_STATES, checkSpan, checkValid, compareInstants, instantText, plusMicrosecond, tsText, type Instant, type StateSpan } from './time.js';
import { CLAIM_KIND, CONTENT_KIND, STATE_KIND } from './vocabulary.js';

/** The transaction a write runs in and the instant it is recorded at. */
export interface WriteContext {
  tx: OuterTransaction;
  /** Canonical recorded instant. */
  at: string;
}

/** Who owns a version: the extraction recipe and the scope node it ran for. */
export interface Owner {
  producer: string;
  scope: GraphId;
}

/**
 * Keeps a close later than the version it closes. Concurrent writers take their
 * recorded instant before they win the lock, so the one that wins second can
 * hold an earlier instant than a version the first just wrote; its close is
 * recorded a microsecond after that version instead, which keeps every range
 * non-empty. An equal instant is not bumped: it means the same publication.
 */
export function laterThan(ctx: WriteContext, recordedFrom: string): void {
  if (compareInstants(ctx.at, recordedFrom) < 0) ctx.at = plusMicrosecond(recordedFrom);
}

/** Why and by which publication a version was closed. */
export interface Closure {
  workItem: GraphId | null;
  as: 'correction' | 'cascade';
}

export interface NodeVersionRow {
  versionId: GraphId;
  nodeId: GraphId;
  kind: string;
  label: string;
  properties: unknown;
  contentSha256: string | null;
  claimDigest: string | null;
  payloadDigest: string;
  validFrom: string;
  validTo: string;
  recordedFrom: string;
  recordedTo: string;
  states: StateSpan;
  producer: string;
  scope: GraphId;
  openedBy: GraphId | null;
  closedBy: GraphId | null;
  closedAs: string | null;
}

export interface EdgeVersionRow {
  versionId: GraphId;
  edgeId: GraphId;
  relation: string;
  src: GraphId;
  dst: GraphId;
  discriminator: string;
  position: ByteSpan | null;
  properties: unknown;
  payloadDigest: string;
  validFrom: string;
  validTo: string;
  recordedFrom: string;
  recordedTo: string;
  states: StateSpan;
  producer: string;
  scope: GraphId;
  openedBy: GraphId | null;
  closedBy: GraphId | null;
  closedAs: string | null;
}

/** Columns of a node version as `NodeVersionRow` reads them, with the table aliased `v` and its kind `k`. */
export const NODE_COLUMNS = `v.id::text AS version_id, v.node_id::text AS node_id, k.key AS kind, v.label, v.properties, v.content_sha256, v.claim_digest, v.payload_digest,
    ${tsText('v.valid_from')} AS valid_from, ${tsText('v.valid_to')} AS valid_to, ${tsText('v.recorded_from')} AS recorded_from, ${tsText('v.recorded_to')} AS recorded_to,
    lower(v.states)::text AS states_from, upper(v.states)::text AS states_to, v.producer, v.scope_id::text AS scope_id,
    v.opened_by::text AS opened_by, v.closed_by::text AS closed_by, v.closed_as`;
export const NODE_FROM = `node_version v JOIN node_kind k ON k.id = v.kind_id`;

/** Columns of an edge version as `EdgeVersionRow` reads them, with the table aliased `e` and its relation `r`. */
export const EDGE_COLUMNS = `e.id::text AS version_id, e.edge_id::text AS edge_id, r.key AS relation, e.src_id::text AS src, e.dst_id::text AS dst, e.discriminator,
    e.byte_start::text AS byte_start, e.byte_end::text AS byte_end, e.properties, e.payload_digest,
    ${tsText('e.valid_from')} AS valid_from, ${tsText('e.valid_to')} AS valid_to, ${tsText('e.recorded_from')} AS recorded_from, ${tsText('e.recorded_to')} AS recorded_to,
    lower(e.states)::text AS states_from, upper(e.states)::text AS states_to, e.producer, e.scope_id::text AS scope_id,
    e.opened_by::text AS opened_by, e.closed_by::text AS closed_by, e.closed_as`;
export const EDGE_FROM = `edge_version e JOIN relation_type r ON r.id = e.relation_type_id`;

type Raw = Record<string, unknown>;

export function nodeRow(raw: Raw): NodeVersionRow {
  return {
    versionId: raw['version_id'] as string,
    nodeId: raw['node_id'] as string,
    kind: raw['kind'] as string,
    label: raw['label'] as string,
    properties: raw['properties'],
    contentSha256: (raw['content_sha256'] as string | null) ?? null,
    claimDigest: (raw['claim_digest'] as string | null) ?? null,
    payloadDigest: raw['payload_digest'] as string,
    validFrom: raw['valid_from'] as string,
    validTo: raw['valid_to'] as string,
    recordedFrom: raw['recorded_from'] as string,
    recordedTo: raw['recorded_to'] as string,
    states: { from: Number(raw['states_from']), to: Number(raw['states_to']) },
    producer: raw['producer'] as string,
    scope: raw['scope_id'] as string,
    openedBy: (raw['opened_by'] as string | null) ?? null,
    closedBy: (raw['closed_by'] as string | null) ?? null,
    closedAs: (raw['closed_as'] as string | null) ?? null,
  };
}

export function edgeRow(raw: Raw): EdgeVersionRow {
  const start = raw['byte_start'] as string | null | undefined;
  return {
    versionId: raw['version_id'] as string,
    edgeId: raw['edge_id'] as string,
    relation: raw['relation'] as string,
    src: raw['src'] as string,
    dst: raw['dst'] as string,
    discriminator: raw['discriminator'] as string,
    position: start === null || start === undefined ? null : { start: Number(start), end: Number(raw['byte_end']) },
    properties: raw['properties'],
    payloadDigest: raw['payload_digest'] as string,
    validFrom: raw['valid_from'] as string,
    validTo: raw['valid_to'] as string,
    recordedFrom: raw['recorded_from'] as string,
    recordedTo: raw['recorded_to'] as string,
    states: { from: Number(raw['states_from']), to: Number(raw['states_to']) },
    producer: raw['producer'] as string,
    scope: raw['scope_id'] as string,
    openedBy: (raw['opened_by'] as string | null) ?? null,
    closedBy: (raw['closed_by'] as string | null) ?? null,
    closedAs: (raw['closed_as'] as string | null) ?? null,
  };
}

/** A decimal identity: refuses anything else before it reaches the database. */
export function checkId(id: string, operation: string, path: string, origin?: GraphOrigin): GraphId {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,17}$/.test(id)) throw new GraphError(operation, path, `${JSON.stringify(id)} is not an identity (a decimal text such as "17")`, origin);
  return id;
}

/** Runs a statement and turns the database's refusals of the graph's invariants into errors that name the part. */
export async function guarded<T>(operation: string, path: string, origin: GraphOrigin | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GraphError) throw error;
    const code = databaseCode(error);
    const text = databaseMessage(error);
    if (code === '23P01') throw new GraphError(operation, path, `no-overlap: the database refused a version that overlaps another version of the same identity on valid time, recorded time and states (${text})`, origin);
    if (code === '23514' || code === '23502') throw new GraphError(operation, path, `the database refused a null or empty range or an invalid column (${text})`, origin);
    if (code === '23503') throw new GraphError(operation, path, `the database refused a reference to something that does not exist (${text})`, origin);
    if (code === 'P0001') throw new GraphError(operation, path, text, origin);
    throw error;
  }
}

export async function kindId(ctx: WriteContext, key: string, operation: string, path: string, origin?: GraphOrigin): Promise<string> {
  const found = await ctx.tx.query<{ id: string }>('SELECT id::text AS id FROM node_kind WHERE key = $1', [key]);
  const row = found.rows[0];
  if (row === undefined) throw new GraphError(operation, path, `the node kind "${key}" is not registered: the engine declares its own keys and the product's registry declares the rest`, origin);
  return row.id;
}

export interface RelationInfo {
  id: string;
  discriminated: boolean;
  positioned: boolean;
}

export async function relationInfo(ctx: WriteContext, key: string, operation: string, path: string, origin?: GraphOrigin): Promise<RelationInfo> {
  const found = await ctx.tx.query<{ id: string; discriminated: boolean; positioned: boolean }>('SELECT id::text AS id, discriminated, positioned FROM relation_type WHERE key = $1', [key]);
  const row = found.rows[0];
  if (row === undefined) throw new GraphError(operation, path, `the relation type "${key}" is not registered: the engine declares its own keys and the product's registry declares the rest`, origin);
  return row;
}

export async function newNodeIdentity(ctx: WriteContext): Promise<GraphId> {
  const made = await ctx.tx.query<{ id: string }>('INSERT INTO node_identity (created_at) VALUES ($1::timestamptz) RETURNING id::text AS id', [ctx.at]);
  return made.rows[0]!.id;
}

/** Refuses an identity that has no row, naming where it was given. */
export async function requireNode(ctx: WriteContext, id: GraphId, operation: string, path: string, origin?: GraphOrigin): Promise<void> {
  const found = await ctx.tx.query('SELECT 1 FROM node_identity WHERE id = $1::bigint', [checkId(id, operation, path, origin)]);
  if (found.rows.length === 0) throw new GraphError(operation, path, `node ${id} does not exist`, origin);
}

/** Locks node identities in ascending order, so a writer ending a node and a writer inserting an edge to it serialise and never deadlock. */
export async function lockNodes(ctx: WriteContext, ids: readonly GraphId[], mode: 'SHARE' | 'UPDATE'): Promise<void> {
  const sorted = [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  if (sorted.length === 0) return;
  await ctx.tx.query(`SELECT id FROM node_identity WHERE id = ANY($1::bigint[]) ORDER BY id FOR ${mode}`, [`{${sorted.join(',')}}`]);
}

export interface NewNodeVersion {
  /** An existing identity; omitted for a new thing. */
  nodeId?: GraphId;
  kind: string;
  label: string;
  properties?: Record<string, unknown>;
  /** Bytes of a content node. */
  content?: Uint8Array;
  claim?: ClaimContent;
  validFrom: Instant;
  validTo?: Instant;
  states?: StateSpan;
  owner: Owner;
  openedBy?: GraphId | null;
  origin?: GraphOrigin;
}

const OP_OPEN_NODE = 'open node version';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the properties of a state node: a stable integer key that no other state node ever used. */
async function checkStateKey(ctx: WriteContext, nodeId: GraphId, properties: unknown, operation: string, path: string, origin?: GraphOrigin): Promise<void> {
  const key = isPlainObject(properties) ? properties['stateKey'] : undefined;
  if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0) {
    throw new GraphError(operation, `${path}.properties.stateKey`, `an architecture state carries a whole non-negative stateKey, got ${JSON.stringify(key)}`, origin);
  }
  const other = await ctx.tx.query<{ node_id: string }>(
    `SELECT v.node_id::text AS node_id FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $1 AND (v.properties->>'stateKey')::bigint = $2::bigint AND v.node_id <> $3::bigint LIMIT 1`,
    [STATE_KIND, String(key), nodeId],
  );
  if (other.rows[0] !== undefined) {
    throw new GraphError(operation, `${path}.properties.stateKey`, `states-stable: state key ${key} was already used by state node ${other.rows[0].node_id}; a key is never reused or renumbered, a new state takes a key in a gap`, origin);
  }
}

/**
 * Opens a version: of an existing identity, or of a new one. The version is
 * recorded from `at`. Content nodes carry their bytes and the digest this
 * function computes; claims carry the revision digest of their canonical form.
 */
export async function openNodeVersion(ctx: WriteContext, input: NewNodeVersion, path = 'node'): Promise<{ nodeId: GraphId; versionId: GraphId }> {
  const origin = input.origin;
  const validFrom = instantText(input.validFrom, OP_OPEN_NODE, `${path}.validFrom`, origin);
  const validTo = instantText(input.validTo ?? 'infinity', OP_OPEN_NODE, `${path}.validTo`, origin);
  checkValid(validFrom, validTo, OP_OPEN_NODE, path, origin);
  const states = checkSpan(input.states ?? ALL_STATES, OP_OPEN_NODE, `${path}.states`, origin);
  const kind = await kindId(ctx, input.kind, OP_OPEN_NODE, `${path}.kind`, origin);
  const isContent = input.kind === CONTENT_KIND;
  const isClaim = input.kind === CLAIM_KIND;
  if (isContent !== (input.content !== undefined)) throw new GraphError(OP_OPEN_NODE, `${path}.content`, isContent ? `a content node (${CONTENT_KIND}) carries its bytes` : `only a content node (${CONTENT_KIND}) carries bytes; this node is ${input.kind}`, origin);
  if (isClaim !== (input.claim !== undefined)) throw new GraphError(OP_OPEN_NODE, `${path}.claim`, isClaim ? `a claim node (${CLAIM_KIND}) carries its statement, subjects and evidence` : `only a claim node (${CLAIM_KIND}) carries a claim; this node is ${input.kind}`, origin);
  const contentSha = input.content === undefined ? null : sha256Hex(input.content);
  const digest = input.claim === undefined ? null : digestOfClaim(input.claim);
  const properties = input.properties ?? {};
  if (!isPlainObject(properties)) throw new GraphError(OP_OPEN_NODE, `${path}.properties`, 'properties are a JSON object', origin);
  const stored = input.claim === undefined ? properties : { ...properties, claim: input.claim };
  const scope = checkId(input.owner.scope, OP_OPEN_NODE, `${path}.owner.scope`, origin);
  if (input.owner.producer === '') throw new GraphError(OP_OPEN_NODE, `${path}.owner.producer`, 'every version carries its producer', origin);
  const nodeId = input.nodeId === undefined ? await newNodeIdentity(ctx) : input.nodeId;
  if (input.nodeId !== undefined) await requireNode(ctx, nodeId, OP_OPEN_NODE, `${path}.nodeId`, origin);
  if (input.kind === STATE_KIND) await checkStateKey(ctx, nodeId, stored, OP_OPEN_NODE, path, origin);
  const payload = nodePayloadDigest({ kind: input.kind, label: input.label, properties: stored, contentSha256: contentSha, claimDigest: digest });
  const made = await guarded(OP_OPEN_NODE, path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO node_version (node_id, kind_id, label, content, content_sha256, claim_digest, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       VALUES ($1::bigint, $2::bigint, $3, CASE WHEN $4::text IS NULL THEN NULL ELSE decode($4::text, 'hex') END, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz,
               int8range($10::bigint, $11::bigint), $12, $13::bigint, $14::bigint, $15, $16::jsonb)
       RETURNING id::text AS id`,
      [nodeId, kind, input.label, input.content === undefined ? null : Buffer.from(input.content).toString('hex'), contentSha, digest, validFrom, validTo, ctx.at,
        String(states.from), String(states.to), input.owner.producer, scope, input.openedBy ?? null, payload, JSON.stringify(stored)],
    ),
  );
  return { nodeId, versionId: made.rows[0]!.id };
}

/** Closes a version at `at`: the only change a version row ever gets. */
export async function closeVersion(ctx: WriteContext, table: 'node_version' | 'edge_version', versionId: GraphId, closure: Closure, path: string, origin?: GraphOrigin): Promise<void> {
  const closed = await guarded('close version', path, origin, () =>
    ctx.tx.query(
      `UPDATE ${table} SET recorded_to = $2::timestamptz, closed_by = $3::bigint, closed_as = $4 WHERE id = $1::bigint AND recorded_to = 'infinity' RETURNING id`,
      [versionId, ctx.at, closure.workItem, closure.as],
    ),
  );
  if (closed.rows.length === 0) throw new GraphError('close version', path, `${table} ${versionId} is not a current version (already closed or missing)`, origin);
}

export async function loadNodeVersion(ctx: WriteContext, versionId: GraphId, path: string, origin?: GraphOrigin): Promise<NodeVersionRow> {
  const found = await ctx.tx.query<Raw>(`SELECT ${NODE_COLUMNS} FROM ${NODE_FROM} WHERE v.id = $1::bigint`, [checkId(versionId, 'load node version', path, origin)]);
  const row = found.rows[0];
  if (row === undefined) throw new GraphError('load node version', path, `node version ${versionId} does not exist`, origin);
  return nodeRow(row);
}

export async function loadEdgeVersion(ctx: WriteContext, versionId: GraphId, path: string, origin?: GraphOrigin): Promise<EdgeVersionRow> {
  const found = await ctx.tx.query<Raw>(`SELECT ${EDGE_COLUMNS} FROM ${EDGE_FROM} WHERE e.id = $1::bigint`, [checkId(versionId, 'load edge version', path, origin)]);
  const row = found.rows[0];
  if (row === undefined) throw new GraphError('load edge version', path, `edge version ${versionId} does not exist`, origin);
  return edgeRow(row);
}

/** The current (believed now) versions of a node, in valid-time order. */
export async function currentNodeVersions(ctx: WriteContext, nodeId: GraphId): Promise<NodeVersionRow[]> {
  const found = await ctx.tx.query<Raw>(`SELECT ${NODE_COLUMNS} FROM ${NODE_FROM} WHERE v.node_id = $1::bigint AND v.recorded_to = 'infinity' ORDER BY v.valid_from, lower(v.states), v.id`, [nodeId]);
  return found.rows.map(nodeRow);
}

export interface NodePatch {
  label?: string;
  properties?: Record<string, unknown>;
  claim?: ClaimContent;
  validFrom?: Instant;
  validTo?: Instant;
  states?: StateSpan;
}

const OP_CORRECT_NODE = 'correct node version';

/**
 * Corrects a version: closes its `recorded_to` and inserts the version now
 * believed, with the patch applied. A content node's bytes never change, and
 * no other column is touched. A correction that would leave a current edge
 * without an end for its whole valid time and states is refused (ending a
 * node's validity is `endNode`, which trims those edges and records the
 * cascade).
 */
export async function correctNodeVersion(ctx: WriteContext, versionId: GraphId, patch: NodePatch, closure: Closure, openedBy: GraphId | null, path = 'node', origin?: GraphOrigin): Promise<GraphId> {
  const old = await loadNodeVersion(ctx, versionId, `${path}.version`, origin);
  if (old.recordedTo !== 'infinity') throw new GraphError(OP_CORRECT_NODE, `${path}.version`, `node version ${versionId} was already closed at ${old.recordedTo}; only a current version is corrected`, origin);
  if (old.recordedFrom === ctx.at) throw new GraphError(OP_CORRECT_NODE, `${path}.version`, `node version ${versionId} was recorded at ${ctx.at}, the same instant as this correction, so its recorded range would be empty; correct it at a later instant`, origin);
  laterThan(ctx, old.recordedFrom);
  if ((patch.claim !== undefined) !== (old.claimDigest !== null) && patch.claim !== undefined) throw new GraphError(OP_CORRECT_NODE, `${path}.claim`, 'only a claim node carries a claim', origin);
  const validFrom = instantText(patch.validFrom ?? old.validFrom, OP_CORRECT_NODE, `${path}.validFrom`, origin);
  const validTo = instantText(patch.validTo ?? old.validTo, OP_CORRECT_NODE, `${path}.validTo`, origin);
  checkValid(validFrom, validTo, OP_CORRECT_NODE, path, origin);
  const states = checkSpan(patch.states ?? old.states, OP_CORRECT_NODE, `${path}.states`, origin);
  const label = patch.label ?? old.label;
  let properties = patch.properties ?? (old.properties as Record<string, unknown>);
  let digest = old.claimDigest;
  if (patch.claim !== undefined) {
    digest = digestOfClaim(patch.claim);
    properties = { ...(patch.properties ?? stripClaim(old.properties)), claim: patch.claim };
  } else if (patch.properties !== undefined && old.claimDigest !== null) {
    properties = { ...patch.properties, claim: (old.properties as Record<string, unknown>)['claim'] };
  }
  if (old.kind === STATE_KIND) await checkStateKey(ctx, old.nodeId, properties, OP_CORRECT_NODE, path);
  const payload = nodePayloadDigest({ kind: old.kind, label, properties, contentSha256: old.contentSha256, claimDigest: digest });
  await lockNodes(ctx, [old.nodeId], 'UPDATE');
  await closeVersion(ctx, 'node_version', versionId, closure, `${path}.version`, origin);
  const made = await guarded(OP_CORRECT_NODE, path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO node_version (node_id, kind_id, label, content, content_sha256, claim_digest, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       SELECT node_id, kind_id, $2, content, content_sha256, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, int8range($7::bigint, $8::bigint),
              producer, scope_id, $9::bigint, $10, $11::jsonb
       FROM node_version WHERE id = $1::bigint RETURNING id::text AS id`,
      [versionId, label, digest, validFrom, validTo, ctx.at, String(states.from), String(states.to), openedBy, payload, JSON.stringify(properties)],
    ),
  );
  await assertCurrentEdgesCovered(ctx, old.nodeId, `${path}.version`, origin);
  return made.rows[0]!.id;
}

function stripClaim(properties: unknown): Record<string, unknown> {
  const { claim: _claim, ...rest } = properties as Record<string, unknown>;
  return rest;
}

/** One rectangle of a node's existence: a valid span and a states span. */
interface Slice {
  validFrom: string;
  validTo: string;
  statesFrom: number;
  statesTo: number;
}

async function currentSlices(ctx: WriteContext, nodeId: GraphId): Promise<Slice[]> {
  const found = await ctx.tx.query<Raw>(
    `SELECT ${tsText('valid_from')} AS valid_from, ${tsText('valid_to')} AS valid_to, lower(states)::text AS lo, upper(states)::text AS hi
     FROM node_version WHERE node_id = $1::bigint AND recorded_to = 'infinity'`,
    [nodeId],
  );
  return found.rows.map((r) => ({ validFrom: r['valid_from'] as string, validTo: r['valid_to'] as string, statesFrom: Number(r['lo']), statesTo: Number(r['hi']) }));
}

/**
 * The first part of the box [validFrom, validTo) x [statesFrom, statesTo) that
 * the slices do not cover, as text, or null when they cover all of it. The
 * known-time axis needs no sweep: an edge is recorded from now on, and the
 * slices are what is believed now.
 */
export function firstUncovered(slices: readonly Slice[], validFrom: string, validTo: string, states: StateSpan): string | null {
  const cuts = new Set<string>([validFrom, validTo]);
  for (const slice of slices) {
    for (const t of [slice.validFrom, slice.validTo]) if (compareInstants(t, validFrom) > 0 && compareInstants(t, validTo) < 0) cuts.add(t);
  }
  const ordered = [...cuts].sort(compareInstants);
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const from = ordered[i]!;
    const to = ordered[i + 1]!;
    const here = slices
      .filter((s) => compareInstants(s.validFrom, from) <= 0 && compareInstants(to, s.validTo) <= 0)
      .map((s) => [s.statesFrom, s.statesTo] as const)
      .sort((a, b) => a[0] - b[0]);
    let reached = states.from;
    for (const [lo, hi] of here) {
      if (lo > reached) break;
      if (hi > reached) reached = hi;
    }
    if (reached < states.to) return `valid [${from}, ${to}) in states from ${reached} to ${states.to}`;
  }
  return null;
}

/**
 * Endpoint integrity (0028, "Reads"): an edge whose end does not exist for the
 * edge's whole valid time, known time and states is refused. The ends are
 * locked first, so a producer ending a node and a producer inserting an edge to
 * it never both pass.
 */
export async function assertEndpoints(ctx: WriteContext, edge: { src: GraphId; dst: GraphId; validFrom: string; validTo: string; states: StateSpan }, operation: string, path: string, origin?: GraphOrigin): Promise<void> {
  await lockNodes(ctx, [edge.src, edge.dst], 'SHARE');
  for (const [end, id] of [['src', edge.src], ['dst', edge.dst]] as const) {
    const gap = firstUncovered(await currentSlices(ctx, id), edge.validFrom, edge.validTo, edge.states);
    if (gap !== null) {
      throw new GraphError(operation, `${path}.${end}`, `endpoint-integrity: node ${id} does not exist for the whole of the edge's valid time and states: nothing believed now covers ${gap}; end the edge no later than the node, or open the node first`, origin);
    }
  }
}

/** After a node's correction, every current edge touching it must still find its end. */
async function assertCurrentEdgesCovered(ctx: WriteContext, nodeId: GraphId, path: string, origin?: GraphOrigin): Promise<void> {
  const touching = await ctx.tx.query<Raw>(
    `SELECT e.id::text AS id, e.src_id::text AS src, e.dst_id::text AS dst, ${tsText('e.valid_from')} AS valid_from, ${tsText('e.valid_to')} AS valid_to,
            lower(e.states)::text AS lo, upper(e.states)::text AS hi
     FROM edge_version e WHERE (e.src_id = $1::bigint OR e.dst_id = $1::bigint) AND e.recorded_to = 'infinity'`,
    [nodeId],
  );
  const slices = await currentSlices(ctx, nodeId);
  for (const raw of touching.rows) {
    const gap = firstUncovered(slices, raw['valid_from'] as string, raw['valid_to'] as string, { from: Number(raw['lo']), to: Number(raw['hi']) });
    if (gap !== null) {
      throw new GraphError('correct node version', path, `endpoint-integrity: the correction would leave current edge version ${raw['id']} without its end node ${nodeId}: nothing covers ${gap}; end the node with endNode, which closes such edges as recorded cascades`, origin);
    }
  }
}

export interface EndResult {
  nodeVersionsClosed: number;
  nodeVersionsReopened: number;
  cascades: { edgeVersion: GraphId; replacedBy: GraphId | null }[];
}

const OP_END_NODE = 'end node';

/** Inserts the copy of a node version that ends at `validTo`, recorded from `at`. */
export async function reopenNode(ctx: WriteContext, versionId: GraphId, validTo: string, workItem: GraphId | null, path: string, origin?: GraphOrigin): Promise<GraphId> {
  const made = await guarded(OP_END_NODE, path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO node_version (node_id, kind_id, label, content, content_sha256, claim_digest, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       SELECT node_id, kind_id, label, content, content_sha256, claim_digest, valid_from, $2::timestamptz, $3::timestamptz, states,
              producer, scope_id, $4::bigint, payload_digest, properties FROM node_version WHERE id = $1::bigint RETURNING id::text AS id`,
      [versionId, validTo, ctx.at, workItem],
    ),
  );
  return made.rows[0]!.id;
}

/**
 * Ends a node's validity at `validTo`: every current version that holds beyond
 * it is closed and, where it began earlier, reopened with the new end. Every
 * current edge of any producer that touches the node beyond that end is closed
 * the same way, each closure recorded as a cascade naming `workItem` (0028,
 * "Publication").
 */
export async function endNode(ctx: WriteContext, nodeId: GraphId, validToInput: Instant, workItem: GraphId | null, path = 'end', origin?: GraphOrigin): Promise<EndResult> {
  const validTo = instantText(validToInput, OP_END_NODE, `${path}.validTo`, origin);
  if (validTo === 'infinity' || validTo === '-infinity') throw new GraphError(OP_END_NODE, `${path}.validTo`, 'ending validity needs a finite instant', origin);
  await requireNode(ctx, nodeId, OP_END_NODE, `${path}.node`, origin);
  await lockNodes(ctx, [nodeId], 'UPDATE');
  const result: EndResult = { nodeVersionsClosed: 0, nodeVersionsReopened: 0, cascades: [] };
  const beyond = (await currentNodeVersions(ctx, nodeId)).filter((v) => compareInstants(v.validTo, validTo) > 0);
  if (beyond.length === 0) throw new GraphError(OP_END_NODE, `${path}.node`, `node ${nodeId} has no current version that holds beyond ${validTo}, so there is nothing to end`, origin);
  for (const version of beyond) {
    if (version.recordedFrom === ctx.at) throw new GraphError(OP_END_NODE, `${path}.node`, `node version ${version.versionId} was recorded at ${ctx.at}, the same instant: write and end a node in different publications`, origin);
    laterThan(ctx, version.recordedFrom);
    await closeVersion(ctx, 'node_version', version.versionId, { workItem, as: 'correction' }, `${path}.node`, origin);
    result.nodeVersionsClosed += 1;
    if (compareInstants(version.validFrom, validTo) < 0) {
      await reopenNode(ctx, version.versionId, validTo, workItem, path, origin);
      result.nodeVersionsReopened += 1;
    }
  }
  const touching = await ctx.tx.query<Raw>(
    `SELECT ${EDGE_COLUMNS} FROM ${EDGE_FROM} WHERE (e.src_id = $1::bigint OR e.dst_id = $1::bigint) AND e.recorded_to = 'infinity' AND e.valid_to > $2::timestamptz ORDER BY e.id FOR UPDATE OF e`,
    [nodeId, validTo],
  );
  for (const raw of touching.rows) {
    const edge = edgeRow(raw);
    if (edge.recordedFrom === ctx.at) throw new GraphError(OP_END_NODE, `${path}.node`, `edge version ${edge.versionId} was recorded at ${ctx.at}, the same instant, so it cannot be closed as a cascade of this end`, origin);
    laterThan(ctx, edge.recordedFrom);
    await closeVersion(ctx, 'edge_version', edge.versionId, { workItem, as: 'cascade' }, `${path}.cascade`, origin);
    let replacedBy: GraphId | null = null;
    if (compareInstants(edge.validFrom, validTo) < 0) replacedBy = await reopenEdge(ctx, edge.versionId, validTo, workItem, `${path}.cascade`, origin);
    result.cascades.push({ edgeVersion: edge.versionId, replacedBy });
  }
  return result;
}

/** Inserts the copy of an edge version that ends at `validTo`, recorded from `at`. */
export async function reopenEdge(ctx: WriteContext, versionId: GraphId, validTo: string, workItem: GraphId | null, path: string, origin?: GraphOrigin): Promise<GraphId> {
  const made = await guarded('end edge', path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO edge_version (edge_id, relation_type_id, src_id, dst_id, discriminator, byte_start, byte_end, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       SELECT edge_id, relation_type_id, src_id, dst_id, discriminator, byte_start, byte_end, valid_from, $2::timestamptz, $3::timestamptz, states,
              producer, scope_id, $4::bigint, payload_digest, properties FROM edge_version WHERE id = $1::bigint RETURNING id::text AS id`,
      [versionId, validTo, ctx.at, workItem],
    ),
  );
  return made.rows[0]!.id;
}

export interface NewEdgeVersion {
  relation: string;
  src: GraphId;
  dst: GraphId;
  /** Tells apart parallel relations of one type; allowed only when the relation type declares it. */
  discriminator?: string;
  /** Byte span of an occurrence; allowed only when the relation type is positioned. */
  position?: ByteSpan;
  properties?: Record<string, unknown>;
  validFrom: Instant;
  validTo?: Instant;
  states?: StateSpan;
  owner: Owner;
  openedBy?: GraphId | null;
  origin?: GraphOrigin;
}

const OP_OPEN_EDGE = 'open edge version';

/** Validates an edge's relation, discriminator and position against its relation type and returns its identity key parts. */
export async function resolveEdge(ctx: WriteContext, input: NewEdgeVersion, path: string): Promise<{ relation: RelationInfo; discriminator: string; position: ByteSpan | null; keyHash: string }> {
  const origin = input.origin;
  const relation = await relationInfo(ctx, input.relation, OP_OPEN_EDGE, `${path}.relation`, origin);
  const discriminator = input.discriminator ?? '';
  if (discriminator !== '' && !relation.discriminated) throw new GraphError(OP_OPEN_EDGE, `${path}.discriminator`, `the relation type "${input.relation}" does not declare a discriminator, so parallel relations of it are one relation`, origin);
  const position = input.position ?? null;
  if (position !== null) {
    if (!relation.positioned) throw new GraphError(OP_OPEN_EDGE, `${path}.position`, `the relation type "${input.relation}" is not positioned, so it carries no byte span`, origin);
    if (!Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end) || position.start < 0 || position.end <= position.start) {
      throw new GraphError(OP_OPEN_EDGE, `${path}.position`, `a byte span is half-open with 0 <= start < end, got [${position.start}, ${position.end})`, origin);
    }
    if (discriminator !== '') throw new GraphError(OP_OPEN_EDGE, `${path}.discriminator`, 'a positioned occurrence is keyed by its starting byte and takes no discriminator', origin);
  } else if (relation.positioned) {
    throw new GraphError(OP_OPEN_EDGE, `${path}.position`, `the relation type "${input.relation}" is positioned: an occurrence carries the byte span it covers`, origin);
  }
  const src = checkId(input.src, OP_OPEN_EDGE, `${path}.src`, origin);
  const dst = checkId(input.dst, OP_OPEN_EDGE, `${path}.dst`, origin);
  return { relation, discriminator, position, keyHash: edgeKeyHash({ relation: input.relation, src, dst, discriminator, position }) };
}

export async function edgeIdentity(ctx: WriteContext, keyHash: string): Promise<GraphId> {
  const made = await ctx.tx.query<{ id: string }>('INSERT INTO edge_identity (key_hash) VALUES ($1) ON CONFLICT (key_hash) DO NOTHING RETURNING id::text AS id', [keyHash]);
  if (made.rows[0] !== undefined) return made.rows[0].id;
  const found = await ctx.tx.query<{ id: string }>('SELECT id::text AS id FROM edge_identity WHERE key_hash = $1', [keyHash]);
  return found.rows[0]!.id;
}

/** Opens an edge version after endpoint integrity has been checked; returns its identity and version. */
export async function openEdgeVersion(ctx: WriteContext, input: NewEdgeVersion, path = 'edge'): Promise<{ edgeId: GraphId; versionId: GraphId }> {
  const origin = input.origin;
  const validFrom = instantText(input.validFrom, OP_OPEN_EDGE, `${path}.validFrom`, origin);
  const validTo = instantText(input.validTo ?? 'infinity', OP_OPEN_EDGE, `${path}.validTo`, origin);
  checkValid(validFrom, validTo, OP_OPEN_EDGE, path, origin);
  const states = checkSpan(input.states ?? ALL_STATES, OP_OPEN_EDGE, `${path}.states`, origin);
  const properties = input.properties ?? {};
  if (!isPlainObject(properties)) throw new GraphError(OP_OPEN_EDGE, `${path}.properties`, 'properties are a JSON object', origin);
  const scope = checkId(input.owner.scope, OP_OPEN_EDGE, `${path}.owner.scope`, origin);
  if (input.owner.producer === '') throw new GraphError(OP_OPEN_EDGE, `${path}.owner.producer`, 'every version carries its producer', origin);
  const resolved = await resolveEdge(ctx, input, path);
  await requireNode(ctx, input.src, OP_OPEN_EDGE, `${path}.src`, origin);
  await requireNode(ctx, input.dst, OP_OPEN_EDGE, `${path}.dst`, origin);
  await assertEndpoints(ctx, { src: input.src, dst: input.dst, validFrom, validTo, states }, OP_OPEN_EDGE, path, origin);
  const edgeId = await edgeIdentity(ctx, resolved.keyHash);
  const payload = edgePayloadDigest({ relation: input.relation, src: input.src, dst: input.dst, discriminator: resolved.discriminator, position: resolved.position, properties });
  const made = await guarded(OP_OPEN_EDGE, path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO edge_version (edge_id, relation_type_id, src_id, dst_id, discriminator, byte_start, byte_end, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5, $6::bigint, $7::bigint, $8::timestamptz, $9::timestamptz, $10::timestamptz,
               int8range($11::bigint, $12::bigint), $13, $14::bigint, $15::bigint, $16, $17::jsonb)
       RETURNING id::text AS id`,
      [edgeId, resolved.relation.id, input.src, input.dst, resolved.discriminator, resolved.position === null ? null : String(resolved.position.start),
        resolved.position === null ? null : String(resolved.position.end), validFrom, validTo, ctx.at, String(states.from), String(states.to),
        input.owner.producer, scope, input.openedBy ?? null, payload, JSON.stringify(properties)],
    ),
  );
  return { edgeId, versionId: made.rows[0]!.id };
}

export interface EdgePatch {
  properties?: Record<string, unknown>;
  validFrom?: Instant;
  validTo?: Instant;
  states?: StateSpan;
}

const OP_CORRECT_EDGE = 'correct edge version';

/** Corrects an edge version: closes its `recorded_to` and inserts the version now believed. The ends are checked again. */
export async function correctEdgeVersion(ctx: WriteContext, versionId: GraphId, patch: EdgePatch, closure: Closure, openedBy: GraphId | null, path = 'edge', origin?: GraphOrigin): Promise<GraphId> {
  const old = await loadEdgeVersion(ctx, versionId, `${path}.version`, origin);
  if (old.recordedTo !== 'infinity') throw new GraphError(OP_CORRECT_EDGE, `${path}.version`, `edge version ${versionId} was already closed at ${old.recordedTo}; only a current version is corrected`, origin);
  if (old.recordedFrom === ctx.at) throw new GraphError(OP_CORRECT_EDGE, `${path}.version`, `edge version ${versionId} was recorded at ${ctx.at}, the same instant as this correction, so its recorded range would be empty`, origin);
  laterThan(ctx, old.recordedFrom);
  const validFrom = instantText(patch.validFrom ?? old.validFrom, OP_CORRECT_EDGE, `${path}.validFrom`, origin);
  const validTo = instantText(patch.validTo ?? old.validTo, OP_CORRECT_EDGE, `${path}.validTo`, origin);
  checkValid(validFrom, validTo, OP_CORRECT_EDGE, path, origin);
  const states = checkSpan(patch.states ?? old.states, OP_CORRECT_EDGE, `${path}.states`, origin);
  const properties = patch.properties ?? (old.properties as Record<string, unknown>);
  await assertEndpoints(ctx, { src: old.src, dst: old.dst, validFrom, validTo, states }, OP_CORRECT_EDGE, path, origin);
  const payload = edgePayloadDigest({ relation: old.relation, src: old.src, dst: old.dst, discriminator: old.discriminator, position: old.position, properties });
  await closeVersion(ctx, 'edge_version', versionId, closure, `${path}.version`, origin);
  const made = await guarded(OP_CORRECT_EDGE, path, origin, () =>
    ctx.tx.query<{ id: string }>(
      `INSERT INTO edge_version (edge_id, relation_type_id, src_id, dst_id, discriminator, byte_start, byte_end, valid_from, valid_to, recorded_from, states,
                                producer, scope_id, opened_by, payload_digest, properties)
       SELECT edge_id, relation_type_id, src_id, dst_id, discriminator, byte_start, byte_end, $2::timestamptz, $3::timestamptz, $4::timestamptz,
              int8range($5::bigint, $6::bigint), producer, scope_id, $7::bigint, $8, $9::jsonb FROM edge_version WHERE id = $1::bigint RETURNING id::text AS id`,
      [versionId, validFrom, validTo, ctx.at, String(states.from), String(states.to), openedBy, payload, JSON.stringify(properties)],
    ),
  );
  return made.rows[0]!.id;
}

/** Ends an edge's validity at `validTo`: the current version holding beyond it is closed and reopened with the new end (or only closed when it began at or after it). */
export async function endEdgeVersion(ctx: WriteContext, versionId: GraphId, validToInput: Instant, closure: Closure, path = 'edge', origin?: GraphOrigin): Promise<GraphId | null> {
  const old = await loadEdgeVersion(ctx, versionId, `${path}.version`, origin);
  const validTo = instantText(validToInput, 'end edge', `${path}.validTo`, origin);
  if (old.recordedTo !== 'infinity') throw new GraphError('end edge', `${path}.version`, `edge version ${versionId} was already closed at ${old.recordedTo}`, origin);
  if (old.recordedFrom === ctx.at) throw new GraphError('end edge', `${path}.version`, `edge version ${versionId} was recorded at ${ctx.at}, the same instant`, origin);
  laterThan(ctx, old.recordedFrom);
  if (validTo === 'infinity' || validTo === '-infinity' || compareInstants(old.validTo, validTo) <= 0) throw new GraphError('end edge', `${path}.validTo`, `edge version ${versionId} already ends at ${old.validTo}, not after ${validTo}`, origin);
  await closeVersion(ctx, 'edge_version', versionId, closure, `${path}.version`, origin);
  return compareInstants(old.validFrom, validTo) < 0 ? await reopenEdge(ctx, versionId, validTo, closure.workItem, path, origin) : null;
}
