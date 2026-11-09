/**
 * The contracts a product's manifest declares, and the tables madarch builds
 * from them (decision 0034, item 14): a vertex kind's fields and natural key,
 * an edge kind's ends, repeat rule and attributes, and a dictionary's values.
 * A capability publishes the contract of what it produces; a manifest that
 * declares a kind filled by it takes that contract. The engine's own DDL holds
 * only the mechanism (`one-graph.ts`); every name of a product's kind stands
 * here or in a capability's declaration, never in the mechanism.
 *
 * A table is made from a validated name and a fixed type map. A declaration
 * that changes adds a column, replaces a key constraint, or — when a removed or
 * retyped field still holds rows — refuses by naming the kind and the field; it
 * never drops data in silence.
 */
import { createHash } from 'node:crypto';
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';

/** The sort of table a generated name belongs to: a vertex, an edge's attributes, or a dictionary. */
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
  readonly fields: readonly FieldContract[];
  /** The natural key, unique in the kind's table. */
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

/** Makes or migrates one table's columns and its natural key; the key's index is named after the table. */
async function makeTable(tx: OuterTransaction, table: string, fields: readonly FieldContract[], key: readonly string[], ownerColumns: readonly string[], kind: string, checks: readonly string[] = [], indexes: readonly { readonly name: string; readonly columns: readonly string[] }[] = []): Promise<void> {
  const name = quote(table, 'table');
  const columns = await columnsOf(tx, table);
  if (columns.size === 0) {
    const definitions = [
      ...ownerColumns.map((column) => `${quote(column, 'column')} bigint ${column === 'id' ? 'GENERATED ALWAYS AS IDENTITY' : ''} PRIMARY KEY${column === 'id' ? '' : ` REFERENCES ${column === 'node_id' ? 'node' : 'edge'} (id)`}`),
      ...(ownerColumns[0] === 'id' ? [] : [`${quote('context_id', 'column')} bigint NOT NULL DEFAULT 1 REFERENCES context (id)`]),
      ...(ownerColumns[0] === 'node_id' ? [`${quote('tombstone', 'column')} boolean NOT NULL DEFAULT false`] : []),
      ...fields.map((field) => `${quote(field.name, 'field')} ${sqlType(field)}${field.nullable === true ? '' : ' NOT NULL'}`),
      ...checks.map((check) => `CHECK (${check})`),
    ];
    await tx.query(`CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(', ')})`);
  } else {
    for (const field of fields) {
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
    if (ownerColumns[0] !== 'id' && !columns.has('context_id')) await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote('context_id', 'column')} bigint NOT NULL DEFAULT 1 REFERENCES context (id)`);
    if (ownerColumns[0] === 'node_id' && !columns.has('tombstone')) await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote('tombstone', 'column')} boolean NOT NULL DEFAULT false`);
    const wanted = new Set(fields.map((field) => field.name));
    if (ownerColumns[0] !== 'id') wanted.add('context_id');
    if (ownerColumns[0] === 'node_id') wanted.add('tombstone');
    for (const column of columns.keys()) {
      if (ownerColumns.includes(column) || wanted.has(column)) continue;
      const rows = await rowsOf(tx, table);
      if (rows > 0) throw new Error(`src/graph/contract.ts: the kind ${JSON.stringify(kind)} no longer declares the field ${JSON.stringify(column)}, and ${table} holds ${String(rows)} rows: the change is refused rather than dropping them`);
      await tx.query(`ALTER TABLE ${name} DROP COLUMN ${quote(column, 'column')}`);
    }
  }
  if (key.length > 0) {
    const index = quote(`${table}_${key.join('_')}_key`, 'index');
    const wanted = key.map((column) => quote(column, 'column')).join(', ');
    const held = await tx.query<{ definition: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
      [`${table}_${key.join('_')}_key`],
    );
    const definition = held.rows[0]?.definition;
    if (definition === undefined) {
      await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
    } else if (!definition.includes(`(${key.map((column) => `"${column}"`).join(', ')})`)) {
      await tx.query(`DROP INDEX ${index}`);
      await tx.query(`CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`);
    }
  }
  for (const one of indexes) {
    await tx.query(`CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`);
  }
}

/** The kind rows one contract registers: a vertex is a node kind, an edge an edge kind with its repeat rule. */
async function registerKinds(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const vertex of contract.vertex) {
    await tx.query(`INSERT INTO kind (name, sort) VALUES ($1, 'node') ON CONFLICT (name) DO UPDATE SET sort = 'node', repeats = false, discriminator = NULL`, [vertex.name]);
  }
  for (const edge of contract.edge) {
    await tx.query(
      `INSERT INTO kind (name, sort, repeats, discriminator) VALUES ($1, 'edge', $2, $3) ON CONFLICT (name) DO UPDATE SET sort = 'edge', repeats = EXCLUDED.repeats, discriminator = EXCLUDED.discriminator`,
      [edge.name, edge.repeats, edge.discriminator ?? null],
    );
  }
}

/**
 * Creates or migrates every table a contract declares, and registers its kinds. The caller must have made the
 * mechanism tables (`createOneGraphSchema`) in the same store.
 */
export async function createContractTables(owner: DatabaseOwner, contract: GraphContract): Promise<void> {
  await owner.transaction('write', async (tx) => {
    // One contract migration at a time for this store (decision 0034, item 14): the lock is held to the transaction's
    // commit, so two first fills cannot create the same generated table concurrently and lose to the catalog's unique
    // type name. The key is the store's location, the same string every owner of the store names.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner.location]);
    for (const dictionary of contract.dictionary) {
      await makeTable(tx, tableOf(dictionary, 'dictionary'), dictionary.fields, dictionary.key, ['id'], dictionary.name, dictionary.checks ?? [], dictionary.indexes ?? []);
    }
    for (const vertex of contract.vertex) {
      await makeTable(tx, tableOf(vertex, 'vertex'), vertex.fields, vertex.key, ['node_id'], vertex.name, vertex.checks ?? [], vertex.indexes ?? []);
    }
    for (const edge of contract.edge) {
      if (edge.table !== undefined && edge.fields.length > 0) {
        await makeTable(tx, tableOf(edge, 'edge'), edge.fields, [], ['edge_id'], edge.name, edge.checks ?? [], edge.indexes ?? []);
      }
    }
    await registerKinds(tx, contract);
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
