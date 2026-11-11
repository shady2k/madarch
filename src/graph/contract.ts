/**
 * The contracts a product's manifest declares, and the tables madarch builds
 * from them (decision 0034, item 14; its amendment of 2026-11-10, A2 and A3): a
 * vertex kind's fields and key, an edge kind's ends, repeat rule and attributes,
 * and a dictionary's values. A capability publishes the contract of what it
 * produces; a manifest that declares a kind filled by it takes that contract. The
 * engine's own DDL holds only the mechanism (`one-graph.ts`); every name of a
 * product's kind stands here or in a capability's declaration, never in the
 * mechanism.
 *
 * **The key belongs to the vertex.** A contract declares the fields that make its
 * entity unique; they are not columns of the entity's table but the vertex's key
 * (`node.key`), and a producer names an entity by their values. A key field may
 * name another kind: its value is then that entity, named by its kind and key.
 *
 * **An opinion is a row.** The table built for a kind holds one row per opinion
 * about one vertex (or edge): who said it and when, whether it is open, confirmed
 * or closed, the reason and the person of a confirmation, the evidence it rests
 * on, the language of a text value, the opinion a translation came from with that
 * source's digest, the context, and the kind's fields as that producer states
 * them. No field of the kind is a column of the vertex itself.
 *
 * A table is made from a validated name and a fixed type map. A declaration that
 * changes adds a column, replaces a key constraint, or — when a removed or
 * retyped field still holds rows — refuses by naming the kind and the field; it
 * never drops data in silence.
 */
import { createHash } from 'node:crypto';
import { byCodePoint } from '../model/order.js';
import type { OuterTransaction } from '../adapters/database-owner.js';

/** The sort of table a generated name belongs to: a vertex's opinions, an edge's, or a dictionary. */
export type TableSort = 'vertex' | 'edge' | 'dictionary';

/**
 * The table name generated from a kind's name (decision 0034, item 14): the display name is kept apart,
 * the name is a lower-case identifier within PostgreSQL's 63-byte bound, and the digest makes two kinds
 * whose names differ only in punctuation or after the slug's cut keep different tables.
 */
export function generatedTableName(kind: string, sort: TableSort): string {
  const slug = kind.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40) || 'kind';
  const digest = createHash('sha256').update(`${sort}\0${kind}`, 'utf8').digest('hex').slice(0, 8);
  const prefix = sort === 'vertex' ? 'k' : sort === 'edge' ? 'e' : 'd';
  return `${prefix}_${slug}_${digest}`;
}

/** The PostgreSQL types a field may map to. */
export type FieldType = 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';

export interface FieldContract {
  readonly name: string;
  readonly type: FieldType;
  /** Whether the column admits null; a new column of a new table is NOT NULL unless this is true. */
  readonly nullable?: boolean;
  /**
   * The kind a key field names: its value is one entity of that kind, named by the kind and the entity's key values,
   * never by a node id (decision 0034, item 14: "a reference inside a key by the referenced entity's kind and key").
   */
  readonly reference?: string;
}

