/**
 * The graph's one writer (decision 0033, item 3: one writer per store; decision 0034, item 14, and its amendment of
 * 2026-11-10, A1–A4; the review of stage 1): the one place a producer's answer becomes opinions, and the only module
 * that writes the graph's rows. It writes inside the transaction the caller already opened — a publication's own, so a
 * unit publishes with its opinions or not at all — and it knows the mechanism, never a product's kind: the kind, its
 * table, its columns and its key come from the contract the product took.
 *
 * **Identity.** An entity is named by its kind and its key values, each normalised by the contract's field type (a
 * text key's `1` and `"1"` are one value) and stated in the contract's key order; a reference in a key is the
 * referenced entity's kind and key, normalised by that entity's own contract. The writer derives the vertex's uid
 * from the canonical key and declares the node with `INSERT … ON CONFLICT DO NOTHING` and a read, so two concurrent
 * declarations of one vertex both find it. A kind with no key gets a random uid and an empty key.
 *
 * **No field is authoritative.** Every value a producer states is an opinion: one row of the kind's own table, with
 * the producer and its version, the evidence it rests on and the language of a text value. A producer is matched by
 * its name without its version, its node, its language and its context, so a new version supersedes the old version's
 * opinion; one publication states the producer's whole opinion of the entity, and a field it leaves out is a field it
 * has no opinion on. A rerun of the same answer writes nothing; changed evidence under an unchanged value updates the
 * row's evidence (journaled from stage 2), never opening a second opinion; a changed value closes the producer's open
 * opinion and opens a new one; a removal closes only its own producer's opinions, and the vertex is removed when no
 * open opinion of any producer remains.
 *
 * **Declarations before references.** A publication declares its vertices first (which creates a node if absent) and
 * only then resolves the references its keys and its edges name. A reference to a key no vertex holds is recorded in
 * `unresolved_reference` (the consistency plugin madarch-stm0.7 reads it) and the rest of the publication goes on; it
 * never creates the vertex it names.
 */
import { randomUUID } from 'node:crypto';
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import { type EdgeDraft, type EdgeRemovalDraft, type EntityRefDraft, type EvidenceDraft, type EvidenceEntry, type FieldContract, type GraphContract, type KeyValueDraft, type VertexContract, type VertexDraft, type VertexRemovalDraft } from './contract.js';
export type { EdgeDraft, EdgeRemovalDraft } from './contract.js';
import { keyUid } from './uid.js';

/** Where a refusal stands: the module, and a line this file cannot name for a statement built at run time. */
const WHERE = 'src/graph/write.ts';

/**
 * The journal of every change (decision 0034, its amendment A5, and stage 2): each publication's unit — a plugin's turn,
 * a record pass — and each operation a person or the agent makes is one `operation` row, written in the same transaction
 * as the change and only from this writer. Its author is the producer and its version, `agent`, or `person:<uid>`; the
 * change names the vertices and edges declared or removed and the opinions opened, closed or re-evidenced, by id.
 *
 * **Foldable.** Every event names its vertex by its stable uid and every opinion by its own id, so playing consecutive
 * entries in order gives, per vertex, the opinions that stand open and the fields each states: `opened` adds an
 * opinion, `closed` removes it, `re-evidenced` keeps it (its grounds moved), a `removed` vertex drops all of them and a
 * `declared` one brings it back. That is the net change a snapshot folds in at stage 3.
 */
export interface JournalVertexEvent {
  readonly entity: string;
  /** The vertex's stable id, the same on every machine. */
  readonly uid: string;
  /** Its canonical key, stated on a declaration: replay makes the vertex from the entity and the key it names. */
  readonly key?: Readonly<Record<string, unknown>>;
  /** Its local node id, for a replay into this store. */
  readonly node: string;
  readonly state: 'declared' | 'removed';
}

/**
 * One edge's event: its identity is the kind, its ends (by uid) and its discriminator; `edge` is its local id when
 * read. A replay makes the edge from the uids its declaration names, never from a local id of another store.
 */
export interface JournalEdgeEvent {
  readonly entity: string;
  readonly edge: string;
  readonly from: string;
  readonly to: string;
  readonly discriminator: string;
  readonly context: number;
  readonly state: 'declared' | 'removed';
}

/**
 * One opinion's event, carrying what a replay needs: `opened` states the row's whole content — its producer and version,
 * its values (every field of the kind, a field it has no opinion on as null), its evidence, its language, the opinion it
 * was translated from and the digest of its source, its context and the moment it was said; `re-evidenced` states the
 * grounds that replaced the row's; `closed` needs its id alone. `node` is the vertex's uid and `edge` its local id.
 */
export interface JournalOpinionEvent {
  readonly id: string;
  readonly entity: string;
  readonly node?: string;
  readonly edge?: string;
  readonly state: 'opened' | 'closed' | 're-evidenced';
  readonly fields: readonly string[];
  readonly lang: string | null;
  /** The row's producer and version, for every state: the event says its own producer, not its entry's author. */
  readonly said_by: string;
  /** An opened opinion's values, by field name, a null for every field the producer has no opinion on. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** An opened opinion's evidence, and the evidence that replaced it in a re-evidenced one. */
  readonly evidence?: readonly EvidenceEntry[];
  readonly translated_from?: string | null;
  readonly source_digest?: string | null;
  readonly context?: number;
  readonly said_at?: string;
}

/**
 * One request a plugin made of the host, under the debug setting: its method, the size of its answer, what came of it
 * and — for a refusal or a failure — the class of the cause, never the arguments or a file's text. A request the unit
 * was still waiting for when it ended is `abandoned`; a run that hit the debug journal's bound ends with one
 * `truncated` record naming how many requests were kept.
 */
export interface JournalRead {
  readonly method: string;
  readonly size: number;
  readonly outcome: 'answered' | 'refused' | 'failed' | 'abandoned' | 'truncated';
  readonly cause?: string;
}

