/** Contract-driven graph table creation and reconciliation. */
import type { OuterTransaction } from '../database-owner.js';
import { byCodePoint } from '../../model/order.js';
import { generatedTableName, OPINION_FIELDS, type FieldContract, type DictionaryContract, type GraphContract, type TableSort } from '../../graph/contract.js';

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
  if (!NAME.test(name)) throw new Error(`src/adapters/schemas/graph-contract.ts: the ${what} ${JSON.stringify(name)} is not a lower-case identifier (a letter, then letters, digits and underscores)`);
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

/** Makes or migrates one opinion table: its owner column, the opinion's own columns and the kind's fields. */
async function makeTable(tx: OuterTransaction, table: string, fields: readonly FieldContract[], key: readonly string[], owner: 'node_id' | 'edge_id', kind: string, checks: readonly string[] = [], indexes: readonly { readonly name: string; readonly columns: readonly string[] }[] = []): Promise<void> {
  const name = quote(table, 'table');
  const columns = await columnsOf(tx, table);
  // A table made before opinions held one row per vertex: its shape is not this one, and its rows are derived from the
  // producers, so the fill writes them again in the opinion's shape.
  if (columns.size > 0 && !columns.has('said_by')) {
    const authored = await tx.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM operation o WHERE o.author LIKE 'person:%' AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'opinions') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'edges') event WHERE event->>'entity' = $1)
      )) AS present`, [kind]);
    if (authored.rows[0]!.present) throw new Error(`${import.meta.path}:89: the kind ${JSON.stringify(kind)} table ${JSON.stringify(table)} holds person-authored history; replacing its legacy shape is refused: apply a preserving schema migration`);
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
          if (Number(history.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:110: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is required but absent from ${history.rows[0]!.n} historical opinions: the change is refused`);
        }
        await tx.query(`ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`);
        continue;
      }
      if (field.reference !== undefined && sameType(actual, field)) {
        const incompatible = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name} WHERE ${quote(field.name, 'field')} IS NOT NULL AND ${quote(field.name, 'field')}->>'kind' IS DISTINCT FROM $1`, [field.reference]);
        if (Number(incompatible.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:117: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} has ${incompatible.rows[0]!.n} non-null values incompatible with reference ${JSON.stringify(field.reference)}: the change is refused`);
      }
      if (!sameType(actual, field)) {
        const values = await valuesOf(tx, table, field.name);
        if (values > 0) throw new Error(`${import.meta.path}:121: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is ${actual} in ${table} and ${sqlType(field)} in the contract; ${String(values)} non-null values would be lost: the change is refused`);
        await tx.query(`ALTER TABLE ${name} ALTER COLUMN ${quote(field.name, 'field')} TYPE ${sqlType(field)} USING NULL::${sqlType(field)}`);
      }
    }
    const wanted = new Set(columnsOfKind.map((field) => field.name));
    for (const column of [...columns.keys()].sort(byCodePoint)) {
      if (column === owner || (OPINION_FIELDS as readonly string[]).includes(column) || wanted.has(column)) continue;
      const values = await valuesOf(tx, table, column);
      if (values > 0) throw new Error(`${import.meta.path}:129: the kind ${JSON.stringify(kind)} no longer declares the field ${JSON.stringify(column)}; ${String(values)} non-null values would be lost from ${table}: the change is refused`);
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
    const missing = await tx.query<{ field: string; n: string }>(`SELECT required.field, count(*)::text AS n
      FROM node n JOIN entity e ON e.id = n.entity_id CROSS JOIN unnest($2::text[]) required(field)
      WHERE e.name = $1 AND NOT (n.key ? required.field)
        AND EXISTS (SELECT 1 FROM operation o WHERE o.author LIKE 'person:%'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = e.name AND event->>'uid' = n.uid::text))
      GROUP BY required.field`, [kind.name, kind.key]);
    for (const row of missing.rows.sort((a, b) => byCodePoint(a.field, b.field))) {
      throw new Error(`${import.meta.path}:199: the kind ${JSON.stringify(kind.name)} field ${JSON.stringify(row.field)} is absent from ${row.n} authored natural keys: the change is refused`);
    }
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
      throw new Error(`${import.meta.path}:213: the kind ${JSON.stringify(kind.name)} field ${JSON.stringify(field)} has ${count} non-null natural-key values incompatible with the changed contract: the change is refused`);
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
        if (values > 0) throw new Error(`${import.meta.path}:302: the removed kind ${JSON.stringify(row.name)} field ${JSON.stringify(column)} holds ${String(values)} non-null values that would be lost: the change is refused`);
      }
      // Key-only opinions and entity identities are history too, even when no attribute holds a value.
      const identity = row.sort === 'node' ? 'node' : 'edge';
      const count = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${identity} WHERE entity_id IN (SELECT id FROM entity WHERE name = $1)`, [row.name]);
      if (Number(count.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:307: the removed kind ${JSON.stringify(row.name)} field "identity" holds ${count.rows[0]!.n} non-null values that would be lost: the change is refused`);
    }
    if (row.sort === 'node') await dropVertexKind(tx, row.name);
    else await dropEdgeKind(tx, row.name);
  }
}

