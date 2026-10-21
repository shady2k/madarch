/**
 * Publication (decision 0028, "Publication"; 0027's guarantees on version
 * rows). A unit's result is published in one transaction:
 *
 * - fenced by its lease token and by the lease's expiry, so a unit whose lease
 *   passed to another worker publishes nothing;
 * - revalidated against the input digest of what the unit read;
 * - exactly once per producer, scope and generation: a second publication of
 *   a generation already published is refused, whatever its content;
 * - scoped: it opens, corrects and ends only versions of its own producer and
 *   scope. The one write it makes to versions it does not own is the cascade
 *   closure of other producers' edges that touch a node it ends, each recorded
 *   with the publication that caused it;
 * - visible to every read at once or not at all, because it is one
 *   transaction of the caller's owner.
 *
 * A producer that runs again on the same input publishes nothing, and an item
 * that finds its current version with the same payload writes nothing.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { claimDigest, nodePayloadDigest, edgePayloadDigest, sha256Hex, type ByteSpan, type ClaimContent, type GraphId } from './digest.js';
import { GraphError, type GraphOrigin } from './errors.js';
import { ALL_STATES, checkSpan, compareInstants, instantText, type Instant, type StateSpan } from './time.js';
import {
  assertEndpoints, checkId, closeVersion, correctEdgeVersion, correctNodeVersion, currentNodeVersions, edgeIdentity, edgeRow, EDGE_COLUMNS, EDGE_FROM,
  endNode, openEdgeVersion, openNodeVersion, reopenEdge, reopenNode, requireNode, resolveEdge,
  type EdgeVersionRow, type NodeVersionRow, type WriteContext,
} from './versions.js';
import { CONTENT_KIND } from './vocabulary.js';

type Raw = Record<string, unknown>;

export interface WorkItemInput {
  producer: string;
  scope: GraphId;
  generation: number;
  /** The digest of what the unit read; a publication must name the same one. */
  inputDigest: string;
  leaseToken: string;
  leaseUntil: Instant;
}

const OP_WORK = 'open work item';

/** Records a unit generation of a producer and scope, leased to one worker. */
export async function openWorkItem(ctx: WriteContext, input: WorkItemInput, path = 'workItem'): Promise<GraphId> {
  if (input.producer === '') throw new GraphError(OP_WORK, `${path}.producer`, 'a work item names its producer');
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) throw new GraphError(OP_WORK, `${path}.generation`, `a generation is a positive whole number, got ${input.generation}`);
  const scope = checkId(input.scope, OP_WORK, `${path}.scope`);
  await requireNode(ctx, scope, OP_WORK, `${path}.scope`);
  const until = instantText(input.leaseUntil, OP_WORK, `${path}.leaseUntil`);
  const made = await ctx.tx.query<{ id: string }>(
    `INSERT INTO work_item (producer, scope_id, generation, input_digest, lease_token, lease_until)
     VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6::timestamptz)
     ON CONFLICT (producer, scope_id, generation) DO NOTHING RETURNING id::text AS id`,
    [input.producer, scope, String(input.generation), input.inputDigest, input.leaseToken, until],
  );
  if (made.rows[0] === undefined) throw new GraphError(OP_WORK, path, `generation ${input.generation} of producer "${input.producer}" for scope ${scope} already has a work item`);
  return made.rows[0].id;
}

export interface LeaseInput {
  producer: string;
  scope: GraphId;
  generation: number;
  leaseToken: string;
  leaseUntil: Instant;
  /** The input digest the unit reads now, when it changed. */
  inputDigest?: string;
}