/** One publication's journal entry, built as the writer works and written at its end. */
export class Journal {
  readonly author: string;
  readonly words: string;
  readonly machine: string;
  readonly session: string;
  readonly vertices: JournalVertexEvent[] = [];
  readonly edges: JournalEdgeEvent[] = [];
  readonly opinions: JournalOpinionEvent[] = [];
  readonly reads: JournalRead[] = [];
  constructor(author: string, options: { readonly words?: string; readonly machine?: string; readonly session?: string } = {}) {
    if (author === '') throw new Error(`${WHERE}:1: a journal entry names its author: a producer and its version, "agent", or "person:<uid>"`);
    this.author = author;
    this.words = options.words ?? '';
    this.machine = options.machine ?? '';
    this.session = options.session ?? '';
  }
  declaredVertex(entity: string, uid: string, node: string, key: Readonly<Record<string, unknown>>): void { this.vertices.push({ entity, uid, key, node, state: 'declared' }); }
  removedVertex(entity: string, uid: string, node: string): void { this.vertices.push({ entity, uid, node, state: 'removed' }); }
  declaredEdge(entity: string, edge: string, from: string, to: string, discriminator: string, context: number): void { this.edges.push({ entity, edge, from, to, discriminator, context, state: 'declared' }); }
  removedEdge(entity: string, edge: string, from: string, to: string, discriminator: string, context: number): void { this.edges.push({ entity, edge, from, to, discriminator, context, state: 'removed' }); }
  opinion(event: JournalOpinionEvent): void { this.opinions.push(event); }
  read(record: JournalRead): void { this.reads.push(record); }
  /** The events this entry holds, of every kind. */
  count(): number { return this.vertices.length + this.edges.length + this.opinions.length + this.reads.length; }
  /** Whether the entry states anything: a publication that wrote nothing writes no row. */
  changed(): boolean { return this.count() > 0; }
  /** Empties the entry after its events were written as one row: the next events open the next row of the same run. */
  drain(): void {
    this.vertices.length = 0;
    this.edges.length = 0;
    this.opinions.length = 0;
    this.reads.length = 0;
  }
}


/**
 * The journal entry a transaction is building, bound to that transaction object: every writer call inside the
 * transaction adds its events to it, and the caller writes it once at the end, in the same transaction. The binding is
 * per transaction, so two publications of one process never share an entry.
 */
const JOURNAL_OF = new WeakMap<object, Journal>();

/** Binds one entry to the transaction every writer call of this publication runs in. */
export function journalOn(executor: SqlExecutor, journal: Journal): void {
  JOURNAL_OF.set(executor, journal);
}

/** The entry the transaction builds, unless the caller named one. */
function heldJournal(executor: SqlExecutor, named?: Journal): Journal | undefined {
  return named ?? JOURNAL_OF.get(executor);
}

/** One journal entry for one author, with the words an operation carries. */
export function journalFor(author: string, options: { readonly words?: string; readonly machine?: string; readonly session?: string } = {}): Journal {
  return new Journal(author, options);
}

/**
 * Writes one journal entry, in the caller's transaction; answers whether it wrote a row (an empty entry writes none).
 * Its span states what the entry costs — its events, its bytes and the milliseconds its serialization took — so a pass
 * whose entry grows is measured where it grows (codex, stage 2 review, item 7).
 */
export async function writeJournal(executor: SqlExecutor, journal: Journal): Promise<boolean> {
  if (!journal.changed()) return false;
  const change: Record<string, unknown> = {
    vertices: journal.vertices,
    edges: journal.edges,
    opinions: journal.opinions,
    ...(journal.reads.length === 0 ? {} : { reads: journal.reads }),
  };
  const started = performance.now();
  const text = canonicalJson(change);
  const encoded = performance.now() - started;
  await withSpan('journal.entry', {
    'journal.author': journal.author,
    'journal.vertices': journal.vertices.length,
    'journal.edges': journal.edges.length,
    'journal.opinions': journal.opinions.length,
    'journal.bytes': Buffer.byteLength(text, 'utf8'),
    'journal.encode_ms': Math.round(encoded * 10) / 10,
  }, async () => await executor.query(
    // The row's number is the journal's order (`seq`, assigned by the table when the row is inserted); `at` states when
    // the row was written and orders nothing (codex, stage 2 review, P2).
    `INSERT INTO operation (author, machine, session, words, change, at) VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`,
    [journal.author, journal.machine, journal.session, journal.words, text],
  ));
  return true;
}

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

/** The id of a kind's row in `entity`, made where the contract declares it and the store holds none. */
// Database owners lend a fresh executor to each transaction, so ids never survive a rollback or schema reset.
const ENTITY_IDS_OF = new WeakMap<SqlExecutor, Map<string, string>>();