/** A dictionary holds each value once, with its own natural key. */
export interface DictionaryContract {
  readonly name: string;
  readonly fields: readonly FieldContract[];
  readonly key: readonly string[];
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface VertexContract {
  readonly name: string;
  readonly table: string;
  /** Every field the kind declares, its key fields included; the key's own fields are no columns of the table. */
  readonly fields: readonly FieldContract[];
  /** The natural key: fields of this contract, unique per context in `node`. */
  readonly key: readonly string[];
  /** The capability that fills it; a kind is bound to exactly one. */
  readonly capability: string;
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface EdgeContract {
  readonly name: string;
  /** The attribute table, when the edge kind has fields. */
  readonly table?: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly repeats: boolean;
  /** The edge field that tells repeated edges apart. */
  readonly discriminator?: string;
  readonly fields: readonly FieldContract[];
  readonly capability: string;
  /** SQL checks a capability states about its values, each a `CHECK (...)` body without the keyword. */
  readonly checks?: readonly string[];
  /** The indexes a capability asks for, beyond the natural key's own. */
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

export interface GraphContract {
  readonly vertex: readonly VertexContract[];
  readonly edge: readonly EdgeContract[];
  readonly dictionary: readonly DictionaryContract[];
}

/** Where a file value was read: the repository, the commit or content digest, the path and the lines (decision 0035, item 7). */
export interface ClaimEvidenceDraft {
  readonly repository?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** One tagged evidence entry the graph stores (the amendment's point 7): a file place, a conversation, an opinion. */
export type EvidenceEntry =
  | { readonly type: 'file'; readonly repository?: string; readonly commit_or_digest?: string; readonly path?: string; readonly line_start?: number; readonly line_end?: number }
  | { readonly type: 'conversation'; readonly id: string; readonly speaker?: string; readonly at?: string }
  | { readonly type: 'opinion'; readonly id: string };

/** One evidence entry as a draft states it: a plugin's file place, or any tagged entry a producer gives. */
export type EvidenceDraft = ClaimEvidenceDraft | EvidenceEntry;

/** One entity a producer names: its kind and the values of its key's fields (decision 0034, item 14). */
export interface EntityRefDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
}

/** One key field's value: a text or a number, or the entity a reference field names. */
export type KeyValueDraft = string | number | EntityRefDraft;

/**
 * One vertex a producer publishes: its kind, its natural key, the field values it states, the evidence those values
 * rest on, and the language of a text value. The values of the key's fields are the entity's identity and are not
 * opinions; every other value is. One draft is the producer's whole opinion of the entity: a field it leaves out is a
 * field it has no opinion on.
 */
export interface VertexDraft {
  readonly kind: string;
  /** The entity's natural key values, by the kind's key fields; a reference is its entity's kind and key. */
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  /** The field values this producer states, by field name; a field it did not read is left out. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Where the values were read, as tagged entries (a file place, a conversation, an opinion). */
  readonly evidence?: readonly EvidenceDraft[];
  /** The language of the text value the opinion states; null for a value that is no text. */
  readonly lang?: string;
  readonly producer: string;
  readonly producerVersion: string;
}

/**
 * One edge a producer states: its ends by kind and key, its discriminator and the opinion that it exists. It stands
 * here, with the other drafts, so a stage may write it without reaching into the store's writer.
 */
export interface EdgeDraft {
  readonly kind: string;
  readonly from: EntityRefDraft;
  readonly to: EntityRefDraft;
  readonly discriminator?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly EvidenceDraft[];
  readonly lang?: string;
  readonly producer: string;
  readonly producerVersion: string;
}

/** One edge a producer withdraws: its ends by kind and key, and the discriminator that tells repeats apart. */
export interface EdgeRemovalDraft {
  readonly kind: string;
  readonly from: EntityRefDraft;
  readonly to: EntityRefDraft;
  readonly discriminator?: string;
  readonly producer: string;
}

/** One entity a producer no longer holds: its opinions are closed and it leaves the reads (a removal of a term). */
export interface VertexRemovalDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  readonly producer: string;
  /** A keyless entity is withdrawn by its persistent random uid. */
  readonly uid?: string;
  /** An explicit person action withdraws the entity, not only one producer's opinion. */
  readonly withdrawAll?: boolean;
}

/** The empty contract: a product that declares no kind filled by a capability. */
export const EMPTY_CONTRACT: GraphContract = { vertex: [], edge: [], dictionary: [] };

/** The PostgreSQL type of one field; the map is closed, so a contract cannot name a type of its own. */
function sqlType(field: FieldContract): string {
  switch (field.type) {
    case 'text': return 'text';
    case 'integer': return 'integer';
    case 'bigint': return 'bigint';
    case 'boolean': return 'boolean';
    case 'timestamp': return 'timestamptz';
    case 'json': return 'jsonb';
  }
}

/** A table, column or key name: lower-case letters, digits and underscores, starting with a letter. */
const NAME = /^[a-z][a-z0-9_]*$/u;

function quote(name: string, what: string): string {
  if (!NAME.test(name)) throw new Error(`${import.meta.path}:213: the ${what} ${JSON.stringify(name)} is not a lower-case identifier (a letter, then letters, digits and underscores)`);
  return `"${name}"`;
}

/** The one table name of a dictionary, vertex or edge kind; a capability's contract names them itself. */
function tableOf(kind: { readonly table?: string; readonly name: string }, sort: TableSort = 'vertex'): string {
  return generatedTableName(kind.name, sort);
}

/** The columns a table holds now, with their types. */
async function columnsOf(tx: OuterTransaction, table: string): Promise<Map<string, string>> {
  const found = await tx.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return new Map(found.rows.map((row) => [row.column_name, row.data_type]));
}

/** Historical non-null values, including closed opinions and removed entities. */
async function valuesOf(tx: OuterTransaction, table: string, field: string): Promise<number> {
  const found = await tx.query<{ n: string }>(`SELECT count(${quote(field, 'field')})::text AS n FROM ${quote(table, 'table')}`);
  return Number(found.rows[0]!.n);
}

/** One column's PostgreSQL type as information_schema names it, for a comparison with a field's map. */
function sameType(actual: string, field: FieldContract): boolean {
  const expected = sqlType(field);
  return actual === expected || (expected === 'timestamptz' && actual === 'timestamp with time zone') || (expected === 'jsonb' && actual === 'jsonb');
}

/**
 * The columns every opinion row holds (decision 0034's amendment, A3), before the kind's own fields: the vertex or edge
 * it is about, who said it and when, its state with the reason and the person of a confirmation, the evidence it rests
 * on, the language of a text value, the opinion a translation came from and that source's digest, and its context.
 */
const OPINION_COLUMNS: readonly string[] = [
  // One id for the whole graph, from one sequence: `{type: 'opinion', id}` means the same thing in every entity's table.
  `"id" bigint PRIMARY KEY DEFAULT nextval('opinion_id')`,
  `"said_by" text NOT NULL CHECK (said_by <> '')`,
  `"said_at" timestamptz NOT NULL DEFAULT now()`,
  `"state" text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'confirmed', 'closed'))`,
  // The field a confirmed row settles: one field per confirmed opinion, so the database can refuse a second one for
  // the same node, field, language and context (the partial unique index below).
  `"confirmed_field" text`,
  `"reason" text`,
  `"confirmed_with" jsonb`,
  `"evidence" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array')`,
  `"lang" text`,
  `"translated_from" bigint`,
  `"source_digest" text`,
  `"context_id" bigint NOT NULL DEFAULT 1 REFERENCES context (id)`,
  `CHECK ((state = 'confirmed') = (confirmed_field IS NOT NULL))`,
];

/** The columns a reader or a writer names without the kind's own: the opinion's own, in the order `OPINION_COLUMNS`. */
export const OPINION_FIELDS = ['id', 'said_by', 'said_at', 'state', 'confirmed_field', 'reason', 'confirmed_with', 'evidence', 'lang', 'translated_from', 'source_digest', 'context_id'] as const;

/** Makes or migrates one opinion table: its owner column, the opinion's own columns and the kind's fields. */
async function makeTable(tx: OuterTransaction, table: string, fields: readonly FieldContract[], key: readonly string[], owner: 'node_id' | 'edge_id', kind: string, checks: readonly string[] = [], indexes: readonly { readonly name: string; readonly columns: readonly string[] }[] = []): Promise<void> {
  const name = quote(table, 'table');
  const columns = await columnsOf(tx, table);
  // A table made before opinions held one row per vertex: its shape is not this one, and its rows are derived from the
  // producers, so the fill writes them again in the opinion's shape.
  if (columns.size > 0 && !columns.has('said_by')) {
    await tx.query(`DROP TABLE ${name}`);
    columns.clear();
  }
  // A key field is the vertex's, never a column here: `node.key` states it once.
  const columnsOfKind = fields.filter((field) => !key.includes(field.name));
  if (columns.size === 0) {
    const definitions = [
      ...OPINION_COLUMNS.slice(0, 1),
      `${quote(owner, 'column')} bigint NOT NULL REFERENCES ${owner === 'node_id' ? 'node' : 'edge'} (id)`,
      ...OPINION_COLUMNS.slice(1),
      ...columnsOfKind.map((field) => `${quote(field.name, 'field')} ${sqlType(field)}`),
      ...checks.map((check) => `CHECK (${check})`),
    ];
    await tx.query(`CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(', ')})`);
  } else {
    for (const field of columnsOfKind) {
      const actual = columns.get(field.name);
      if (actual === undefined) {
        if (field.nullable !== true) {
          const history = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name}`);
          if (Number(history.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:297: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is required but absent from ${history.rows[0]!.n} historical opinions: the change is refused`);
        }
        await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`);
        continue;
      }
      if (field.reference !== undefined && sameType(actual, field)) {
        const incompatible = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name} WHERE ${quote(field.name, 'field')} IS NOT NULL AND ${quote(field.name, 'field')}->>'kind' IS DISTINCT FROM $1`, [field.reference]);
        if (Number(incompatible.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:304: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} has ${incompatible.rows[0]!.n} non-null values incompatible with reference ${JSON.stringify(field.reference)}: the change is refused`);
      }
      if (!sameType(actual, field)) {
        const values = await valuesOf(tx, table, field.name);
        if (values > 0) throw new Error(`${import.meta.path}:308: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is ${actual} in ${table} and ${sqlType(field)} in the contract; ${String(values)} non-null values would be lost: the change is refused`);
        await tx.query(`ALTER TABLE ${name} ALTER COLUMN ${quote(field.name, 'field')} TYPE ${sqlType(field)} USING NULL::${sqlType(field)}`);
      }
    }
    const wanted = new Set(columnsOfKind.map((field) => field.name));
    for (const column of [...columns.keys()].sort(byCodePoint)) {
      if (column === owner || (OPINION_FIELDS as readonly string[]).includes(column) || wanted.has(column)) continue;
      const values = await valuesOf(tx, table, column);
      if (values > 0) throw new Error(`${import.meta.path}:316: the kind ${JSON.stringify(kind)} no longer declares the field ${JSON.stringify(column)}; ${String(values)} non-null values would be lost from ${table}: the change is refused`);
      await tx.query(`ALTER TABLE ${name} DROP COLUMN ${quote(column, 'column')}`);
    }
  }
  // The opinions resting on one path are found without a scan: the evidence list is indexed as a document.
  await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_owner`, 'index')} ON ${name} (${quote(owner, 'column')}, "state", "id")`);
  await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_evidence`, 'index')} ON ${name} USING gin ("evidence" jsonb_path_ops)`);
  // A row's fields are matched by the producer's name, its language and its context; a lookup by any of them is indexed.
  await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_producer`, 'index')} ON ${name} (split_part("said_by", '@', 1), ${quote(owner, 'column')}, "lang", "context_id") WHERE "state" = 'open'`);
  // At most one confirmed opinion of one field of one node in one language and one context (A4; the review of stage 1,
  // finding 11). A null language is a language of its own here, so the index treats nulls as equal.
  await tx.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${table}_confirmed`, 'index')} ON ${name} (${quote(owner, 'column')}, "confirmed_field", "lang", "context_id") NULLS NOT DISTINCT WHERE "state" = 'confirmed'`);
  for (const one of indexes) {
    if (key.includes(one.columns[0] ?? '')) continue;
    await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`);
  }
}

