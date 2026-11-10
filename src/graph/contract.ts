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
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';

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

/** Where a value was read: the repository, the commit or digest, the path and the lines (decision 0035, item 7). */
export interface ClaimEvidenceDraft {
  readonly repository?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/**
 * One claim a producer makes of a field (decision 0034, its amendment A1): a value and the evidence under it. It is
 * not written beside an authoritative value any more: every value a producer states is an opinion of the fields of
 * the kind, and a claim is the way a result names one of them.
 */
export interface ClaimDraft {
  readonly field: string;
  readonly value: unknown;
  readonly evidence?: ClaimEvidenceDraft;
}

/** One entity a producer names: its kind and the values of its key's fields (decision 0034, item 14). */
export interface EntityRefDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
}

/** One key field's value: a text or a number, or the entity a reference field names. */
export type KeyValueDraft = string | number | EntityRefDraft;

/**
 * One vertex a producer publishes: its kind, its natural key, the values it states of the kind's fields, the evidence
 * those values rest on, and the language of a text value. The values of the key's fields are the entity's identity and
 * are not opinions; every other value is.
 */
export interface VertexDraft {
  readonly kind: string;
  /** The entity's natural key values, by the kind's key fields; a reference is its entity's kind and key. */
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  /** The field values this producer states, by field name; a field it did not read is left out. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** The same, as claims with their own evidence, as a plugin's result names them. */
  readonly claims?: readonly ClaimDraft[];
  /** Where the vertex's values were read. */
  readonly evidence?: ClaimEvidenceDraft;
  /** The language of the text value the opinion states; null for a value that is no text. */
  readonly lang?: string;
  readonly producer: string;
  readonly producerVersion: string;
}

/** One entity a producer no longer holds: its opinions are closed and it leaves the reads (a removal of a term). */
export interface VertexRemovalDraft {
  readonly kind: string;
  readonly key: Readonly<Record<string, KeyValueDraft>>;
  readonly producer: string;
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
  if (!NAME.test(name)) throw new Error(`src/graph/contract.ts: the ${what} ${JSON.stringify(name)} is not a lower-case identifier (a letter, then letters, digits and underscores)`);
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

/** The rows a table holds, for a change that must not lose them. */
async function rowsOf(tx: OuterTransaction, table: string): Promise<number> {
  const found = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quote(table, 'table')}`);
  return Number(found.rows[0]?.n ?? '0');
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
  `"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`,
  `"said_by" text NOT NULL CHECK (said_by <> '')`,
  `"said_at" timestamptz NOT NULL DEFAULT now()`,
  `"state" text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'confirmed', 'closed'))`,
  `"reason" text`,
  `"confirmed_with" jsonb`,
  `"evidence" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array')`,
  `"lang" text`,
  `"translated_from" bigint`,
  `"source_digest" text`,
  `"context_id" bigint NOT NULL DEFAULT 1 REFERENCES context (id)`,
];

/** The columns a reader or a writer names without the kind's own: the opinion's own, in the order `OPINION_COLUMNS`. */
export const OPINION_FIELDS = ['id', 'said_by', 'said_at', 'state', 'reason', 'confirmed_with', 'evidence', 'lang', 'translated_from', 'source_digest', 'context_id'] as const;

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
        await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`);
        continue;
      }
      if (!sameType(actual, field)) {
        const rows = await rowsOf(tx, table);
        if (rows > 0) throw new Error(`src/graph/contract.ts: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is ${actual} in ${table} and ${sqlType(field)} in the contract, and ${String(rows)} rows hold it: the change is refused rather than dropping them`);
        await tx.query(`ALTER TABLE ${name} ALTER COLUMN ${quote(field.name, 'field')} TYPE ${sqlType(field)} USING ${quote(field.name, 'field')}::${sqlType(field)}`);
      }
    }
    const wanted = new Set(columnsOfKind.map((field) => field.name));
    for (const column of columns.keys()) {
      if (column === owner || (OPINION_FIELDS as readonly string[]).includes(column) || wanted.has(column)) continue;
      const rows = await rowsOf(tx, table);
      if (rows > 0) throw new Error(`src/graph/contract.ts: the kind ${JSON.stringify(kind)} no longer declares the field ${JSON.stringify(column)}, and ${table} holds ${String(rows)} rows: the change is refused rather than dropping them`);
      await tx.query(`ALTER TABLE ${name} DROP COLUMN ${quote(column, 'column')}`);
    }
  }
  // The opinions resting on one path are found without a scan: the evidence list is indexed as a document.
  await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_owner`, 'index')} ON ${name} (${quote(owner, 'column')}, "state", "id")`);
  await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(`${table}_evidence`, 'index')} ON ${name} USING gin ("evidence" jsonb_path_ops)`);
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
  if (definition === undefined) {
    await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
  } else if (!definition.includes(`(${dictionary.key.map((column) => `"${column}"`).join(', ')})`)) {
    await tx.query(`DROP INDEX ${index}`);
    await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
  }
  for (const one of dictionary.indexes ?? []) {
    await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`);
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

/** Every kind the store registers that this contract no longer declares, its table and its rows removed. */
async function pruneKinds(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  const declaredVertex = new Set(contract.vertex.map((kind) => kind.name));
  const declaredEdge = new Set(contract.edge.map((kind) => kind.name));
  const held = await tx.query<{ name: string; sort: 'node' | 'edge' }>('SELECT name, sort FROM entity ORDER BY name');
  for (const row of held.rows) {
    if (row.sort === 'node' && !declaredVertex.has(row.name)) await dropVertexKind(tx, row.name);
    else if (row.sort === 'edge' && !declaredEdge.has(row.name)) await dropEdgeKind(tx, row.name);
  }
}

/**
 * Creates or migrates every table a contract declares, and registers its kinds; a kind the contract no longer
 * declares loses its table and its rows, so a product that removes a kind from its manifest holds no table of it. The
 * caller must have made the mechanism tables (`createOneGraphSchema`) in the same store.
 */
export async function createContractTables(owner: DatabaseOwner, contract: GraphContract): Promise<void> {
  await owner.transaction('write', async (tx) => {
    // One contract migration at a time for this store (decision 0034, item 14): the lock is held to the transaction's
    // commit, so two first fills cannot create the same generated table concurrently and lose to the catalog's unique
    // type name. The key is the store's location, the same string every owner of the store names.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner.location]);
    for (const dictionary of contract.dictionary) await makeDictionary(tx, tableOf(dictionary, 'dictionary'), dictionary);
    for (const vertex of contract.vertex) await makeTable(tx, tableOf(vertex, 'vertex'), vertex.fields, vertex.key, 'node_id', vertex.name, vertex.checks ?? [], vertex.indexes ?? []);
    // Every edge kind's table holds its opinions, with or without fields: the evidence of an edge has its home there too.
    for (const edge of contract.edge) await makeTable(tx, tableOf(edge, 'edge'), edge.fields, [], 'edge_id', edge.name, edge.checks ?? [], edge.indexes ?? []);
    await registerKinds(tx, contract);
    await pruneKinds(tx, contract);
  });
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
