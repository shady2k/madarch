/**
 * The graph's reads (decision 0028, "Reads"). Every read takes
 * `{valid, known, state}` with the defaults now, now and as-is, and the
 * filter applies to every edge and to both end nodes on every hop: a version
 * is seen only when it was valid at `valid`, recorded and not yet closed at
 * `known`, and holds the state. Nothing here truncates silently: a result that
 * can be large is a page with a keyset cursor, and `next` is non-null exactly
 * when more rows follow.
 */
import type { OuterTransaction } from '../history/types.js';
import { byCodePoint } from '../model/order.js';
import type { ByteSpan, GraphId } from './digest.js';
import { GraphError } from './errors.js';
import { ALL_STATES, instantText, type Instant } from './time.js';
import { EDGE_COLUMNS, EDGE_FROM, NODE_COLUMNS, NODE_FROM, checkId, edgeRow, nodeRow, type EdgeVersionRow, type NodeVersionRow } from './versions.js';
import { ACCEPTANCE_KIND, CALLS, CLAIM_KIND, CONTAINS, CONTENT_KIND, STATE_KIND } from './vocabulary.js';

type Raw = Record<string, unknown>;

/** The three coordinates of a read. Omitted ones default to now, now and as-is. */
export interface GraphLens {
  /** When it held in the product. */
  valid?: Instant;
  /** When madarch knew it. */
  known?: Instant;
  /** An architecture-state key, or `as-is` (the chain's first state) or `to-be` (its last), resolved at the lens's valid and known time. */
  state?: number | 'as-is' | 'to-be';
}

export interface ResolvedLens {
  valid: string;
  known: string;
  state: number;
}

export interface PageOptions {
  /** The `next` of the previous page. */
  after?: string;
  /** Rows per page: 1 to 100000, 1000 by default. */
  limit?: number;
}

export interface Page<T> {
  rows: T[];
  /** The cursor to pass as `after` for the next page; null when this page is the last. */
  next: string | null;
}

export interface EdgeEntry {
  edge: EdgeVersionRow;
  src: NodeVersionRow;
  dst: NodeVersionRow;
}

const DEFAULT_LIMIT = 1000;

function pageLimit(options: PageOptions | undefined, operation: string): number {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new GraphError(operation, 'page.limit', `a page holds 1 to 100000 rows, got ${limit}`);
  return limit;
}

function pageAfter(options: PageOptions | undefined, operation: string): string {
  const after = options?.after;
  if (after === undefined) return '0';
  return checkId(after, operation, 'page.after');
}

/** The visibility predicate for an alias; the lens is always the first three parameters. */
const vis = (alias: string): string =>
  `${alias}.valid_from <= $1::timestamptz AND $1::timestamptz < ${alias}.valid_to AND ${alias}.recorded_from <= $2::timestamptz AND $2::timestamptz < ${alias}.recorded_to AND ${alias}.states @> $3::bigint`;

/** Both ends of the edge alias `e` are seen at the lens; applied on every hop. */
const endsSeen = (edge: string): string =>
  `EXISTS (SELECT 1 FROM node_version s WHERE s.node_id = ${edge}.src_id AND ${vis('s')}) AND EXISTS (SELECT 1 FROM node_version d WHERE d.node_id = ${edge}.dst_id AND ${vis('d')})`;

/** Resolves a lens: defaults to `now`, and `as-is` and `to-be` to the keys of the state chain as recorded at the lens's known time. */
export async function resolveLens(tx: OuterTransaction, lens: GraphLens | undefined, now: string): Promise<ResolvedLens> {
  const valid = instantText(lens?.valid ?? now, 'read', 'lens.valid');
  const known = instantText(lens?.known ?? now, 'read', 'lens.known');
  if (valid === 'infinity' || valid === '-infinity' || known === 'infinity' || known === '-infinity') throw new GraphError('read', 'lens', 'a lens names finite instants');
  const wanted = lens?.state ?? 'as-is';
  if (typeof wanted === 'number') {
    if (!Number.isSafeInteger(wanted) || wanted < 0) throw new GraphError('read', 'lens.state', `a state is a whole non-negative key, 'as-is' or 'to-be', got ${wanted}`);
    return { valid, known, state: wanted };
  }
  if (wanted !== 'as-is' && wanted !== 'to-be') throw new GraphError('read', 'lens.state', `a state is a whole non-negative key, 'as-is' or 'to-be', got ${JSON.stringify(wanted)}`);
  const chain = await readStateChain(tx, { valid, known });
  if (chain.length === 0) return { valid, known, state: ALL_STATES.from };
  return { valid, known, state: (wanted === 'as-is' ? chain[0]! : chain[chain.length - 1]!).stateKey };
}

