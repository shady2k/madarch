/**
 * The graph's one writer (decision 0033, item 3: one writer per store; decision
 * 0034, item 14: a kind's table is built from its contract): the one place a
 * producer's answer becomes rows. It writes inside the transaction the caller
 * already opened — a publication's own, so a unit publishes with its claims or
 * not at all — and it knows the mechanism, never a product's kind: the kind, its
 * table, its columns and its key come from the contract the manifest's
 * declarations made.
 *
 * **Identity.** An entity is named by its kind and its natural key values; the
 * writer derives the node's uid from them (`src/graph/uid.ts`) and upserts the
 * node and its table's row, so a second publication of the same entity finds it
 * and a removed entity that comes back is live again.
 *
 * **Claims are kept, never overwritten.** A claim equal to the producer's newest
 * claim of the same field is not written again, so a rerun of the same bytes
 * writes nothing; a different value is a new claim beside the old one, with its
 * evidence. A removal withdraws the producer's claims of the entity and marks the
 * entity tombstoned; the read path drops tombstoned rows, and the node keeps its
 * identity (a later claim brings it back).
 */
import type { SqlExecutor } from '../sql-driver.js';
import { generatedTableName, type ClaimEvidenceDraft, type GraphContract, type VertexContract, type VertexDraft, type VertexRemovalDraft } from './contract.js';
import { keyUid } from './uid.js';

/** Where a refusal stands. */
const WHERE = 'src/graph/write.ts';

/** The path dictionary's offered name, the one the contract declares (decision 0034, item 13). */
const PATH_DICTIONARY = 'path';

/** A table, column or key name: the shape a generated table carries. */
function quote(name: string, what: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error(`${WHERE}:1: the ${what} ${JSON.stringify(name)} is not a lower-case identifier`);
  return `"${name}"`;
}