/** Moves a work item's lease to another worker, or moves its input digest; refused once the generation is published. */
export async function leaseWorkItem(ctx: WriteContext, input: LeaseInput, path = 'lease'): Promise<void> {
  const until = instantText(input.leaseUntil, 'lease work item', `${path}.leaseUntil`);
  const scope = checkId(input.scope, 'lease work item', `${path}.scope`);
  const moved = await ctx.tx.query(
    `UPDATE work_item SET lease_token = $4, lease_until = $5::timestamptz, input_digest = COALESCE($6, input_digest)
     WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint AND published_at IS NULL RETURNING id`,
    [input.producer, scope, String(input.generation), input.leaseToken, until, input.inputDigest ?? null],
  );
  if (moved.rows.length === 0) throw new GraphError('lease work item', path, `no unpublished work item for generation ${input.generation} of producer "${input.producer}" and scope ${scope}`);
}

export type NodeRef = { id: GraphId } | { ref: string };

export interface PublishNode {
  /** A name for a new node inside this publication, which edges and the result use. */
  ref?: string;
  /** An existing identity this item corrects or succeeds; omitted for a new node. */
  id?: GraphId;
  kind: string;
  label: string;
  properties?: Record<string, unknown>;
  /** Bytes of a content node; its identity is its digest, so equal bytes are one node. */
  content?: Uint8Array;
  claim?: ClaimContent;
  validFrom: Instant;
  /** A new node is open-ended unless this says otherwise; a correction keeps the version's own end unless this says otherwise. */
  validTo?: Instant;
  states?: StateSpan;
  /** Optional assertion that the item belongs to the publication's producer and scope; any other value is refused. */
  producer?: string;
  scope?: GraphId;
  origin?: GraphOrigin;
}

export interface PublishEdge {
  relation: string;
  src: NodeRef;
  dst: NodeRef;
  discriminator?: string;
  position?: ByteSpan;
  properties?: Record<string, unknown>;
  validFrom: Instant;
  validTo?: Instant;
  states?: StateSpan;
  producer?: string;
  scope?: GraphId;
  origin?: GraphOrigin;
}

export interface PublishEnd {
  node: NodeRef;
  validTo: Instant;
  origin?: GraphOrigin;
}

export interface PublishInput {
  producer: string;
  scope: GraphId;
  generation: number;
  leaseToken: string;
  inputDigest: string;
  nodes?: readonly PublishNode[];
  edges?: readonly PublishEdge[];
  ends?: readonly PublishEnd[];
}

export interface PublishResult {
  /** True when the producer had already published this very input: nothing was written. */
  unchangedInput: boolean;
  /** The identity of each named new node. */
  refs: Record<string, GraphId>;
  nodeVersionsOpened: number;
  edgeVersionsOpened: number;
  /** Versions closed to correct or succeed one (not cascades). */
  corrections: number;
  /** Other producers' edge versions this publication closed because a node it ended no longer holds them. */
  cascades: { edgeVersion: GraphId; replacedBy: GraphId | null }[];
  /** Items that found their current version unchanged and wrote nothing. */
  unchanged: number;
  publishedDigest: string;
}

const OP = 'publish';

interface Locked {
  id: GraphId;
  published: boolean;
  leaseToken: string;
  leaseExpired: boolean;
  inputDigest: string;
}

/** Everything a publication needs while it runs. */
interface Run {
  ctx: WriteContext;
  workItem: GraphId;
  owner: { producer: string; scope: GraphId };
  refs: Map<string, GraphId>;
  result: PublishResult;
  summary: unknown[];
  endedNodes: Set<GraphId>;
  writtenNodes: Set<GraphId>;
}

function refuseForeign(item: { producer?: string; scope?: GraphId; origin?: GraphOrigin }, run: Run, path: string): void {
  if (item.producer !== undefined && item.producer !== run.owner.producer) {
    throw new GraphError(OP, `${path}.producer`, `fenced-publication: this publication is producer "${run.owner.producer}" and writes only its own versions, not producer "${item.producer}"'s`, item.origin);
  }
  if (item.scope !== undefined && item.scope !== run.owner.scope) {
    throw new GraphError(OP, `${path}.scope`, `fenced-publication: this publication is scope ${run.owner.scope} and writes only its own versions, not scope ${item.scope}'s`, item.origin);
  }
}

