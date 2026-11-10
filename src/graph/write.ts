/**
 * The graph's one writer (decision 0033, item 3: one writer per store; decision
 * 0034, item 14, and its amendment of 2026-11-10, A1–A4): the one place a
 * producer's answer becomes opinions. It writes inside the transaction the caller
 * already opened — a publication's own, so a unit publishes with its opinions or
 * not at all — and it knows the mechanism, never a product's kind: the kind, its
 * table, its columns and its key come from the contract the product took.
 *
 * **Identity.** An entity is named by its kind and its key values; a reference in
 * a key is the referenced entity's kind and key. The writer resolves the reference
 * to the node it names, derives the vertex's uid from the canonical key
 * (`src/graph/uid.ts`) and upserts the node with its key, so a second publication
 * of the same entity finds it and a removed entity that comes back is live again.
 *
 * **No field is authoritative.** Every value a producer states is an opinion: one
 * row of the kind's own table, with the producer and its version, the evidence it
 * rests on and the language of a text value. A rerun of the same answer writes
 * nothing; a changed value closes the producer's open opinion and opens a new one;
 * a removal closes the producer's opinions and marks the vertex removed. Nothing
 * here picks a winner between producers: the agent confirms, in a change of its own
 * (A4).
 */
import type { SqlExecutor } from '../sql-driver.js';
import { type ClaimDraft, type ClaimEvidenceDraft, type EntityRefDraft, type FieldContract, type GraphContract, type KeyValueDraft, type VertexContract, type VertexDraft, type VertexRemovalDraft } from './contract.js';
import { keyUid } from './uid.js';

/** Where a refusal stands. */
const WHERE = 'src/graph/write.ts';

/** A table, column or key name: the shape a generated table carries. */
function quote(name: string, what: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error(`${WHERE}:1: the ${what} ${JSON.stringify(name)} is not a lower-case identifier`);
  return `"${name}"`;
}

/** The declared vertex kind a draft names, or the refusal naming it. */
function vertexOf(contract: GraphContract, kind: string): VertexContract {
  const found = contract.vertex.find((held) => held.name === kind);
  if (found === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(kind)} is no kind the product declares: the writer takes the contract the product took, and it holds ${contract.vertex.length === 0 ? 'none' : contract.vertex.map((one) => one.name).join(', ')}`);
  return found;
}

/** The declared edge kind a draft names, or the refusal naming it. */
function edgeOfKind(contract: GraphContract, kind: string): { readonly name: string; readonly table: string } {
  const found = contract.edge.find((held) => held.name === kind);
  if (found === undefined) throw new Error(`${WHERE}:1: the edge kind ${JSON.stringify(kind)} is no kind the product declares: the contract holds ${contract.edge.length === 0 ? 'none' : contract.edge.map((one) => one.name).join(', ')}`);
  if (found.table === undefined) throw new Error(`${WHERE}:1: the edge kind ${JSON.stringify(kind)} declares no attribute table`);
  return { name: found.name, table: found.table };
}

/** A value with the keys of every object in code point order, so two equal values render equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const held = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(held).sort().map((key) => [key, canonical(held[key])]));
  }
  return value;
}

/** A value as one stable text: the digest of a key is taken over this, never over a key's order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Whether two values are the same value, as JSON states them with their keys in code point order. */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

/** Whether two column values say the same thing: a timestamp the driver hands back as a clock, a text as its own text. */
function sameColumn(left: unknown, right: unknown): boolean {
  const instant = (value: unknown): number | undefined => (value instanceof Date ? value.getTime() : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : undefined);
  const held = instant(left);
  const stated = instant(right);
  if (held !== undefined && stated !== undefined) return held === stated;
  return sameValue(left, right);
}

/** One key field's declaration: the vertex's key field, which is a field of the contract. */
function keyFieldOf(vertex: VertexContract, field: string): FieldContract {
  const held = vertex.fields.find((one) => one.name === field);
  if (held === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(vertex.name)} is keyed by ${JSON.stringify(field)}, and its contract declares no such field: it declares ${vertex.fields.map((one) => one.name).join(', ')}`);
  return held;
}