async function entityIdOf(executor: SqlExecutor, kind: string, sort: 'node' | 'edge'): Promise<string> {
  let ids = ENTITY_IDS_OF.get(executor);
  const key = `${sort}:${kind}`;
  const held = ids?.get(key);
  if (held !== undefined) return held;
  const made = await executor.query<{ id: string }>(
    `INSERT INTO entity (name, sort) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id::text AS id`,
    [kind, sort],
  );
  const id = made.rows[0]?.id;
  if (id === undefined) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(kind)} was registered and the store answered no id`);
  if (ids === undefined) {
    ids = new Map();
    ENTITY_IDS_OF.set(executor, ids);
  }
  ids.set(key, id);
  return id;
}

/** The uids of nodes, by their local id: a journal event names a vertex or an edge's end by its uid, never by an id. */


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

/** Whether two values say the same thing. */
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

/** One key value, normalised by its contract type (the review of stage 1, finding 8): a text's 1 and "1" are one value. */
function normaliseKeyValue(contract: GraphContract, field: FieldContract, value: unknown, where: string): unknown {
  if (field.reference !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${WHERE}:1: ${where} names a ${JSON.stringify(field.reference)}, and the draft names ${JSON.stringify(value)}: a reference is {kind, key}`);
    const ref = value as EntityRefDraft;
    if (typeof ref.kind !== 'string' || ref.key === null || typeof ref.key !== 'object') throw new Error(`${WHERE}:1: ${where} names a reference that is no {kind, key}`);
    if (ref.kind !== field.reference) throw new Error(`${WHERE}:1: ${where} names a ${JSON.stringify(field.reference)}, and the draft names a ${JSON.stringify(ref.kind)}`);
    return { kind: ref.kind, key: canonicalKeyOf(contract, contract.vertex.find((held) => held.name === ref.kind), ref.key, `${where} of the ${ref.kind}`) };
  }
  if (field.type === 'text') {
    if (typeof value === 'object' && value !== null) throw new Error(`${WHERE}:1: ${where} is a text, and the draft names an object`);
    return String(value);
  }
  if (field.type === 'integer') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${WHERE}:1: ${where} is an integer, and the draft names ${JSON.stringify(value)}: an integer key is a safe integer, and a wider one is declared a bigint`);
    return number;
  }
  // A bigint key is its decimal text (the review of stage 1c, finding 8): 9007199254740993 and 9007199254740992 are two
  // identities, and JavaScript's Number would make them one.
  if (field.type === 'bigint') {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error(`${WHERE}:1: ${where} is a bigint, and the draft names the number ${JSON.stringify(value)}, which no longer holds its digits: name it as a decimal string`);
      return String(value);
    }
    const text = String(value);
    if (!/^-?\d+$/u.test(text)) throw new Error(`${WHERE}:1: ${where} is a bigint, and the draft names ${JSON.stringify(value)}: a bigint key is a decimal string`);
    return text;
  }
  if (field.type === 'boolean') {
    if (value !== true && value !== false) throw new Error(`${WHERE}:1: ${where} is a boolean, and the draft names ${JSON.stringify(value)}`);
    return value;
  }
  throw new Error(`${WHERE}:1: ${where} is a ${field.type}, and a key field is text, integer, bigint, boolean or a reference`);
}

/** One key object, normalised and in the contract's key order; a keyless kind holds none. */
function canonicalKeyOf(contract: GraphContract, vertex: VertexContract | undefined, key: Readonly<Record<string, KeyValueDraft>>, where: string): Record<string, unknown> {
  if (vertex === undefined || vertex.key.length === 0) return Object.fromEntries(Object.entries(key).map(([field, value]) => [field, typeof value === 'object' ? canonical(value) : String(value)]));
  const out: Record<string, unknown> = {};
  for (const field of vertex.key) {
    const declared = keyFieldOf(vertex, field);
    const value = key[field];
    if (value === undefined || (typeof value === 'string' && value === '')) throw new Error(`${WHERE}:1: ${where} names no ${JSON.stringify(field)}: its key is ${vertex.key.join(', ')}`);
    out[field] = normaliseKeyValue(contract, declared, value, `the key field ${JSON.stringify(field)} of ${JSON.stringify(vertex.name)}`);
  }
  return out;
}

/** One entity a draft's reference names, as the node that holds it, or undefined when no vertex does. */
async function referencedNodeOf(executor: SqlExecutor, contract: GraphContract, ref: EntityRefDraft, where: string): Promise<string | undefined> {
  const vertex = contract.vertex.find((held) => held.name === ref.kind);
  const key = canonicalKeyOf(contract, vertex, liftedReferences(contract, vertex, ref.key), where);
  const uid = keyUid(vertex?.name ?? ref.kind, [JSON.stringify(key)]);
  const found = await executor.query<{ id: string }>(`SELECT id::text AS id FROM node WHERE uid = $1::uuid`, [uid]);
  return found.rows[0]?.id;
}

/**
 * A key value that names a reference, carried as the referenced entity's name, lifted back to `{kind, key}`: the
 * plugin protocol's key values are strings (a file's key is its repository's name and its path), while the graph
 * declares a repository as a reference with a key of its own. A value already shaped as a reference, and a field
 * that names no reference, are left as they stand.
 */
function liftedReferences(contract: GraphContract, vertex: VertexContract | undefined, key: Readonly<Record<string, KeyValueDraft>>): Readonly<Record<string, KeyValueDraft>> {
  if (vertex === undefined) return key;
  const out: Record<string, KeyValueDraft> = { ...key };
  for (const field of vertex.key) {
    const declared = vertex.fields.find((held) => held.name === field);
    if (declared?.reference === undefined) continue;
    const value = out[field];
    if (typeof value !== 'string' || value === '') continue;
    const target = contract.vertex.find((held) => held.name === declared.reference);
    const targetKey = target?.key[0];
    if (targetKey === undefined) continue;
    out[field] = { kind: declared.reference, key: { [targetKey]: value } };
  }
  return out;
}

/**
 * The node an entity is, declared with its key: made where the store holds none (two concurrent declarations both
 * find it, the review of stage 1, finding 7), live again where a removal had marked it. A keyless kind's vertex is
 * its own uid alone.
 */
export async function ensureVertex(executor: SqlExecutor, contract: GraphContract, draft: Pick<VertexDraft, 'kind' | 'key'>, contextId = 1, journal?: Journal): Promise<{ nodeId: string; uid: string; created: boolean; revived: boolean }> {
  journal = heldJournal(executor, journal);
  const vertex = vertexOf(contract, draft.kind);
  const key = canonicalKeyOf(contract, vertex, draft.key, `an entity of the kind ${JSON.stringify(vertex.name)}`);
  const keyless = vertex.key.length === 0;
  const uid = keyless ? randomUUID() : keyUid(vertex.name, [JSON.stringify(key)]);
  const entityId = await entityIdOf(executor, vertex.name, 'node');
  const made = await executor.query<{ id: string; removed: boolean }>(
    `INSERT INTO node (entity_id, uid, key, context_id) VALUES ($1::bigint, $2::uuid, $3::jsonb, $4::bigint)
     ON CONFLICT (uid) DO NOTHING RETURNING id::text AS id, removed`,
    [entityId, uid, JSON.stringify(key), String(contextId)],
  );
  const created = made.rows[0];
  if (created !== undefined) {
    journal?.declaredVertex(vertex.name, uid, created.id, key);
    return { nodeId: created.id, uid, created: true, revived: false };
  }
  const held = await executor.query<{ id: string; removed: boolean }>(`SELECT id::text AS id, removed FROM node WHERE uid = $1::uuid`, [uid]);
  const row = held.rows[0];
  if (row === undefined) throw new Error(`${WHERE}:1: the node of ${JSON.stringify(draft.kind)} and ${JSON.stringify(key)} was declared and the store holds neither it nor a keyless echo`);
  if (!row.removed) return { nodeId: row.id, uid, created: false, revived: false };
  await executor.query(`UPDATE node SET removed = false WHERE id = $1::bigint`, [row.id]);
  journal?.declaredVertex(vertex.name, uid, row.id, key);
  return { nodeId: row.id, uid, created: false, revived: true };
}

/** The tagged evidence list of one opinion: every place its values were read, once each, in the order stated. */
export function evidenceList(draft: { readonly evidence?: readonly EvidenceDraft[] }): readonly EvidenceEntry[] {
  const places: EvidenceEntry[] = [];
  for (const entry of draft.evidence ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    const held = entry as Record<string, unknown>;
    let tagged: EvidenceEntry;
    if (held['type'] === 'conversation') tagged = { type: 'conversation', id: String(held['id'] ?? ''), ...(held['speaker'] === undefined ? {} : { speaker: String(held['speaker']) }), ...(held['at'] === undefined ? {} : { at: String(held['at']) }) };
    else if (held['type'] === 'opinion') tagged = { type: 'opinion', id: String(held['id'] ?? '') };
    else tagged = {
      type: 'file',
      ...(held['repository'] === undefined ? {} : { repository: String(held['repository']) }),
      ...(held['commit_or_digest'] === undefined ? (held['commit'] === undefined ? {} : { commit_or_digest: String(held['commit']) }) : { commit_or_digest: String(held['commit_or_digest']) }),
      ...(held['path'] === undefined ? {} : { path: String(held['path']) }),
      ...(held['line_start'] === undefined ? (held['lineStart'] === undefined ? {} : { line_start: Number(held['lineStart']) }) : { line_start: Number(held['line_start']) }),
      ...(held['line_end'] === undefined ? (held['lineEnd'] === undefined ? {} : { line_end: Number(held['lineEnd']) }) : { line_end: Number(held['line_end']) }),
    };
    const rendered = canonicalJson(tagged);
    if (!places.some((one) => canonicalJson(one) === rendered)) places.push(tagged);
  }
  return places;
}

/** The field values one opinion states, held against the kind's declaration: a key field is never an opinion. */
function valuesOf(vertex: VertexContract, draft: { readonly kind: string; readonly values?: Readonly<Record<string, unknown>> }): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [field, value] of Object.entries(draft.values ?? {})) {
    if (vertex.key.includes(field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} is keyed by ${JSON.stringify(field)}, and the key is not an opinion: its value is the vertex's`);
    if (!vertex.fields.some((one) => one.name === field)) throw new Error(`${WHERE}:1: the kind ${JSON.stringify(draft.kind)} declares no field ${JSON.stringify(field)}: its fields are ${vertex.fields.map((one) => one.name).join(', ')}`);
    values.set(field, value);
  }
  return values;
}