/** Makes or migrates one dictionary table: its own columns and its natural key, unique there (item 13). */
async function makeDictionary(tx: OuterTransaction, table: string, dictionary: DictionaryContract): Promise<void> {
  const name = quote(table, 'table');
  const columns = await columnsOf(tx, table);
  if (columns.size === 0) {
    const definitions = [
      `"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`,
      ...dictionary.fields.map((field) => `${quote(field.name, 'field')} ${sqlType(field)}${field.nullable === true ? '' : ' NOT NULL'}`),
      ...(dictionary.checks ?? []).map((check) => `CHECK (${check})`),
    ];
    await tx.query(`CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(', ')})`);
  } else {
    for (const field of dictionary.fields) {
      if (!columns.has(field.name)) await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`);
    }
  }
  const index = quote(`${table}_${dictionary.key.join('_')}_key`, 'index');
  const wanted = dictionary.key.map((column) => quote(column, 'column')).join(', ');
  const held = await tx.query<{ definition: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
    [`${table}_${dictionary.key.join('_')}_key`],
  );
  const definition = held.rows[0]?.definition;
  // `pg_get_indexdef` spells a simple identifier without quotes, so the key's columns are compared as the database
  // writes them. The quoted spelling never matched, and a migration dropped and made every dictionary's key index
  // (madarch-8bdc.2.9).
  if (definition === undefined) {
    await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
  } else if (!definition.includes(`(${dictionary.key.join(', ')})`)) {
    await tx.query(`DROP INDEX ${index}`);
    await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
  }
  for (const one of dictionary.indexes ?? []) {
    await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`);
  }
}