/** The node one reference names, by the referenced entity's kind and key values. */
async function referencedNodeOf(executor: SqlExecutor, ref: EntityRefDraft, where: string): Promise<{ nodeId: string; key: Record<string, unknown> }> {
  if (typeof ref.kind !== 'string' || ref.key === null || typeof ref.key !== 'object') throw new Error(`${WHERE}:1: ${where} names a reference that is no {kind, key}`);
  const fields = Object.keys(ref.key).sort();
  if (fields.length === 0) throw new Error(`${WHERE}:1: ${where} names a reference to a ${JSON.stringify(ref.kind)} with no key value`);
  const uid = keyUid(ref.kind, [canonicalJson(Object.fromEntries(fields.map((field) => [field, ref.key[field]])))]);
  const found = await executor.query<{ id: string; key: unknown }>(`SELECT id::text AS id, key FROM node WHERE uid = $1::uuid`, [uid]);
  const row = found.rows[0];
  if (row === undefined) throw new Error(`${WHERE}:1: ${where} names a ${JSON.stringify(ref.kind)} with key ${canonicalJson(ref.key)}, and no such entity stands: a producer naming a key no entity holds refers to nothing (the consistency check reports it, and no second entity is made)`);
  return { nodeId: row.id, key: (row.key ?? {}) as Record<string, unknown> };
}

/**
 * The canonical key of one draft and the uid it gives: every value in the key's own field order, a reference resolved
 * to the entity it names and that entity's key values.
 */
async function keyOf(executor: SqlExecutor, vertex: VertexContract, draft: Readonly<Record<string, KeyValueDraft>>): Promise<{ key: Record<string, unknown>; uid: string }> {
  const key: Record<string, unknown> = {};
  for (const field of vertex.key) {
    const declared = keyFieldOf(vertex, field);
    const value = draft[field];
    if (value === undefined || (typeof value === 'string' && value === '')) throw new Error(`${WHERE}:1: an entity of the kind ${JSON.stringify(vertex.name)} names no ${JSON.stringify(field)}: its key is ${vertex.key.join(', ')}`);
    if (declared.reference !== undefined) {
      if (typeof value !== 'object') throw new Error(`${WHERE}:1: the key field ${JSON.stringify(field)} of ${JSON.stringify(vertex.name)} names a ${JSON.stringify(declared.reference)}, and the draft names ${JSON.stringify(value)}: a reference is {kind, key}`);
      const ref = value as EntityRefDraft;
      if (ref.kind !== declared.reference && ref.kind !== `code.${declared.reference}`) throw new Error(`${WHERE}:1: the key field ${JSON.stringify(field)} of ${JSON.stringify(vertex.name)} names a ${JSON.stringify(declared.reference)}, and the draft names a ${JSON.stringify(ref.kind)}`);
      const named = await referencedNodeOf(executor, ref, `the key field ${JSON.stringify(field)} of ${JSON.stringify(vertex.name)}`);
      key[field] = { kind: ref.kind, key: named.key };
      continue;
    }
    if (typeof value === 'object') throw new Error(`${WHERE}:1: the key field ${JSON.stringify(field)} of ${JSON.stringify(vertex.name)} is no reference, and the draft names an object`);
    key[field] = typeof value === 'number' ? value : String(value);
  }
  return { key, uid: keyUid(vertex.name, [canonicalJson(key)]) };
}