export interface StateEntry {
  nodeId: GraphId;
  stateKey: number;
  label: string;
}

/** The architecture states seen at a valid and a known time, in chain (key) order. */
export async function readStateChain(tx: OuterTransaction, at: { valid: string; known: string }): Promise<StateEntry[]> {
  const found = await tx.query<Raw>(
    `SELECT v.node_id::text AS node_id, (v.properties->>'stateKey')::bigint::text AS state_key, v.label
     FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $3 AND v.valid_from <= $1::timestamptz AND $1::timestamptz < v.valid_to AND v.recorded_from <= $2::timestamptz AND $2::timestamptz < v.recorded_to
     ORDER BY (v.properties->>'stateKey')::bigint, v.node_id`,
    [at.valid, at.known, STATE_KIND],
  );
  return found.rows.map((r) => ({ nodeId: r['node_id'] as string, stateKey: Number(r['state_key']), label: r['label'] as string }));
}

/** One node as the lens sees it, or null when the lens does not see it. */
export async function readNode(tx: OuterTransaction, id: GraphId, lens: ResolvedLens): Promise<NodeVersionRow | null> {
  const found = await tx.query<Raw>(`SELECT ${NODE_COLUMNS} FROM ${NODE_FROM} WHERE v.node_id = $4::bigint AND ${vis('v')}`, [lens.valid, lens.known, String(lens.state), checkId(id, 'read node', 'node')]);
  return found.rows[0] === undefined ? null : nodeRow(found.rows[0]);
}

async function nodesByIds(tx: OuterTransaction, ids: readonly GraphId[], lens: ResolvedLens): Promise<Map<GraphId, NodeVersionRow>> {
  if (ids.length === 0) return new Map();
  const found = await tx.query<Raw>(`SELECT ${NODE_COLUMNS} FROM ${NODE_FROM} WHERE v.node_id = ANY($4::bigint[]) AND ${vis('v')}`, [lens.valid, lens.known, String(lens.state), `{${[...new Set(ids)].join(',')}}`]);
  return new Map(found.rows.map((r) => [r['node_id'] as string, nodeRow(r)]));
}

/** The edges seen at the lens whose ends are seen too, by keyset on the edge version id, each with its two nodes. */
async function seenEdges(tx: OuterTransaction, lens: ResolvedLens, options: { prefix?: string; where: string; params: readonly unknown[] }, page: PageOptions | undefined, operation: string): Promise<Page<EdgeEntry>> {
  const limit = pageLimit(page, operation);
  const after = pageAfter(page, operation);
  const found = await tx.query<Raw>(
    `${options.prefix ?? ''} SELECT ${EDGE_COLUMNS} FROM ${EDGE_FROM}
     WHERE ${vis('e')} AND ${endsSeen('e')} AND e.id > $4::bigint AND ${options.where}
     ORDER BY e.id LIMIT $5::bigint`,
    [lens.valid, lens.known, String(lens.state), after, String(limit + 1), ...options.params],
  );
  const edges = found.rows.map(edgeRow);
  const more = edges.length > limit;
  const shown = more ? edges.slice(0, limit) : edges;
  const nodes = await nodesByIds(tx, shown.flatMap((e) => [e.src, e.dst]), lens);
  const rows = shown.map((edge) => ({ edge, src: nodes.get(edge.src)!, dst: nodes.get(edge.dst)! }));
  return { rows, next: more ? shown[shown.length - 1]!.versionId : null };
}

/** Who calls the node: the edges of `relation` (the engine's call relation by default) that end at it. */
export function readCallers(tx: OuterTransaction, node: GraphId, lens: ResolvedLens, options?: PageOptions & { relation?: string }): Promise<Page<EdgeEntry>> {
  return seenEdges(tx, lens, { where: 'e.dst_id = $6::bigint AND r.key = $7', params: [checkId(node, 'read callers', 'node'), options?.relation ?? CALLS] }, options, 'read callers');
}

/** What the node calls: the edges of `relation` that start at it. */
export function readCallees(tx: OuterTransaction, node: GraphId, lens: ResolvedLens, options?: PageOptions & { relation?: string }): Promise<Page<EdgeEntry>> {
  return seenEdges(tx, lens, { where: 'e.src_id = $6::bigint AND r.key = $7', params: [checkId(node, 'read callees', 'node'), options?.relation ?? CALLS] }, options, 'read callees');
}

/**
 * The relations of a type within a repository node: the edges of `relation`
 * whose two ends both lie in the repository, that is, are the node itself or
 * reached from it through `containment` (the engine's contains relation by
 * default), every containment hop and node being seen at the lens.
 */