/** Authored natural keys cannot be reinterpreted by changing their field declarations. */
async function preserveAuthoredKeys(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const kind of contract.vertex) {
    const held = await tx.query<{ field: string; value: unknown; n: string }>(`SELECT entry.key AS field, entry.value AS value, count(*)::text AS n
      FROM node n JOIN entity e ON e.id = n.entity_id CROSS JOIN LATERAL jsonb_each(n.key) entry
      WHERE e.name = $1 AND EXISTS (SELECT 1 FROM operation o WHERE o.author LIKE 'person:%'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = e.name AND event->>'uid' = n.uid::text))
      GROUP BY entry.key, entry.value`, [kind.name]);
    const incompatible = new Map<string, number>();
    for (const row of held.rows) {
      const field = kind.fields.find((one) => one.name === row.field);
      const valid = field !== undefined && kind.key.includes(row.field) && (field.reference !== undefined
        ? typeof row.value === 'object' && row.value !== null && 'kind' in row.value && row.value.kind === field.reference
        : field.type === 'text' ? typeof row.value === 'string'
        : field.type === 'integer' ? typeof row.value === 'number' && Number.isInteger(row.value) && row.value >= -2147483648 && row.value <= 2147483647
        : field.type === 'bigint' ? (typeof row.value === 'number' && Number.isSafeInteger(row.value)) || (typeof row.value === 'string' && /^-?\d+$/u.test(row.value) && BigInt(row.value) >= -9223372036854775808n && BigInt(row.value) <= 9223372036854775807n)
        : false);
      if (!valid) incompatible.set(row.field, (incompatible.get(row.field) ?? 0) + Number(row.n));
    }
    for (const [field, count] of [...incompatible].sort(([a], [b]) => byCodePoint(a, b))) {
      throw new Error(`${import.meta.path}:391: the kind ${JSON.stringify(kind.name)} field ${JSON.stringify(field)} has ${count} non-null natural-key values incompatible with the changed contract: the change is refused`);
    }
  }
}