function resolveRef(run: Run, ref: NodeRef, path: string, origin?: GraphOrigin): GraphId {
  if ('id' in ref) return checkId(ref.id, OP, `${path}.id`, origin);
  const found = run.refs.get(ref.ref);
  if (found === undefined) throw new GraphError(OP, `${path}.ref`, `"${ref.ref}" names no node of this publication (a node is named by ref in nodes[] before an edge or end uses it)`, origin);
  return found;
}

function checkOwned(version: { producer: string; scope: GraphId }, kind: string, id: GraphId, run: Run, path: string, origin?: GraphOrigin): void {
  if (version.producer !== run.owner.producer || version.scope !== run.owner.scope) {
    throw new GraphError(OP, path, `fenced-publication: ${kind} ${id} belongs to producer "${version.producer}" and scope ${version.scope}; this publication is producer "${run.owner.producer}" and scope ${run.owner.scope} and writes only its own`, origin);
  }
}

/** Publishes a unit's result in the caller's transaction. See the module comment for the guarantees. */
export async function publish(ctx: WriteContext, input: PublishInput): Promise<PublishResult> {
  const scope = checkId(input.scope, OP, 'scope');
  if (input.producer === '') throw new GraphError(OP, 'producer', 'a publication names its producer');
  const locked = await ctx.tx.query<{ id: string; published: boolean; lease_token: string; expired: boolean; input_digest: string }>(
    `SELECT id::text AS id, published_at IS NOT NULL AS published, lease_token, lease_until <= $4::timestamptz AS expired, input_digest
     FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint FOR UPDATE`,
    [input.producer, scope, String(input.generation), ctx.at],
  );
  const raw = locked.rows[0];
  if (raw === undefined) throw new GraphError(OP, 'generation', `fenced-publication: there is no work item for generation ${input.generation} of producer "${input.producer}" and scope ${scope}; a unit publishes only a generation that was planned`);
  const item: Locked = { id: raw.id, published: raw.published, leaseToken: raw.lease_token, leaseExpired: raw.expired, inputDigest: raw.input_digest };
  const name = `generation ${input.generation} of producer "${input.producer}" and scope ${scope}`;
  if (item.published) throw new GraphError(OP, 'generation', `fenced-publication: ${name} was already published; a generation is published exactly once, whatever its content`);
  if (item.leaseToken !== input.leaseToken) throw new GraphError(OP, 'leaseToken', `fenced-publication: the lease of ${name} passed to another worker; this unit's token no longer holds it, so it publishes nothing`);
  if (item.leaseExpired) throw new GraphError(OP, 'leaseToken', `fenced-publication: the lease of ${name} has expired at ${ctx.at}; a unit whose lease passed publishes nothing`);
  if (item.inputDigest !== input.inputDigest) throw new GraphError(OP, 'inputDigest', `fenced-publication: ${name} read inputs digest ${input.inputDigest} but its work item now names ${item.inputDigest}; its reads are stale, so it publishes nothing`);

  const result: PublishResult = { unchangedInput: false, refs: {}, nodeVersionsOpened: 0, edgeVersionsOpened: 0, corrections: 0, cascades: [], unchanged: 0, publishedDigest: '' };
  const previous = await ctx.tx.query<{ input_digest: string; published_digest: string }>(
    `SELECT input_digest, published_digest FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND published_at IS NOT NULL ORDER BY generation DESC LIMIT 1`,
    [input.producer, scope],
  );
  if (previous.rows[0] !== undefined && previous.rows[0].input_digest === input.inputDigest) {
    result.unchangedInput = true;
    result.publishedDigest = previous.rows[0].published_digest;
  } else {
    const run: Run = { ctx, workItem: item.id, owner: { producer: input.producer, scope }, refs: new Map(), result, summary: [], endedNodes: new Set(), writtenNodes: new Set() };
    const nodes = input.nodes ?? [];
    for (const [index, node] of nodes.entries()) await publishNode(run, node, `nodes[${index}]`);
    for (const [index, end] of (input.ends ?? []).entries()) await publishEnd(run, end, `ends[${index}]`);
    for (const [index, edge] of (input.edges ?? []).entries()) await publishEdge(run, edge, `edges[${index}]`);
    result.refs = Object.fromEntries([...run.refs.entries()].sort(([a], [b]) => byCodePoint(a, b)));
    result.publishedDigest = canonicalJsonDigest({ generation: input.generation, inputDigest: input.inputDigest, items: run.summary, producer: input.producer, scope });
  }
  await ctx.tx.query(`UPDATE work_item SET published_at = $2::timestamptz, published_digest = $3 WHERE id = $1::bigint`, [item.id, ctx.at, result.publishedDigest]);
  return result;
}