export function readRelationsWithin(tx: OuterTransaction, repository: GraphId, relation: string, lens: ResolvedLens, options?: PageOptions & { containment?: string }): Promise<Page<EdgeEntry>> {
  const prefix = `WITH RECURSIVE members(node_id) AS (
      SELECT v.node_id FROM node_version v WHERE v.node_id = $6::bigint AND ${vis('v')}
      UNION
      SELECT c.dst_id FROM members m JOIN edge_version c ON c.src_id = m.node_id JOIN relation_type cr ON cr.id = c.relation_type_id
      WHERE cr.key = $8 AND ${vis('c')} AND ${endsSeen('c')}
    )`;
  return seenEdges(
    tx,
    lens,
    { prefix, where: 'r.key = $7 AND e.src_id IN (SELECT node_id FROM members) AND e.dst_id IN (SELECT node_id FROM members)', params: [checkId(repository, 'read relations within', 'repository'), relation, options?.containment ?? CONTAINS] },
    options,
    'read relations within',
  );
}

/**
 * The nodes reachable from `start` by one or more hops over the declared
 * relation types, following edges out of a node (`out`) or into it (`in`).
 * `WITH RECURSIVE` over the seen edges: an edge or a node outside the lens
 * stops the walk on that hop. Cycles terminate because a node is visited once.
 */
export async function readTraversal(
  tx: OuterTransaction,
  start: GraphId,
  relations: readonly string[],
  direction: 'out' | 'in',
  lens: ResolvedLens,
  options?: PageOptions,
): Promise<Page<NodeVersionRow>> {
  if (relations.length === 0) throw new GraphError('traverse', 'relations', 'a traversal declares the relation types it follows');
  const limit = pageLimit(options, 'traverse');
  const after = pageAfter(options, 'traverse');
  const [from, to] = direction === 'out' ? ['src_id', 'dst_id'] : ['dst_id', 'src_id'];
  const keys = `{${[...new Set(relations)].sort(byCodePoint).map((k) => `"${k.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  const found = await tx.query<Raw>(
    `WITH RECURSIVE reach(node_id) AS (
       SELECT e.${to} FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
       WHERE e.${from} = $6::bigint AND r.key = ANY($7::text[]) AND ${vis('e')} AND ${endsSeen('e')}
       UNION
       SELECT e.${to} FROM reach p JOIN edge_version e ON e.${from} = p.node_id JOIN relation_type r ON r.id = e.relation_type_id
       WHERE r.key = ANY($7::text[]) AND ${vis('e')} AND ${endsSeen('e')}
     )
     SELECT ${NODE_COLUMNS} FROM reach p JOIN node_version v ON v.node_id = p.node_id JOIN node_kind k ON k.id = v.kind_id
     WHERE ${vis('v')} AND v.node_id > $4::bigint ORDER BY v.node_id LIMIT $5::bigint`,
    [lens.valid, lens.known, String(lens.state), after, String(limit + 1), checkId(start, 'traverse', 'start'), keys],
  );
  const nodes = found.rows.map(nodeRow);
  const more = nodes.length > limit;
  const shown = more ? nodes.slice(0, limit) : nodes;
  return { rows: shown, next: more ? shown[shown.length - 1]!.nodeId : null };
}

/** Reads every page: for results the caller needs whole, so nothing is cut at a page size. */
export async function readAll<T>(fetch: (page: PageOptions) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? {} : { after });
    all.push(...page.rows);
    if (page.next === null) return all;
    after = page.next;
  }
}

export interface DiffEntry {
  edgeId: GraphId;
  relation: string;
  dst: GraphId;
  discriminator: string;
  payloadDigest: string;
}

export interface OutgoingDiff {
  /** The state keys compared, as resolved at the lens's valid and known time. */
  asIs: number;
  toBe: number;
  /** Relations the to-be state has and the as-is state does not. */
  added: DiffEntry[];
  /** Relations the as-is state has and the to-be state does not. */
  removed: DiffEntry[];
  /** Relations both have, with different payloads. */
  changed: { asIs: DiffEntry; toBe: DiffEntry }[];
}

function entryOf(edge: EdgeVersionRow): DiffEntry {
  return { edgeId: edge.edgeId, relation: edge.relation, dst: edge.dst, discriminator: edge.discriminator, payloadDigest: edge.payloadDigest };
}

function byEntry(a: DiffEntry, b: DiffEntry): number {
  const rel = byCodePoint(a.relation, b.relation);
  if (rel !== 0) return rel;
  const dst = BigInt(a.dst) < BigInt(b.dst) ? -1 : BigInt(a.dst) > BigInt(b.dst) ? 1 : 0;
  if (dst !== 0) return dst;
  const disc = byCodePoint(a.discriminator, b.discriminator);
  if (disc !== 0) return disc;
  return BigInt(a.edgeId) < BigInt(b.edgeId) ? -1 : BigInt(a.edgeId) > BigInt(b.edgeId) ? 1 : 0;
}