/** The kind rows one contract registers: a vertex is a node kind, an edge an edge kind with its repeat rule. */
async function registerKinds(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const vertex of contract.vertex) {
    await tx.query(`INSERT INTO entity (name, sort) VALUES ($1, 'node') ON CONFLICT (name) DO UPDATE SET sort = 'node', repeats = false, discriminator = NULL`, [vertex.name]);
  }
  for (const edge of contract.edge) {
    await tx.query(
      `INSERT INTO entity (name, sort, repeats, discriminator) VALUES ($1, 'edge', $2, $3) ON CONFLICT (name) DO UPDATE SET sort = 'edge', repeats = EXCLUDED.repeats, discriminator = EXCLUDED.discriminator`,
      [edge.name, edge.repeats, edge.discriminator ?? null],
    );
  }
}

/**
 * Drops the table and the vertices of one vertex kind the manifest no longer takes (decision 0034, item 14: "a kind the
 * manifest does not take has no table"). Its opinions, edges and nodes go with it — a table without its nodes, or nodes
 * without their table, would be a graph that answers two ways — and the journal keeps what people did.
 */
async function dropVertexKind(tx: OuterTransaction, name: string): Promise<void> {
  const table = generatedTableName(name, 'vertex');
  const nodes = `SELECT n.id FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = $1`;
  await tx.query(`DELETE FROM edge WHERE from_node IN (${nodes}) OR to_node IN (${nodes})`, [name]);
  // The kind's own table goes before its nodes do: the table's foreign key names the node.
  await tx.query(`DROP TABLE IF EXISTS ${quote(table, 'table')}`);
  await tx.query(`DELETE FROM node WHERE id IN (${nodes})`, [name]);
  await tx.query(`DELETE FROM entity WHERE name = $1 AND sort = 'node'`, [name]);
}