async function publishNode(run: Run, node: PublishNode, path: string): Promise<void> {
  const { ctx } = run;
  const origin = node.origin;
  refuseForeign(node, run, path);
  const validFrom = instantText(node.validFrom, OP, `${path}.validFrom`, origin);
  const validTo = node.validTo === undefined ? undefined : instantText(node.validTo, OP, `${path}.validTo`, origin);
  const states = checkSpan(node.states ?? ALL_STATES, OP, `${path}.states`, origin);
  const properties = node.properties ?? {};
  const claim = node.claim;
  const stored = claim === undefined ? properties : { ...properties, claim };
  const contentSha = node.content === undefined ? null : sha256Hex(node.content);
  const digest = claim === undefined ? null : claimDigest(claim);
  const payload = nodePayloadDigest({ kind: node.kind, label: node.label, properties: stored, contentSha256: contentSha, claimDigest: digest });
  run.summary.push({ claimDigest: digest, contentSha256: contentSha, id: node.id ?? null, kind: node.kind, label: node.label, payload, ref: node.ref ?? null, states, validFrom, validTo: validTo ?? null });
  if (node.ref !== undefined && run.refs.has(node.ref)) throw new GraphError(OP, `${path}.ref`, `"${node.ref}" names two nodes of this publication`, origin);
  const own = { owner: run.owner, openedBy: run.workItem, origin } as const;

  if (node.kind === CONTENT_KIND && node.content !== undefined) {
    // A content node's identity is its bytes' digest: equal bytes are one node, written once.
    const found = await ctx.tx.query<{ node_id: string }>(
      `SELECT v.node_id::text AS node_id FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = $1 AND v.content_sha256 = $2 LIMIT 1`,
      [CONTENT_KIND, contentSha],
    );
    const existing = found.rows[0]?.node_id;
    if (existing !== undefined) {
      if (node.id !== undefined && node.id !== existing) throw new GraphError(OP, `${path}.id`, `content-immutable: node ${node.id} was named for bytes whose digest ${contentSha} belongs to content node ${existing}`, origin);
      if (node.ref !== undefined) run.refs.set(node.ref, existing);
      run.result.unchanged += 1;
      return;
    }
    if (node.id !== undefined) {
      const holds = await currentNodeVersions(ctx, node.id);
      if (holds.length > 0) throw new GraphError(OP, `${path}.id`, `content-immutable: content node ${node.id} already holds other bytes; its bytes and digest never change`, origin);
    }
  }

  if (node.id === undefined) {
    const opened = await openNodeVersion(ctx, { kind: node.kind, label: node.label, properties, ...(node.content === undefined ? {} : { content: node.content }), ...(claim === undefined ? {} : { claim }), validFrom, ...(validTo === undefined ? {} : { validTo }), states, ...own }, path);
    run.result.nodeVersionsOpened += 1;
    run.writtenNodes.add(opened.nodeId);
    if (node.ref !== undefined) run.refs.set(node.ref, opened.nodeId);
    return;
  }

  const id = checkId(node.id, OP, `${path}.id`, origin);
  await requireNode(ctx, id, OP, `${path}.id`, origin);
  if (node.ref !== undefined) run.refs.set(node.ref, id);
  run.writtenNodes.add(id);
  const current = await currentNodeVersions(ctx, id);
  for (const version of current) checkOwned(version, 'node', id, run, `${path}.id`, origin);
  const target = latestWithStates(current, states);
  if (target === undefined) {
    await openNodeVersion(ctx, { nodeId: id, kind: node.kind, label: node.label, properties, ...(node.content === undefined ? {} : { content: node.content }), ...(claim === undefined ? {} : { claim }), validFrom, ...(validTo === undefined ? {} : { validTo }), states, ...own }, path);
    run.result.nodeVersionsOpened += 1;
    return;
  }
  if (target.kind !== node.kind) throw new GraphError(OP, `${path}.kind`, `node ${id} is a ${target.kind}; the kind of an identity never changes (it is ${node.kind} here)`, origin);
  if (target.payloadDigest === payload && compareInstants(target.validFrom, validFrom) <= 0 && compareInstants(validFrom, target.validTo) < 0 && (validTo === undefined || validTo === target.validTo)) {
    run.result.unchanged += 1;
    return;
  }
  const patch = { label: node.label, properties, ...(claim === undefined ? {} : { claim }), validFrom, ...(validTo === undefined ? {} : { validTo }) };
  const cmp = compareInstants(validFrom, target.validFrom);
  if (cmp > 0 && compareInstants(validFrom, target.validTo) < 0 && target.payloadDigest !== payload) {
    // Succession on the valid axis (a rename, a move): the old belief is kept up to the new start.
    await closeVersion(ctx, 'node_version', target.versionId, { workItem: run.workItem, as: 'correction' }, `${path}.id`, origin);
    run.result.corrections += 1;
    await reopenNode(ctx, target.versionId, validFrom, run.workItem, path, origin);
    await openNodeVersion(ctx, { nodeId: id, kind: node.kind, label: node.label, properties, ...(node.content === undefined ? {} : { content: node.content }), ...(claim === undefined ? {} : { claim }), validFrom, validTo: validTo ?? target.validTo, states, ...own }, path);
    run.result.nodeVersionsOpened += 1;
    return;
  }
  if (cmp >= 0 && compareInstants(validFrom, target.validTo) >= 0) {
    // The old version ended before this one starts: a new span of existence, nothing to correct.
    await openNodeVersion(ctx, { nodeId: id, kind: node.kind, label: node.label, properties, ...(node.content === undefined ? {} : { content: node.content }), ...(claim === undefined ? {} : { claim }), validFrom, ...(validTo === undefined ? {} : { validTo }), states, ...own }, path);
    run.result.nodeVersionsOpened += 1;
    return;
  }
  await correctNodeVersion(ctx, target.versionId, { ...patch, validFrom: cmp > 0 ? target.validFrom : validFrom, states }, { workItem: run.workItem, as: 'correction' }, run.workItem, path, origin);
  run.result.corrections += 1;
  run.result.nodeVersionsOpened += 1;
}