/** The as-is against to-be diff of a node's outgoing relations, read whole (every page). */
export async function readOutgoingDiff(tx: OuterTransaction, node: GraphId, lens: { valid: string; known: string }): Promise<OutgoingDiff> {
  const asIs = await resolveLens(tx, { valid: lens.valid, known: lens.known, state: 'as-is' }, lens.valid);
  const toBe = await resolveLens(tx, { valid: lens.valid, known: lens.known, state: 'to-be' }, lens.valid);
  const outgoing = async (at: ResolvedLens): Promise<Map<GraphId, EdgeVersionRow>> => {
    const all = await readAll((page) => seenEdges(tx, at, { where: 'e.src_id = $6::bigint', params: [checkId(node, 'diff outgoing', 'node')] }, page, 'diff outgoing'));
    return new Map(all.map((entry) => [entry.edge.edgeId, entry.edge]));
  };
  const before = await outgoing(asIs);
  const after = await outgoing(toBe);
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: { asIs: DiffEntry; toBe: DiffEntry }[] = [];
  for (const [id, edge] of after) {
    const old = before.get(id);
    if (old === undefined) added.push(entryOf(edge));
    else if (old.payloadDigest !== edge.payloadDigest) changed.push({ asIs: entryOf(old), toBe: entryOf(edge) });
  }
  for (const [id, edge] of before) if (!after.has(id)) removed.push(entryOf(edge));
  added.sort(byEntry);
  removed.sort(byEntry);
  changed.sort((a, b) => byEntry(a.toBe, b.toBe));
  return { asIs: asIs.state, toBe: toBe.state, added, removed, changed };
}

export interface ClaimEntry {
  node: NodeVersionRow;
  /** `accepted` exactly when an acceptance seen at the lens names the claim version's digest; otherwise `proposed`. */
  status: 'accepted' | 'proposed';
}

/** The claims seen at the lens with their acceptance read from the acceptance nodes. */
export async function readClaims(tx: OuterTransaction, lens: ResolvedLens, options?: PageOptions): Promise<Page<ClaimEntry>> {
  const limit = pageLimit(options, 'read claims');
  const after = pageAfter(options, 'read claims');
  const found = await tx.query<Raw>(
    `SELECT ${NODE_COLUMNS},
       EXISTS (SELECT 1 FROM node_version a JOIN node_kind ak ON ak.id = a.kind_id
               WHERE ak.key = $7 AND a.properties->>'digest' = v.claim_digest AND ${vis('a')}) AS accepted
     FROM ${NODE_FROM} WHERE k.key = $6 AND ${vis('v')} AND v.node_id > $4::bigint ORDER BY v.node_id LIMIT $5::bigint`,
    [lens.valid, lens.known, String(lens.state), after, String(limit + 1), CLAIM_KIND, ACCEPTANCE_KIND],
  );
  const entries: ClaimEntry[] = found.rows.map((r) => ({ node: nodeRow(r), status: r['accepted'] === true ? 'accepted' : 'proposed' }));
  const more = entries.length > limit;
  const shown = more ? entries.slice(0, limit) : entries;
  return { rows: shown, next: more ? shown[shown.length - 1]!.node.nodeId : null };
}

export interface ContentSpan {
  contentSha256: string;
  start: number;
  end: number;
}

/** The bytes of a content node (all of them, or a half-open byte span), found by the content digest; null when no content node has that digest. Content never changes, so no lens applies. */
export async function readContentBytes(tx: OuterTransaction, contentSha256: string, span?: ByteSpan): Promise<Uint8Array | null> {
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new GraphError('read content', 'contentSha256', `${JSON.stringify(contentSha256)} is not a SHA-256 hex digest`);
  if (span !== undefined && (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start)) {
    throw new GraphError('read content', 'span', `a byte span is half-open with 0 <= start <= end, got [${span.start}, ${span.end})`);
  }
  const found = await tx.query<{ hex: string; size: string }>(
    `SELECT encode(CASE WHEN $2::bigint IS NULL THEN v.content ELSE substring(v.content from (($2::bigint + 1)::int) for (($3::bigint - $2::bigint)::int)) END, 'hex') AS hex, length(v.content)::text AS size
     FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = $4 AND v.content_sha256 = $1 LIMIT 1`,
    [contentSha256, span === undefined ? null : String(span.start), span === undefined ? null : String(span.end), CONTENT_KIND],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  if (span !== undefined && span.end > Number(row.size)) throw new GraphError('read content', 'span', `the span [${span.start}, ${span.end}) reaches past the ${row.size} bytes of content ${contentSha256}`);
  return Uint8Array.from(Buffer.from(row.hex, 'hex'));
}