/** A JSON value sent as its own text: this driver would otherwise write an array as a PostgreSQL array. */
function paramOf(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? canonicalJson(value) : value;
}

/**
 * States one opinion of a vertex or an edge: the producer's open opinion of that node, in that language and context,
 * is compared with the whole opinion the draft states. Unchanged values and evidence write nothing; unchanged values
 * with new evidence update the row's evidence; a changed value closes the old row and opens a new one. Answers whether
 * the row changed.
 *
 * Every event states what a replay needs and nothing it must guess: an opened opinion carries the row's whole content
 * (its producer and version, its values, its evidence, its language, the opinion it was translated from, its source's
 * digest, its context and the moment it was said), a re-evidenced one the grounds that replaced its own, and a closed
 * one its id — the row it names is the state, and replay drops it from there.
 */
async function stateOpinion(executor: SqlExecutor, entity: string, table: string, owner: 'node_id' | 'edge_id', ownerId: string, saidBy: string, values: ReadonlyMap<string, unknown>, fields: readonly string[], evidence: readonly EvidenceEntry[], lang: string | null, contextId = 1, journal?: Journal, nodeUid?: string, edgeId?: string, translation?: { readonly translatedFrom?: string; readonly sourceDigest?: string }, selectedFields?: readonly string[]): Promise<boolean> {
  const columns = fields;
  const producer = saidBy.slice(0, saidBy.lastIndexOf('@') < 0 ? saidBy.length : saidBy.lastIndexOf('@'));
  let stated = [...values.entries()].filter(([, value]) => value !== null && value !== undefined).map(([field]) => field);
  // A node opinion names its vertex by uid, which the row itself does not carry: the same statement reads it, so an
  // event says its vertex even where the caller holds only the node's local id (codex, stage 2 review, item 3).
  const ownerUid = (param: number): string => (owner === 'node_id' ? `, (SELECT uid::text FROM node WHERE id = $${String(param)}::bigint) AS owner_uid` : '');
  const placeOf = (uid: unknown): { entity: string; node?: string; edge?: string } => ({
    entity,
    ...((nodeUid ?? uid) === undefined ? {} : { node: String(nodeUid ?? uid) }),
    ...(edgeId === undefined ? {} : { edge: edgeId }),
  });
  const held = await executor.query<Record<string, unknown>>(
    `SELECT "id"::text AS id, "said_by", ${columns.map((column) => `${quote(column, 'column')}, `).join('')}"evidence"${ownerUid(1)} FROM ${table}
     WHERE ${quote(owner, 'column')} = $1::bigint AND split_part("said_by", '@', 1) = $2 AND "lang" IS NOT DISTINCT FROM $3 AND "context_id" = $4::bigint AND "state" = 'open'
     ORDER BY "id" DESC LIMIT 1`,
    [ownerId, producer, lang, String(contextId)],
  );
  const open = held.rows[0];
  if (selectedFields !== undefined) {
    const selected = new Set(selectedFields);
    values = new Map(columns.map((field) => [field, selected.has(field) ? values.get(field) ?? null : open?.[field] ?? null]));
    if (open !== undefined && columns.some((field) => !selected.has(field) && open[field] != null)) {
      evidence = [...(open['evidence'] as EvidenceEntry[] ?? []), ...evidence].filter((entry, index, entries) => entries.findIndex((other) => sameValue(entry, other)) === index);
    }
    stated = [...values.entries()].filter(([, value]) => value != null).map(([field]) => field);
  }
  if (open !== undefined) {
    // One publication states the producer's whole opinion: every declared field counts, and an omitted field is null.
    const same = columns.every((column) => sameColumn(open[column], values.get(column) ?? null));
    if (same) {
      if (sameValue(open['evidence'] ?? [], evidence)) return false;
      await executor.query(`UPDATE ${table} SET "evidence" = $2::jsonb WHERE "id" = $1::bigint`, [String(open['id']), canonicalJson(evidence)]);
      journal?.opinion({ id: String(open['id']), ...placeOf(open['owner_uid']), state: 're-evidenced', fields: stated, lang, said_by: String(open['said_by'] ?? saidBy), evidence });
      return true;
    }
    await executor.query(`UPDATE ${table} SET "state" = 'closed' WHERE "id" = $1::bigint`, [String(open['id'])]);
    journal?.opinion({ id: String(open['id']), ...placeOf(open['owner_uid']), state: 'closed', fields: stated, lang, said_by: String(open['said_by'] ?? saidBy) });
  }
  // A translation states the opinion it was translated from and the digest of its source beside its language
  // (madarch-stm0.5); an opinion that is no translation states neither.
  const insertColumns = [...columns, 'said_by', 'lang', 'evidence', 'translated_from', 'source_digest', 'context_id', owner];
  const params: unknown[] = [...columns.map((column) => paramOf(values.get(column))), saidBy, lang, canonicalJson(evidence), translation?.translatedFrom ?? null, translation?.sourceDigest ?? null, String(contextId), ownerId];
  const made = await executor.query<{ id: string; said_at: string; translated_from: string | null; source_digest: string | null; owner_uid?: string }>(
    `INSERT INTO ${table} (${insertColumns.map((column) => quote(column, 'column')).join(', ')}) VALUES (${insertColumns.map((_, at) => `$${String(at + 1)}`).join(', ')})
     RETURNING "id"::text AS id, to_char("said_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS said_at, "translated_from"::text AS translated_from, "source_digest"${ownerUid(insertColumns.length)}`,
    params,
  );
  const row = made.rows[0];
  journal?.opinion({
    id: row?.id ?? '', ...placeOf(row?.owner_uid), state: 'opened', fields: stated, lang, said_by: saidBy,
    values: Object.fromEntries(columns.map((column) => [column, values.get(column) ?? null])),
    evidence, translated_from: row?.translated_from ?? null, source_digest: row?.source_digest ?? null,
    context: contextId, said_at: row?.said_at ?? '',
  });
  return true;
}