function latestWithStates(versions: readonly NodeVersionRow[], states: StateSpan): NodeVersionRow | undefined;
function latestWithStates(versions: readonly EdgeVersionRow[], states: StateSpan): EdgeVersionRow | undefined;
function latestWithStates(versions: readonly (NodeVersionRow | EdgeVersionRow)[], states: StateSpan): NodeVersionRow | EdgeVersionRow | undefined {
  return versions
    .filter((v) => v.states.from === states.from && v.states.to === states.to)
    .sort((a, b) => compareInstants(b.validFrom, a.validFrom))[0];
}

async function publishEnd(run: Run, end: PublishEnd, path: string): Promise<void> {
  const { ctx } = run;
  const id = resolveRef(run, end.node, `${path}.node`, end.origin);
  if (run.writtenNodes.has(id)) throw new GraphError(OP, `${path}.node`, `node ${id} is written and ended by one publication; end a node in a publication that does not also write it`, end.origin);
  if (run.endedNodes.has(id)) throw new GraphError(OP, `${path}.node`, `node ${id} is ended twice by one publication`, end.origin);
  const validTo = instantText(end.validTo, OP, `${path}.validTo`, end.origin);
  run.summary.push({ endNode: id, validTo });
  const current = await currentNodeVersions(ctx, id);
  if (current.length === 0) throw new GraphError(OP, `${path}.node`, `node ${id} has no current version to end`, end.origin);
  for (const version of current) checkOwned(version, 'node', id, run, `${path}.node`, end.origin);
  const done = await endNode(ctx, id, validTo, run.workItem, path, end.origin);
  run.endedNodes.add(id);
  run.result.corrections += done.nodeVersionsClosed;
  run.result.cascades.push(...done.cascades);
}