/** Drops the attribute table and the edges of one edge kind the manifest no longer takes. */
async function dropEdgeKind(tx: OuterTransaction, name: string): Promise<void> {
  const table = generatedTableName(name, 'edge');
  const edges = `SELECT e.id FROM edge e JOIN entity en ON en.id = e.entity_id WHERE en.name = $1`;
  await tx.query(`DELETE FROM edge WHERE id IN (${edges})`, [name]);
  await tx.query(`DELETE FROM entity WHERE name = $1 AND sort = 'edge'`, [name]);
  await tx.query(`DROP TABLE IF EXISTS ${quote(table, 'table')}`);
}


/**
 * The expression indexes the key lookups need (the review of stage 1c, point 15), made from the contract: a vertex is
 * found by its entity and a text key field's value, or by the key values of the entity a reference key field names —
 * that is how a page counts a repository's files and folders without scanning every vertex and every `contains` edge.
 * One index per key field, named by its place in the key, so two fields of one kind never collide within the 63-byte
 * identifier bound.
 */
async function keyIndexes(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const vertex of contract.vertex) {
    const table = tableOf(vertex, 'vertex');
    for (const [at, fieldName] of vertex.key.entries()) {
      const field = vertex.fields.find((one) => one.name === fieldName);
      if (field === undefined) continue;
      let expression: string | undefined;
      if (field.reference !== undefined) {
        const target = contract.vertex.find((one) => one.name === field.reference);
        const targetKey = target?.key[0];
        if (targetKey !== undefined) expression = `((key->'${fieldName}'->'key'->>'${targetKey}'))`;
      } else if (field.type === 'text') {
        expression = `((key->>'${fieldName}'))`;
      }
      if (expression === undefined) continue;
      await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_k${String(at)}`, 'index')} ON node (entity_id, ${expression})`);
    }
  }
}
/** Every kind the store registers that this contract no longer declares, its table and its rows removed. */
async function pruneKinds(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  const declaredVertex = new Set(contract.vertex.map((kind) => kind.name));
  const declaredEdge = new Set(contract.edge.map((kind) => kind.name));
  const held = await tx.query<{ name: string; sort: 'node' | 'edge' }>('SELECT name, sort FROM entity ORDER BY name');
  for (const row of held.rows.sort((a, b) => byCodePoint(a.name, b.name))) {
    const removed = row.sort === 'node' ? !declaredVertex.has(row.name) : !declaredEdge.has(row.name);
    if (!removed) continue;
    const authored = await tx.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM operation o WHERE o.author LIKE 'person:%' AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'opinions') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'edges') event WHERE event->>'entity' = $1)
      )) AS present`, [row.name]);
    if (authored.rows[0]!.present) {
      const table = generatedTableName(row.name, row.sort === 'node' ? 'vertex' : 'edge');
      const columns = await columnsOf(tx, table);
      for (const column of [...columns.keys()].sort(byCodePoint)) {
        if (column === 'node_id' || column === 'edge_id' || (OPINION_FIELDS as readonly string[]).includes(column)) continue;
        const values = await valuesOf(tx, table, column);
        if (values > 0) throw new Error(`${import.meta.path}:480: the removed kind ${JSON.stringify(row.name)} field ${JSON.stringify(column)} holds ${String(values)} non-null values that would be lost: the change is refused`);
      }
      // Key-only opinions and entity identities are history too, even when no attribute holds a value.
      const identity = row.sort === 'node' ? 'node' : 'edge';
      const count = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${identity} WHERE entity_id IN (SELECT id FROM entity WHERE name = $1)`, [row.name]);
      if (Number(count.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:485: the removed kind ${JSON.stringify(row.name)} field "identity" holds ${count.rows[0]!.n} non-null values that would be lost: the change is refused`);
    }
    if (row.sort === 'node') await dropVertexKind(tx, row.name);
    else await dropEdgeKind(tx, row.name);
  }
}

/**
 * Creates or migrates every table a contract declares, and registers its kinds; a kind the contract no longer
 * declares loses its table and its rows, so a product that removes a kind from its manifest holds no table of it. It
 * runs inside the transaction the caller holds: `createOneGraphSchema` makes the mechanism and the product's tables
 * in one transaction, so a crash leaves one shape, never half of one.
 */
export async function createContractTablesIn(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  await preserveAuthoredKeys(tx, contract);
  for (const dictionary of contract.dictionary) await makeDictionary(tx, tableOf(dictionary, 'dictionary'), dictionary);
  for (const vertex of contract.vertex) await makeTable(tx, tableOf(vertex, 'vertex'), vertex.fields, vertex.key, 'node_id', vertex.name, vertex.checks ?? [], vertex.indexes ?? []);
  // Every edge kind's table holds its opinions, with or without fields: the evidence of an edge has its home there too.
  for (const edge of contract.edge) await makeTable(tx, tableOf(edge, 'edge'), edge.fields, [], 'edge_id', edge.name, edge.checks ?? [], edge.indexes ?? []);
  await registerKinds(tx, contract);
  await keyIndexes(tx, contract);
  await pruneKinds(tx, contract);
}

/** The contract a manifest's declarations make: the capability's own tables for every kind it binds. */
export function contractOf(capabilityContracts: readonly { readonly kinds: readonly string[]; readonly edges: readonly string[]; readonly contract: GraphContract }[], declaredKinds: readonly string[], declaredEdges: readonly string[]): GraphContract {
  const vertex: VertexContract[] = [];
  const edge: EdgeContract[] = [];
  const dictionary: DictionaryContract[] = [];
  for (const entry of capabilityContracts) {
    for (const kind of entry.contract.vertex) if (declaredKinds.includes(kind.name) && entry.kinds.includes(kind.name)) vertex.push(kind);
    for (const one of entry.contract.edge) if (declaredEdges.includes(one.name) && entry.edges.includes(one.name)) edge.push(one);
    for (const one of entry.contract.dictionary) if (declaredKinds.some((kind) => entry.kinds.includes(kind)) && !dictionary.some((held) => held.name === one.name)) dictionary.push(one);
  }
  return { vertex, edge, dictionary };
}