/**
 * One opinion of one vertex's fields, stated by a producer against a node the caller already holds. Answers whether it
 * wrote, so a rerun of the same answer writes nothing.
 */
export async function publishOpinion(executor: SqlExecutor, contract: GraphContract, draft: { readonly kind: string; readonly nodeId: string; readonly uid?: string; readonly selectedFields?: readonly string[]; readonly values?: Readonly<Record<string, unknown>>; readonly evidence?: readonly EvidenceDraft[]; readonly lang?: string | null; readonly translatedFrom?: string; readonly sourceDigest?: string; readonly producer: string; readonly producerVersion: string }, contextId = 1, journal?: Journal): Promise<boolean> {
  const vertex = vertexOf(contract, draft.kind);
  const values = valuesOf(vertex, draft);
  const fields = vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => field.name);
  return await stateOpinion(executor, vertex.name, vertex.table, 'node_id', draft.nodeId, `${draft.producer}@${draft.producerVersion}`, values, fields, evidenceList(draft), draft.lang ?? null, contextId, heldJournal(executor, journal), draft.uid, undefined, { ...(draft.translatedFrom === undefined ? {} : { translatedFrom: draft.translatedFrom }), ...(draft.sourceDigest === undefined ? {} : { sourceDigest: draft.sourceDigest }) }, draft.selectedFields);
}

/**
 * One opinion of an edge kind's fields, stated by a producer: the edge's table holds it, keyed by `edge_id`. The end
 * points and the discriminator are the edge's identity and stand in `edge`, never here. An attribute-free edge's
 * opinion is the statement that the edge exists, with its evidence.
 */
export async function publishEdgeOpinion(executor: SqlExecutor, contract: GraphContract, edgeKind: string, edgeId: string, draft: { readonly values?: Readonly<Record<string, unknown>>; readonly evidence?: readonly EvidenceDraft[]; readonly lang?: string | null; readonly producer: string; readonly producerVersion: string }, contextId = 1, journal?: Journal): Promise<boolean> {
  const kind = edgeOfKind(contract, edgeKind);
  const declared = contract.edge.find((held) => held.name === edgeKind)!;
  const fields = declared.fields.map((field) => field.name);
  return await stateOpinion(executor, kind.name, kind.table, 'edge_id', edgeId, `${draft.producer}@${draft.producerVersion}`, new Map(Object.entries(draft.values ?? {})), fields, evidenceList(draft), draft.lang ?? null, contextId, heldJournal(executor, journal), undefined, edgeId);
}

/**
 * One edge of a kind between two nodes, declared: made where it stands in no other way, found where it does. The
 * producer's existence opinion of the edge is stated with it, so "who says this edge exists" is answerable for an
 * attribute-free edge too.
 */