async function publishEdge(run: Run, edge: PublishEdge, path: string): Promise<void> {
  const { ctx } = run;
  const origin = edge.origin;
  refuseForeign(edge, run, path);
  const src = resolveRef(run, edge.src, `${path}.src`, origin);
  const dst = resolveRef(run, edge.dst, `${path}.dst`, origin);
  const validFrom = instantText(edge.validFrom, OP, `${path}.validFrom`, origin);
  const validTo = edge.validTo === undefined ? undefined : instantText(edge.validTo, OP, `${path}.validTo`, origin);
  const states = checkSpan(edge.states ?? ALL_STATES, OP, `${path}.states`, origin);
  const properties = edge.properties ?? {};
  const base = { relation: edge.relation, src, dst, ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }), ...(edge.position === undefined ? {} : { position: edge.position }), properties, validFrom, states, owner: run.owner, openedBy: run.workItem, ...(origin === undefined ? {} : { origin }) };
  const resolved = await resolveEdge(ctx, { ...base }, path);
  const payload = edgePayloadDigest({ relation: edge.relation, src, dst, discriminator: resolved.discriminator, position: resolved.position, properties });
  run.summary.push({ keyHash: resolved.keyHash, payload, states, validFrom, validTo: validTo ?? null });
  const identity = await edgeIdentity(ctx, resolved.keyHash);
  const found = await ctx.tx.query<Raw>(`SELECT ${EDGE_COLUMNS} FROM ${EDGE_FROM} WHERE e.edge_id = $1::bigint AND e.recorded_to = 'infinity'`, [identity]);
  const current = found.rows.map(edgeRow);
  for (const version of current) checkOwned(version, 'edge', identity, run, path, origin);
  const target = latestWithStates(current, states);
  const open = async (): Promise<void> => {
    await openEdgeVersion(ctx, { ...base, ...(validTo === undefined ? {} : { validTo }) }, path);
    run.result.edgeVersionsOpened += 1;
  };
  if (target === undefined) {
    await open();
    return;
  }
  if (target.payloadDigest === payload && compareInstants(target.validFrom, validFrom) <= 0 && compareInstants(validFrom, target.validTo) < 0 && (validTo === undefined || validTo === target.validTo)) {
    run.result.unchanged += 1;
    return;
  }
  if (compareInstants(validFrom, target.validTo) >= 0) {
    await open();
    return;
  }
  if (compareInstants(validFrom, target.validFrom) > 0 && target.payloadDigest !== payload) {
    await assertEndpoints(ctx, { src, dst, validFrom, validTo: validTo ?? target.validTo, states }, OP, path, origin);
    await closeVersion(ctx, 'edge_version', target.versionId, { workItem: run.workItem, as: 'correction' }, path, origin);
    run.result.corrections += 1;
    await reopenEdge(ctx, target.versionId, validFrom, run.workItem, path, origin);
    await openEdgeVersion(ctx, { ...base, validTo: validTo ?? target.validTo }, path);
    run.result.edgeVersionsOpened += 1;
    return;
  }
  await correctEdgeVersion(ctx, target.versionId, { properties, validFrom: compareInstants(validFrom, target.validFrom) > 0 ? target.validFrom : validFrom, ...(validTo === undefined ? {} : { validTo }), states }, { workItem: run.workItem, as: 'correction' }, run.workItem, path, origin);
  run.result.corrections += 1;
  run.result.edgeVersionsOpened += 1;
}