/** The declared vertex kind a draft names, or the refusal naming it. */
function vertexOf(contract: GraphContract, kind: string): VertexContract {
  const found = contract.vertex.find((held) => held.name === kind);
  if (found === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(kind)} is no kind the product's manifest declares: the writer takes the contract the manifest's declarations made, and it holds ${contract.vertex.length === 0 ? 'none' : contract.vertex.map((one) => one.name).join(', ')}`);
  return found;
}

/** The key values of a draft, in the contract's key order; a missing or empty one is refused by name. */
function keyValues(kind: VertexContract, key: Readonly<Record<string, string | number>>): string[] {
  return kind.key.map((field) => {
    const value = key[field];
    if (value === undefined || String(value) === '') throw new Error(`${WHERE}:1: an entity of the kind ${JSON.stringify(kind.name)} names no ${JSON.stringify(field)}: its key is ${kind.key.join(', ')}`);
    return String(value);
  });
}

/** The dictionary table's name, from the contract's own declaration of the path dictionary. */
function pathTable(contract: GraphContract): string | undefined {
  return contract.dictionary.some((one) => one.name === PATH_DICTIONARY) ? generatedTableName(PATH_DICTIONARY, 'dictionary') : undefined;
}

/** The id of one path text, interned once in the dictionary. */
async function internPath(executor: SqlExecutor, table: string, text: string): Promise<string> {
  const found = await executor.query<{ id: string }>(`INSERT INTO ${table} ("text") VALUES ($1) ON CONFLICT ("text") DO UPDATE SET "text" = EXCLUDED."text" RETURNING id::text AS id`, [text]);
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error(`${WHERE}:1: the path ${JSON.stringify(text)} was interned and the dictionary answered no id`);
  return id;
}

/** One evidence row under a vertex or a claim: the repository, the commit or digest, the path and the lines. */
async function writeEvidence(executor: SqlExecutor, contract: GraphContract, owner: { readonly nodeId?: string; readonly claimId?: string }, evidence: ClaimEvidenceDraft, producer: string): Promise<void> {
  const table = pathTable(contract);
  const path = evidence.path;
  const pathId = path !== undefined && path !== '' && table !== undefined ? await internPath(executor, table, path) : null;
  await executor.query(
    `INSERT INTO evidence (node_id, claim_id, repository, commit_or_digest, path_id, line_start, line_end, producer) VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, $6::int, $7::int, $8)`,
    [owner.nodeId ?? null, owner.claimId ?? null, evidence.repository ?? null, evidence.commit ?? null, pathId, evidence.lineStart ?? null, evidence.lineEnd ?? null, producer],
  );
}

/**
 * The node an entity is and its table's row, made live with the draft's
 * authoritative values; the same entity found on a second publication. The
 * key's columns are the row's identity; the other columns are written only by a
 * draft that names them, so a producer that reads one field leaves the rest.
 * `changed` is false when the row already holds exactly these values and is
 * live, which is what makes a rerun write nothing.
 */
export async function ensureVertex(executor: SqlExecutor, contract: GraphContract, draft: VertexDraft, contextId = 1): Promise<{ nodeId: string; changed: boolean }> {
  const vertex = vertexOf(contract, draft.kind);
  const values = keyValues(vertex, draft.key);
  const attributes = Object.entries(draft.attributes ?? {});
  for (const [field] of attributes) {
    if (!vertex.fields.some((one) => one.name === field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} declares no authoritative field ${JSON.stringify(field)} as a column: its columns are ${vertex.fields.map((one) => one.name).join(', ')}`);
  }
  const uid = keyUid(draft.kind, values);
  const held = await executor.query<{ id: string }>(`SELECT id::text AS id FROM node WHERE uid = $1::uuid`, [uid]);
  const existing = held.rows[0]?.id;
  if (existing === undefined) {
    const kindRow = await executor.query<{ id: string }>(`INSERT INTO kind (name, sort) VALUES ($1, 'node') ON CONFLICT (name) DO UPDATE SET sort = 'node', repeats = false, discriminator = NULL RETURNING id::text AS id`, [draft.kind]);
    const kindId = kindRow.rows[0]?.id;
    if (kindId === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} was registered and the store answered no id`);
    const node = await executor.query<{ id: string }>(`INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id`, [kindId, uid]);
    const nodeId = node.rows[0]?.id;
    if (nodeId === undefined) throw new Error(`${WHERE}:1: the node of ${JSON.stringify(draft.kind)} and ${JSON.stringify(values)} was written and the store answered no id`);
    await insertRow(executor, vertex, nodeId, contextId, values, attributes);
    if (attributes.length > 0 && draft.evidence !== undefined) await writeEvidence(executor, contract, { nodeId }, draft.evidence, draft.producer);
    return { nodeId, changed: true };
  }
  const wanted = new Map<string, unknown>([...vertex.key.map((field, at) => [field, values[at]] as const), ...attributes]);
  const currently = await readRow(executor, vertex, existing);
  let changed = currently === undefined || currently.tombstone;
  if (currently !== undefined && !changed) {
    for (const [field, value] of wanted) if (!sameValue(currently.values.get(field), value === undefined ? null : value)) { changed = true; break; }
  }
  if (changed) {
    await updateRow(executor, vertex, existing, contextId, values, attributes);
    if (attributes.length > 0 && draft.evidence !== undefined) await writeEvidence(executor, contract, { nodeId: existing }, draft.evidence, draft.producer);
  }
  return { nodeId: existing, changed };
}

/** One row of a generated table's key and attribute columns, and whether it is tombstoned. */
async function readRow(executor: SqlExecutor, vertex: VertexContract, nodeId: string): Promise<{ values: Map<string, unknown>; tombstone: boolean } | undefined> {
  const columns = vertex.fields.map((field) => quote(field.name, 'column')).join(', ');
  const found = await executor.query<Record<string, unknown>>(`SELECT ${columns}, "tombstone" FROM ${vertex.table} WHERE node_id = $1::bigint`, [nodeId]);
  const row = found.rows[0];
  if (row === undefined) return undefined;
  return { values: new Map(vertex.fields.map((field) => [field.name, row[field.name]])), tombstone: row['tombstone'] === true };
}

/** The insert of one generated row: the node, the context, the key's values and the attributes the draft names. */
async function insertRow(executor: SqlExecutor, vertex: VertexContract, nodeId: string, contextId: number, values: readonly string[], attributes: readonly (readonly [string, unknown])[]): Promise<void> {
  const columns = ['node_id', 'context_id', ...vertex.key, ...attributes.map(([field]) => field)];
  const params: unknown[] = [nodeId, String(contextId), ...values, ...attributes.map(([, value]) => value === undefined ? null : value)];
  await executor.query(
    `INSERT INTO ${vertex.table} (${columns.map((column) => quote(column, 'column')).join(', ')}, "tombstone") VALUES (${columns.map((_, at) => `$${String(at + 1)}`).join(', ')}, false)`,
    params,
  );
}

/** The update of one generated row; the key's values are its identity and stand as they are. */
async function updateRow(executor: SqlExecutor, vertex: VertexContract, nodeId: string, contextId: number, values: readonly string[], attributes: readonly (readonly [string, unknown])[]): Promise<void> {
  const sets = ['context_id = $2::bigint', '"tombstone" = false', ...attributes.map(([field], at) => `${quote(field, 'column')} = $${String(at + 3)}`)];
  const params: unknown[] = [nodeId, String(contextId), ...attributes.map(([, value]) => value === undefined ? null : value)];
  const where = vertex.key.map((field, at) => `${quote(field, 'column')} = $${String(at + 3 + attributes.length)}`).join(' AND ');
  await executor.query(`UPDATE ${vertex.table} SET ${sets.join(', ')} WHERE node_id = $1::bigint${where === '' ? '' : ` AND ${where}`}`, [...params, ...values]);
}

/** Whether two claim values are the same value, as JSON states them with their keys in code point order. */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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

/** One claim, written with its evidence unless the producer's newest claim of the field already holds that value. */
async function writeClaim(executor: SqlExecutor, contract: GraphContract, nodeId: string, draft: VertexDraft, field: string, value: unknown, evidence: ClaimEvidenceDraft | undefined): Promise<boolean> {
  const held = await executor.query<{ id: string; value: unknown }>(
    `SELECT id::text AS id, value FROM claim WHERE node_id = $1::bigint AND attribute = $2 AND producer = $3 ORDER BY id DESC LIMIT 1`,
    [nodeId, field, draft.producer],
  );
  const newest = held.rows[0];
  if (newest !== undefined && sameValue(newest.value, value)) return false;
  const claim = await executor.query<{ id: string }>(
    `INSERT INTO claim (node_id, attribute, value, producer, producer_version) VALUES ($1::bigint, $2, $3::jsonb, $4, $5) RETURNING id::text AS id`,
    [nodeId, field, JSON.stringify(value === undefined ? null : value), draft.producer, draft.producerVersion],
  );
  const claimId = claim.rows[0]?.id;
  if (claimId === undefined) throw new Error(`${WHERE}:1: the claim of ${JSON.stringify(field)} was written and the store answered no id`);
  if (evidence !== undefined) await writeEvidence(executor, contract, { claimId }, evidence, draft.producer);
  return true;
}

/**
 * One vertex as a producer answered it: its node and row, its authoritative
 * values, and every claim it makes. Answers how many rows the publication wrote
 * — none for a rerun of the same answer.
 */
export async function publishVertex(executor: SqlExecutor, contract: GraphContract, draft: VertexDraft): Promise<number> {
  const { nodeId, changed } = await ensureVertex(executor, contract, draft);
  let written = changed ? 1 : 0;
  for (const claim of draft.claims ?? []) {
    if (claim.field === '') throw new Error(`${WHERE}:1: a claim of the kind ${JSON.stringify(draft.kind)} names no field`);
    if (await writeClaim(executor, contract, nodeId, draft, claim.field, claim.value, claim.evidence)) written += 1;
  }
  return written;
}

/**
 * One entity the producer no longer holds: its claims are withdrawn with their
 * evidence, and the entity is tombstoned so the read path stops showing it. A
 * later claim of the same entity brings it back.
 */
export async function removeEntity(executor: SqlExecutor, contract: GraphContract, draft: VertexRemovalDraft): Promise<boolean> {
  const vertex = vertexOf(contract, draft.kind);
  const values = keyValues(vertex, draft.key);
  const node = await executor.query<{ id: string }>(
    `SELECT n.id::text AS id FROM node n JOIN kind k ON k.id = n.kind_id WHERE k.name = $1 AND n.uid = $2::uuid`,
    [draft.kind, keyUid(draft.kind, values)],
  );
  const nodeId = node.rows[0]?.id;
  if (nodeId === undefined) return false;
  const claims = await executor.query<{ id: string }>(`SELECT id::text AS id FROM claim WHERE node_id = $1::bigint AND producer = $2`, [nodeId, draft.producer]);
  if (claims.rows.length > 0) {
    const ids = claims.rows.map((row) => row.id).join(',');
    await executor.query(`DELETE FROM evidence WHERE claim_id IN (${ids})`);
    await executor.query(`DELETE FROM claim WHERE id IN (${ids})`);
  }
  await executor.query(`UPDATE ${vertex.table} SET "tombstone" = true WHERE "node_id" = $1::bigint`, [nodeId]);
  return claims.rows.length > 0;
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