export async function ensureEdge(executor: SqlExecutor, contract: GraphContract, kindName: string, fromNode: string, toNode: string, discriminator = '', opinion?: { readonly producer: string; readonly producerVersion: string; readonly evidence?: readonly EvidenceDraft[] }, contextId = 1, journal?: Journal): Promise<{ id: string; created: boolean }> {
  journal = heldJournal(executor, journal);
  if (!contract.edge.some((held) => held.name === kindName)) throw new Error(`${WHERE}:1: the edge kind ${JSON.stringify(kindName)} is no kind the product declares: the contract holds ${contract.edge.length === 0 ? 'none' : contract.edge.map((one) => one.name).join(', ')}`);
  const entityId = await entityIdOf(executor, kindName, 'edge');
  const made = await executor.query<{ id: string; from_uid: string; to_uid: string }>(
    `INSERT INTO edge (entity_id, from_node, to_node, discriminator, context_id) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::bigint)
     ON CONFLICT (entity_id, from_node, to_node, discriminator, context_id) DO NOTHING
     RETURNING id::text AS id, (SELECT uid::text FROM node WHERE id = $2::bigint) AS from_uid, (SELECT uid::text FROM node WHERE id = $3::bigint) AS to_uid`,
    [entityId, fromNode, toNode, discriminator, String(contextId)],
  );
  const created = made.rows[0];
  let id = created?.id;
  if (id === undefined) {
    const held = await executor.query<{ id: string }>(
      `SELECT id::text AS id FROM edge WHERE entity_id = $1::bigint AND from_node = $2::bigint AND to_node = $3::bigint AND discriminator = $4 AND context_id = $5::bigint`,
      [entityId, fromNode, toNode, discriminator, String(contextId)],
    );
    id = held.rows[0]?.id;
    if (id === undefined) throw new Error(`${WHERE}:1: the edge of ${JSON.stringify(kindName)} between ${fromNode} and ${toNode} was declared and the store holds neither it nor its echo`);
  }
  // Every edge a publication makes is journaled as declared — with or without an opinion — and an edge that already
  // stands is journaled by nothing (codex, stage 2 review, item 2). The existence opinion is the producer's first
  // statement of the edge; an edge that already stands keeps its opinion, and a rerun writes nothing.
  if (created !== undefined) {
    journal?.declaredEdge(kindName, created.id, created.from_uid, created.to_uid, discriminator, contextId);
    if (opinion !== undefined) await publishEdgeOpinion(executor, contract, kindName, created.id, { values: {}, ...opinion }, contextId, journal);
  }
  return { id: id!, created: created !== undefined };
}



/** One edge by its id, removed: its opinions go with it (a consistent cascade), never the vertices it names. */
export async function removeEdgeById(executor: SqlExecutor, contract: GraphContract, kindName: string, edgeId: string, journal?: Journal): Promise<boolean> {
  journal = heldJournal(executor, journal);
  const kind = edgeOfKind(contract, kindName);
  const held = await executor.query<{ id: string; from_node: string; to_node: string; discriminator: string; context_id: string; from_uid: string; to_uid: string }>(
    `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator, e.context_id::text AS context_id, fn.uid::text AS from_uid, tn.uid::text AS to_uid
     FROM edge e JOIN node fn ON fn.id = e.from_node JOIN node tn ON tn.id = e.to_node WHERE e.id = $1::bigint`, [edgeId]);
  const row = held.rows[0];
  if (row === undefined) return false;
  const opinions = await executor.query<{ id: string; said_by: string; lang: string | null }>(`SELECT "id"::text AS id, "said_by", "lang" FROM ${kind.table} WHERE edge_id = $1::bigint AND "state" = 'open'`, [edgeId]);
  for (const one of opinions.rows) journal?.opinion({ id: one.id, entity: kind.name, edge: edgeId, state: 'closed', fields: [], lang: one.lang, said_by: one.said_by });
  await executor.query(`DELETE FROM ${kind.table} WHERE edge_id = $1::bigint`, [edgeId]);
  await executor.query(`DELETE FROM edge WHERE id = $1::bigint`, [edgeId]);
  journal?.removedEdge(kindName, edgeId, row.from_uid, row.to_uid, row.discriminator, Number(row.context_id));
  return true;
}

/**
 * One entity the producer no longer holds: its open opinions — in every language — close, and the vertex is removed
 * when no open opinion of any producer remains (the review of stage 1, finding 3). A later opinion of any producer
 * brings it back.
 */