/**
 * Creates or migrates every table a contract declares, and registers its kinds; a kind the contract no longer
 * declares loses its table and its rows, so a product that removes a kind from its manifest holds no table of it. It
 * runs inside the transaction the caller holds: `prepareGraphSchema` makes the mechanism and the product's tables
 * in one transaction, so a crash leaves one shape, never half of one.
 */
export async function createContractTablesIn(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  // Existing checks and named indexes are not rewritten by reconciliation. Keep their declarations so a later
  // change is refused instead of stamping a contract whose constraints the database does not enforce.
  const constraints = JSON.stringify({
    vertex: contract.vertex.map((kind) => ({ name: kind.name, checks: kind.checks ?? [], indexes: kind.indexes ?? [] })),
    edge: contract.edge.map((kind) => ({ name: kind.name, checks: kind.checks ?? [], indexes: kind.indexes ?? [] })),
    dictionary: contract.dictionary.map((kind) => ({ name: kind.name, checks: kind.checks ?? [], indexes: kind.indexes ?? [] })),
  });
  const prior = await tx.query<{ stamp: string }>("SELECT stamp FROM madarch_meta.schema_stamp WHERE name = 'graph-constraints'");
  if (prior.rows[0] !== undefined && prior.rows[0].stamp !== constraints) {
    const previous = JSON.parse(prior.rows[0].stamp) as Record<string, { name: string; checks: string[]; indexes: unknown[] }[]>;
    const requested = JSON.parse(constraints) as typeof previous;
    for (const sort of ['vertex', 'edge', 'dictionary']) {
      for (const kind of requested[sort] ?? []) {
        const held = previous[sort]?.find((one) => one.name === kind.name);
        if (held !== undefined && (JSON.stringify(held.checks) !== JSON.stringify(kind.checks) || JSON.stringify(held.indexes) !== JSON.stringify(kind.indexes))) {
          throw new Error(`src/adapters/schemas/graph-contract.ts: changed checks or indexes for ${kind.name} require an explicit migration; the contract was not prepared`);
        }
      }
    }
  }
  await preserveAuthoredKeys(tx, contract);
  for (const dictionary of contract.dictionary) await makeDictionary(tx, tableOf(dictionary, 'dictionary'), dictionary);
  for (const vertex of contract.vertex) await makeTable(tx, tableOf(vertex, 'vertex'), vertex.fields, vertex.key, 'node_id', vertex.name, vertex.checks ?? [], vertex.indexes ?? []);
  // Every edge kind's table holds its opinions, with or without fields: the evidence of an edge has its home there too.
  for (const edge of contract.edge) await makeTable(tx, tableOf(edge, 'edge'), edge.fields, [], 'edge_id', edge.name, edge.checks ?? [], edge.indexes ?? []);
  await registerKinds(tx, contract);
  await keyIndexes(tx, contract);
  await pruneKinds(tx, contract);
  await tx.query("INSERT INTO madarch_meta.schema_stamp (name, stamp) VALUES ('graph-constraints', $1) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()", [constraints]);
}