/** The id of a kind's row in `entity`, made where the contract declares it and the store holds none. */
async function entityIdOf(executor: SqlExecutor, kind: string, sort: 'node' | 'edge'): Promise<string> {
  const made = await executor.query<{ id: string }>(
    `INSERT INTO entity (name, sort) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id::text AS id`,
    [kind, sort],
  );
  const id = made.rows[0]?.id;
  if (id === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(kind)} was registered and the store answered no id`);
  return id;
}

/** The node an entity is, with its key, made where the store holds none; a removed one is live again. */
export async function ensureVertex(executor: SqlExecutor, contract: GraphContract, draft: Pick<VertexDraft, 'kind' | 'key'>, contextId = 1): Promise<{ nodeId: string; uid: string; created: boolean; revived: boolean }> {
  const vertex = vertexOf(contract, draft.kind);
  const { key, uid } = await keyOf(executor, vertex, draft.key);
  const held = await executor.query<{ id: string; removed: boolean }>(`SELECT id::text AS id, removed FROM node WHERE uid = $1::uuid`, [uid]);
  const existing = held.rows[0];
  if (existing === undefined) {
    const entityId = await entityIdOf(executor, vertex.name, 'node');
    const node = await executor.query<{ id: string }>(`INSERT INTO node (entity_id, uid, key, context_id) VALUES ($1::bigint, $2::uuid, $3::jsonb, $4::bigint) RETURNING id::text AS id`, [entityId, uid, canonicalJson(key), String(contextId)]);
    const nodeId = node.rows[0]?.id;
    if (nodeId === undefined) throw new Error(`${WHERE}:1: the node of ${JSON.stringify(draft.kind)} and ${canonicalJson(key)} was written and the store answered no id`);
    return { nodeId, uid, created: true, revived: false };
  }
  if (existing.removed) {
    await executor.query(`UPDATE node SET removed = false WHERE id = $1::bigint`, [existing.id]);
    return { nodeId: existing.id, uid, created: false, revived: true };
  }
  return { nodeId: existing.id, uid, created: false, revived: false };
}

/** The evidence list of one opinion: every place its values were read, once each. */
function evidenceList(draft: Pick<VertexDraft, 'evidence' | 'claims'>): readonly Record<string, unknown>[] {
  const places: Record<string, unknown>[] = [];
  const add = (evidence: ClaimEvidenceDraft | undefined): void => {
    if (evidence === undefined) return;
    if (evidence.repository === undefined && evidence.commit === undefined && evidence.path === undefined) return;
    const held: Record<string, unknown> = {
      ...(evidence.repository === undefined ? {} : { repository: evidence.repository }),
      ...(evidence.commit === undefined ? {} : { commit_or_digest: evidence.commit }),
      ...(evidence.path === undefined ? {} : { path: evidence.path }),
      ...(evidence.lineStart === undefined ? {} : { line_start: evidence.lineStart }),
      ...(evidence.lineEnd === undefined ? {} : { line_end: evidence.lineEnd }),
    };
    const rendered = canonicalJson(held);
    if (!places.some((one) => canonicalJson(one) === rendered)) places.push(held);
  };
  add(draft.evidence);
  for (const claim of draft.claims ?? []) add(claim.evidence);
  return places;
}

/** The field values one opinion states: the authoritative attributes and the claimed fields, one value per field. */
function valuesOf(vertex: VertexContract, draft: Pick<VertexDraft, 'kind' | 'attributes' | 'claims'>): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [field, value] of Object.entries(draft.attributes ?? {})) {
    if (vertex.key.includes(field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} is keyed by ${JSON.stringify(field)}, and the key is not an opinion: its value is the vertex's`);
    if (!vertex.fields.some((one) => one.name === field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} declares no field ${JSON.stringify(field)}: its fields are ${vertex.fields.map((one) => one.name).join(', ')}`);
    values.set(field, value);
  }
  for (const claim of draft.claims ?? []) {
    if (claim.field === '') throw new Error(`${WHERE}:1: an opinion of the kind ${JSON.stringify(draft.kind)} names no field`);
    if (vertex.key.includes(claim.field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} is keyed by ${JSON.stringify(claim.field)}, and the key is not an opinion`);
    if (!vertex.fields.some((one) => one.name === claim.field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} declares no field ${JSON.stringify(claim.field)}: its fields are ${vertex.fields.map((one) => one.name).join(', ')}`);
    values.set(claim.field, claim.value);
  }
  return values;
}

/**
 * States one opinion of a vertex or an edge: the producer's open opinion is closed where its values moved, and a new
 * open row stands with them; a rerun of the same answer writes nothing. Answers whether it wrote.
 */
async function stateOpinion(executor: SqlExecutor, table: string, owner: 'node_id' | 'edge_id', ownerId: string, saidBy: string, values: ReadonlyMap<string, unknown>, evidence: readonly Record<string, unknown>[], lang: string | null, contextId = 1): Promise<boolean> {
  const columns = [...values.keys()];
  const held = await executor.query<Record<string, unknown>>(
    `SELECT "id"::text AS id, ${columns.length === 0 ? '' : `${columns.map((column) => `${quote(column, 'column')}, `).join('')}`}"evidence", "lang" FROM ${table} WHERE ${quote(owner, 'column')} = $1::bigint AND "said_by" = $2 AND "state" = 'open' AND "context_id" = $3::bigint ORDER BY "id" DESC LIMIT 1`,
    [ownerId, saidBy, String(contextId)],
  );
  const open = held.rows[0];
  if (open !== undefined) {
    // The value and the language are what a producer states; the evidence of an unchanged value is not a new opinion.
    const same = (open['lang'] ?? null) === lang && columns.every((column) => sameColumn(open[column], values.get(column) ?? null));
    if (same) return false;
    await executor.query(`UPDATE ${table} SET "state" = 'closed' WHERE "id" = $1::bigint`, [String(open['id'])]);
  }
  const insertColumns = [...columns, 'said_by', 'evidence', 'lang', 'context_id', owner];
  // A JSON value is sent as its own text: this driver would otherwise write an array as a PostgreSQL array.
  const paramOf = (value: unknown): unknown => (value !== null && typeof value === 'object' ? canonicalJson(value) : value);
  const params: unknown[] = [...columns.map((column) => paramOf(values.get(column))), saidBy, canonicalJson(evidence), lang, String(contextId), ownerId];
  await executor.query(
    `INSERT INTO ${table} (${insertColumns.map((column) => quote(column, 'column')).join(', ')}) VALUES (${insertColumns.map((_, at) => `$${String(at + 1)}`).join(', ')})`,
    params,
  );
  return true;
}

/**
 * One opinion of one vertex's fields, stated by a producer against a node the caller already holds: the kind's table
 * keeps it, or the producer's open opinion is closed and a new one opened where the values moved. Answers whether it
 * wrote, so a rerun of the same answer writes nothing.
 */
export async function publishOpinion(executor: SqlExecutor, contract: GraphContract, draft: { readonly kind: string; readonly nodeId: string; readonly attributes?: Readonly<Record<string, unknown>>; readonly claims?: readonly ClaimDraft[]; readonly evidence?: ClaimEvidenceDraft; readonly evidenceRows?: readonly Record<string, unknown>[]; readonly lang?: string | null; readonly producer: string; readonly producerVersion: string }, contextId = 1): Promise<boolean> {
  const vertex = vertexOf(contract, draft.kind);
  const values = valuesOf(vertex, { kind: draft.kind, ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }), ...(draft.claims === undefined ? {} : { claims: draft.claims }) });
  const evidence = draft.evidenceRows ?? evidenceList({ ...(draft.evidence === undefined ? {} : { evidence: draft.evidence }), ...(draft.claims === undefined ? {} : { claims: draft.claims }) });
  return await stateOpinion(executor, vertex.table, 'node_id', draft.nodeId, `${draft.producer}@${draft.producerVersion}`, values, evidence, draft.lang ?? null, contextId);
}

/**
 * One vertex as a producer answered it: its node and key, and one opinion of the kind's fields with its evidence and its
 * language. Answers how many rows the publication wrote — none for a rerun of the same answer.
 */
export async function publishVertex(executor: SqlExecutor, contract: GraphContract, draft: VertexDraft, contextId = 1): Promise<number> {
  const vertex = vertexOf(contract, draft.kind);
  const { nodeId, created, revived } = await ensureVertex(executor, contract, draft, contextId);
  const values = valuesOf(vertex, draft);
  const saidBy = `${draft.producer}@${draft.producerVersion}`;
  const written = await stateOpinion(executor, vertex.table, 'node_id', nodeId, saidBy, values, evidenceList(draft), draft.lang ?? null, contextId);
  return (created ? 1 : 0) + (revived ? 1 : 0) + (written ? 1 : 0);
}

/**
 * One opinion of an edge kind's fields, stated by a producer: the edge's attribute table holds it, keyed by `edge_id`.
 * The edge's ends and discriminator are its identity and stand in `edge`, never here.
 */
export async function publishEdgeOpinion(executor: SqlExecutor, contract: GraphContract, edgeKind: string, edgeId: string, draft: { readonly values: ReadonlyMap<string, unknown>; readonly evidence?: readonly Record<string, unknown>[]; readonly lang?: string | null; readonly producer: string; readonly producerVersion: string }, contextId = 1): Promise<boolean> {
  const kind = edgeOfKind(contract, edgeKind);
  return await stateOpinion(executor, kind.table, 'edge_id', edgeId, `${draft.producer}@${draft.producerVersion}`, draft.values, draft.evidence ?? [], draft.lang ?? null, contextId);
}

/**
 * One entity the producer no longer holds: its open opinions are closed and the vertex is marked removed, so the reads
 * drop it. A later opinion of the same entity brings it back.
 */
export async function removeEntity(executor: SqlExecutor, contract: GraphContract, draft: VertexRemovalDraft, contextId = 1): Promise<boolean> {
  const vertex = vertexOf(contract, draft.kind);
  const { uid } = await keyOf(executor, vertex, draft.key);
  const node = await executor.query<{ id: string; removed: boolean }>(`SELECT id::text AS id, removed FROM node WHERE uid = $1::uuid`, [uid]);
  const held = node.rows[0];
  if (held === undefined) return false;
  const closed = await executor.query(
    `UPDATE ${vertex.table} SET "state" = 'closed' WHERE "node_id" = $1::bigint AND split_part("said_by", '@', 1) = $2 AND "state" = 'open' AND "context_id" = $3::bigint RETURNING "id"`,
    [held.id, draft.producer, String(contextId)],
  );
  await executor.query(`UPDATE node SET removed = true WHERE id = $1::bigint`, [held.id]);
  return held.removed === false || closed.rows.length > 0;
}

/** The drafts one publication applies, by the kind of write they are. */
export interface GraphDrafts {
  readonly vertices: readonly VertexDraft[];
  readonly removals: readonly VertexRemovalDraft[];
}

/** Every draft of one publication, applied in order inside the caller's transaction; answers how many rows were written. */
export async function publishGraphDrafts(executor: SqlExecutor, contract: GraphContract, drafts: GraphDrafts): Promise<number> {
  let written = 0;
  for (const draft of drafts.removals) if (await removeEntity(executor, contract, draft)) written += 1;
  for (const draft of drafts.vertices) written += await publishVertex(executor, contract, draft);
  return written;
}