export async function removeEntity(executor: SqlExecutor, contract: GraphContract, draft: VertexRemovalDraft, contextId = 1, journal?: Journal): Promise<boolean> {
  journal = heldJournal(executor, journal);
  const vertex = vertexOf(contract, draft.kind);
  const key = canonicalKeyOf(contract, vertex, draft.key, `an entity of the kind ${JSON.stringify(vertex.name)}`);
  if (vertex.key.length === 0 && draft.uid === undefined) throw new Error(`${WHERE}:1: withdrawing a keyless entity requires its uid`);
  const uid = draft.uid ?? keyUid(vertex.name, [JSON.stringify(key)]);
  const node = await executor.query<{ id: string }>(`SELECT n.id::text AS id FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = $3::bigint FOR UPDATE OF n`, [uid, vertex.name, String(contextId)]);
  const nodeId = node.rows[0]?.id;
  if (nodeId === undefined) return false;
  const preserved: string[] = [];
  let scopedChanged = false;
  if (draft.selectedFields !== undefined && draft.withdrawAll !== true) {
    const fields = vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => field.name);
    const selected = new Set(draft.selectedFields);
    const standing = await executor.query<Record<string, unknown>>(
      `SELECT * FROM ${vertex.table} WHERE node_id = $1::bigint AND split_part(said_by, '@', 1) = $2 AND state = 'open' AND context_id = $3::bigint`,
      [nodeId, draft.producer, String(contextId)]);
    for (const row of standing.rows) {
      if (!fields.some((field) => !selected.has(field) && row[field] != null)) continue;
      scopedChanged = await stateOpinion(executor, vertex.name, vertex.table, 'node_id', nodeId, String(row['said_by']),
        new Map(fields.map((field) => [field, selected.has(field) ? null : row[field]])), fields,
        row['evidence'] as EvidenceEntry[], row['lang'] as string | null, contextId, journal, uid) || scopedChanged;
      // The merge created or kept an open replacement; preserve that language from the whole-row withdrawal below.
      preserved.push(row['lang'] === null ? '' : String(row['lang']));
    }
  }
  const closed = await executor.query<{ id: string; said_by: string; lang: string | null }>(
    `UPDATE ${vertex.table} SET "state" = 'closed', "confirmed_field" = NULL WHERE "node_id" = $1::bigint AND (split_part("said_by", '@', 1) = $2 OR $4::boolean) AND ("state" = 'open' OR ($4::boolean AND "state" = 'confirmed')) AND "context_id" = $3::bigint AND NOT (COALESCE(lang, '') = ANY($5::text[])) RETURNING "id"::text AS id, "said_by", "lang"`,
    [nodeId, draft.producer, String(contextId), draft.withdrawAll === true, preserved],
  );
  // A withdrawal that withdrew nothing states nothing: no close, and no removal of a vertex that stands (codex, stage 2
  // review, item 4). A repeated ineffective withdrawal is not a change and writes no row.
  if (closed.rows.length === 0) return scopedChanged;
  for (const row of closed.rows) journal?.opinion({ id: row.id, entity: vertex.name, node: uid, state: 'closed', fields: [], lang: row.lang, said_by: row.said_by });
  const open = await executor.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${vertex.table} WHERE "node_id" = $1::bigint AND "state" IN ('open', 'confirmed') AND "context_id" = $2::bigint`, [nodeId, String(contextId)]);
  const removed = Number(open.rows[0]?.n ?? '0') === 0;
  // The vertex is journaled as removed only where no open opinion of any producer remains: a producer that withdraws
  // while another's opinion stands closed its own opinion and removed nothing.
  if (removed) {
    const incident = await executor.query<{ id: string; kind: string }>(
      `SELECT e.id::text AS id, k.name AS kind FROM edge e JOIN entity k ON k.id = e.entity_id
       WHERE e.from_node = $1::bigint OR e.to_node = $1::bigint ORDER BY e.id`, [nodeId],
    );
    for (const edge of incident.rows) await removeEdgeById(executor, contract, edge.kind, edge.id, journal);
    journal?.removedVertex(vertex.name, uid, nodeId);
  }
  await executor.query(`UPDATE node SET removed = $2::boolean WHERE id = $1::bigint`, [nodeId, removed]);
  return true;
}

/** What a key or an edge end names and no vertex holds, recorded for the consistency check. */
export interface UnresolvedReference {
  /** The vertex whose key holds the reference, or the edge end that did resolve; null when neither end stands. */
  readonly referrer: string | null;
  /** The edge kind whose end names the missing vertex, null for a key reference. */
  readonly edgeEntity?: string | null;
  readonly field: string;
  readonly targetEntity: string;
  readonly targetKey: unknown;
  /** The producer and version that named it: a rerun of the same answer records it once. */
  readonly producer: string;
  /** The other end of the edge, when that end stands. */
  readonly against?: string | null;
  /** What tells two edges of one kind and one target apart, for an edge end. */
  readonly discriminator?: string;
  readonly contextId: number;
}

/** Records one unresolved reference; the same one stated twice — by one producer — stands once. */
async function recordUnresolved(executor: SqlExecutor, reference: UnresolvedReference): Promise<void> {
  await executor.query(
    `INSERT INTO unresolved_reference (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id)
     VALUES ($1::bigint, $2, $3, $4, $5::jsonb, $6, $7::bigint, $8, $9::bigint)
     ON CONFLICT (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id) DO NOTHING`,
    [reference.referrer, reference.edgeEntity ?? null, reference.field, reference.targetEntity, JSON.stringify(reference.targetKey), reference.producer, reference.against ?? null, reference.discriminator ?? null, String(reference.contextId)],
  );
}

/** The reference one key field names, when the field is a reference; undefined for a plain value. */
function referenceOf(field: FieldContract, value: unknown): EntityRefDraft | undefined {
  if (field.reference === undefined) return undefined;
  if (value === null || typeof value !== 'object') return undefined;
  return value as EntityRefDraft;
}

/**
 * Resolves the references one vertex's key names, recording each an absent vertex answers. A declaration has already
 * made the node, so the publication can go on whatever the reference says.
 */
async function checkKeyReferences(executor: SqlExecutor, contract: GraphContract, kind: string, nodeId: string, draft: Readonly<Record<string, KeyValueDraft>>, producer: string, contextId: number): Promise<void> {
  const vertex = vertexOf(contract, kind);
  for (const field of vertex.key) {
    const declared = keyFieldOf(vertex, field);
    const ref = referenceOf(declared, draft[field]);
    if (ref === undefined) continue;
    const target = contract.vertex.find((held) => held.name === ref.kind);
    const targetKey = canonicalKeyOf(contract, target, ref.key, `the reference ${JSON.stringify(field)}`);
    if (await referencedNodeOf(executor, contract, ref, `the key field ${JSON.stringify(field)} of ${JSON.stringify(kind)}`) !== undefined) {
      // The reference stands now: the record of its not standing goes.
      await executor.query(`DELETE FROM unresolved_reference WHERE referrer_node = $1::bigint AND edge_entity IS NULL AND field = $2 AND target_entity = $3 AND target_key = $4::jsonb AND producer = $5 AND context_id = $6::bigint`, [nodeId, field, ref.kind, JSON.stringify(targetKey), producer, String(contextId)]);
      continue;
    }
    await recordUnresolved(executor, { referrer: nodeId, edgeEntity: null, field, targetEntity: ref.kind, targetKey, producer, against: null, contextId });
  }
}

/** The drafts one publication applies, by the kind of write they are. */
export interface GraphDrafts {
  readonly vertices: readonly VertexDraft[];
  readonly edges?: readonly EdgeDraft[];
  readonly removals: readonly VertexRemovalDraft[];
  readonly edgeRemovals?: readonly EdgeRemovalDraft[];
}

/** The producer an entry's author falls back to: the first draft's producer, whichever kind of draft it is. */
function producerOf(drafts: GraphDrafts): string | undefined {
  const vertex = drafts.vertices[0];
  if (vertex !== undefined) return `${vertex.producer}@${vertex.producerVersion}`;
  const edge = (drafts.edges ?? [])[0];
  if (edge !== undefined) return `${edge.producer}@${edge.producerVersion}`;
  const removal = drafts.removals[0];
  if (removal !== undefined) return removal.producer;
  return drafts.edgeRemovals?.[0]?.producer;
}

/**
 * One edge a producer withdraws: its ends are found the way a declaration's are (by uid of the kind and key), the edge
 * row between them by its discriminator, and the row is removed with its opinions. A removal that names an edge the
 * store does not hold writes nothing — a rerun of the same answer and an edge never made are the same silence.
 */
async function removeEdgeDraft(executor: SqlExecutor, contract: GraphContract, draft: EdgeRemovalDraft, contextId: number, journal?: Journal): Promise<boolean> {
  const declared = contract.edge.find((held) => held.name === draft.kind);
  if (declared === undefined || declared.table === undefined) return false;
  const from = await referencedNodeOf(executor, contract, draft.from, `the from of the removed edge ${JSON.stringify(draft.kind)}`);
  const to = await referencedNodeOf(executor, contract, draft.to, `the to of the removed edge ${JSON.stringify(draft.kind)}`);
  if (from === undefined || to === undefined) return false;
  const found = await executor.query<{ id: string }>(
    `SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
     WHERE e.from_node = $2::bigint AND e.to_node = $3::bigint AND e.discriminator = $4 AND e.context_id = $5::bigint`,
    [draft.kind, from, to, draft.discriminator ?? '', String(contextId)],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) return false;
  return await removeEdgeById(executor, contract, draft.kind, id, journal);
}

/** A declaration's node, and where each vertex's key names its references. */
interface Declared {
  readonly draft: VertexDraft;
  readonly nodeId: string;
  readonly uid: string;
}

/**
 * Every draft of one publication, applied inside the caller's transaction: declarations first (vertices, then the
 * edges whose ends now stand), then the references each key and each edge end names — an unresolved one is recorded
 * and the publication goes on. Answers how many rows were written; a rerun of the same answer writes none.
 */
export async function publishGraphDrafts(executor: SqlExecutor, contract: GraphContract, drafts: GraphDrafts, contextId = 1, options: { readonly author?: string; readonly words?: string; readonly machine?: string; readonly session?: string; readonly reads?: readonly JournalRead[] } = {}): Promise<number> {
  let written = 0;
  // The entry's author is the publication's: a plugin and its version, a record pass's producer, or the agent or a person
  // for an operation; without one named, the drafts' own producers name it — a removal-only or edge-only publication
  // included. A publication with no author at all is refused: every change stands in the journal (A5; codex, stage 2
  // review, item 1).
  const author = options.author ?? producerOf(drafts);
  if (author === undefined || author === '') {
    throw new Error(`${WHERE}:1: a publication names its author — a producer and its version, "agent", or "person:<uid>" — and this one states a change with none: every change stands in the journal`);
  }
  const journal = journalFor(author, { ...(options.words === undefined ? {} : { words: options.words }), ...(options.machine === undefined ? {} : { machine: options.machine }), ...(options.session === undefined ? {} : { session: options.session }) });
  journalOn(executor, journal);
  for (const record of options.reads ?? []) journal.read(record);
  // Removals first: a removal states what its producer no longer holds, and the rest of the publication is what it does.
  for (const draft of drafts.removals) if (await removeEntity(executor, contract, draft, contextId, journal)) written += 1;
  for (const draft of drafts.edgeRemovals ?? []) if (await removeEdgeDraft(executor, contract, draft, contextId, journal)) written += 1;
  const declared: Declared[] = [];
  for (const draft of drafts.vertices) {
    const made = await ensureVertex(executor, contract, draft, contextId, journal);
    if (made.created || made.revived) written += 1;
    declared.push({ draft, nodeId: made.nodeId, uid: made.uid });
  }
  for (const { draft, nodeId, uid } of declared) {
    if (await publishOpinion(executor, contract, { ...draft, nodeId, uid }, contextId, journal)) written += 1;
  }
  // An edge whose ends do not stand is a reference no vertex answers: recorded, never invented. A published edge's
  // records go.
  for (const draft of drafts.edges ?? []) {
    const ends: (string | undefined)[] = [];
    for (const [field, ref] of [['from', draft.from], ['to', draft.to]] as const) {
      ends.push(await referencedNodeOf(executor, contract, ref, `the ${field} of the edge ${JSON.stringify(draft.kind)}`));
    }
    const [fromNode, toNode] = ends;
    if (fromNode === undefined || toNode === undefined) {
      for (const [field, ref, other] of [['from', draft.from, toNode], ['to', draft.to, fromNode]] as const) {
        const named = field === 'from' ? fromNode : toNode;
        if (named !== undefined) continue;
        const target = contract.vertex.find((held) => held.name === ref.kind);
        await recordUnresolved(executor, {
          referrer: other ?? null, edgeEntity: draft.kind, field, targetEntity: ref.kind,
          targetKey: canonicalKeyOf(contract, target, liftedReferences(contract, target, ref.key), `the ${field} of ${JSON.stringify(draft.kind)}`),
          producer: `${draft.producer}@${draft.producerVersion}`, against: null, discriminator: draft.discriminator ?? '', contextId,
        });
      }
      continue;
    }
    const edge = await ensureEdge(executor, contract, draft.kind, fromNode, toNode, draft.discriminator ?? '', { producer: draft.producer, producerVersion: draft.producerVersion, ...(draft.evidence === undefined ? {} : { evidence: draft.evidence }) }, contextId, journal);
    if (edge.created) written += 1;
    if (await publishEdgeOpinion(executor, contract, draft.kind, edge.id, draft, contextId, journal)) written += 1;
    await executor.query(
      `DELETE FROM unresolved_reference WHERE edge_entity = $1 AND producer = $2 AND context_id = $3::bigint
         AND (referrer_node = $4::bigint OR referrer_node = $5::bigint OR referrer_node IS NULL)
         AND edge_discriminator = $6`,
      [draft.kind, `${draft.producer}@${draft.producerVersion}`, String(contextId), fromNode, toNode, draft.discriminator ?? ''],
    );
  }
  for (const { draft, nodeId } of declared) await checkKeyReferences(executor, contract, draft.kind, nodeId, draft.key, `${draft.producer}@${draft.producerVersion}`, contextId);
  await writeJournal(executor, journal);
  return written;
}

