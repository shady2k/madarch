/** Contract-driven graph table creation and reconciliation. */
import type { OuterTransaction } from '../database-owner.js';
import { withSpan } from '../../obs/trace.js';
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
  const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ column_name: string; data_type: string }>(statementSql, [table]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  return new Map(found.rows.map((row) => [row.column_name, row.data_type]));
}

/** Historical non-null values, including closed opinions and removed entities. */
async function valuesOf(tx: OuterTransaction, table: string, field: string): Promise<number> {
  const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT count(${quote(field, 'field')})::text AS n FROM ${quote(table, 'table')}`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ n: string }>(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
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
    const authored = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT EXISTS (
      SELECT 1 FROM operation o WHERE o.author LIKE 'person:%' AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'opinions') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'edges') event WHERE event->>'entity' = $1)
      )) AS present`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ present: boolean }>(statementSql, [kind]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    if (authored.rows[0]!.present) throw new Error(`${import.meta.path}:89: the kind ${JSON.stringify(kind)} table ${JSON.stringify(table)} holds person-authored history; replacing its legacy shape is refused: apply a preserving schema migration`);
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `DROP TABLE ${name}`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(', ')})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  } else {
    for (const field of columnsOfKind) {
      const actual = columns.get(field.name);
      if (actual === undefined) {
        if (field.nullable !== true) {
          const history = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
            const statementSql = `SELECT count(*)::text AS n FROM ${name}`;
            span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
            const answer = await tx.query<{ n: string }>(statementSql);
            span.setAttribute('db.rows', answer.rows.length);
            return answer;
          });
          if (Number(history.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:110: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is required but absent from ${history.rows[0]!.n} historical opinions: the change is refused`);
        }
        await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
          const statementSql = `ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`;
          span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
          const answer = await tx.query(statementSql);
          span.setAttribute('db.rows', answer.rows.length);
          return answer;
        });
        continue;
      }
      if (field.reference !== undefined && field.type === 'json' && sameType(actual, field)) {
        const incompatible = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
          const statementSql = `SELECT count(*)::text AS n FROM ${name} WHERE ${quote(field.name, 'field')} IS NOT NULL AND ${quote(field.name, 'field')}->>'kind' IS DISTINCT FROM $1`;
          span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
          const answer = await tx.query<{ n: string }>(statementSql, [field.reference]);
          span.setAttribute('db.rows', answer.rows.length);
          return answer;
        });
        if (Number(incompatible.rows[0]!.n) > 0) throw new Error(`${import.meta.path}:117: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} has ${incompatible.rows[0]!.n} non-null values incompatible with reference ${JSON.stringify(field.reference)}: the change is refused`);
      }
      if (!sameType(actual, field)) {
        const values = await valuesOf(tx, table, field.name);
        if (values > 0) throw new Error(`${import.meta.path}:121: the kind ${JSON.stringify(kind)} field ${JSON.stringify(field.name)} is ${actual} in ${table} and ${sqlType(field)} in the contract; ${String(values)} non-null values would be lost: the change is refused`);
        await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
          const statementSql = `ALTER TABLE ${name} ALTER COLUMN ${quote(field.name, 'field')} TYPE ${sqlType(field)} USING NULL::${sqlType(field)}`;
          span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
          const answer = await tx.query(statementSql);
          span.setAttribute('db.rows', answer.rows.length);
          return answer;
        });
      }
    }
    // A field the contract no longer declares is resolved after every table stands: its mentions become edges, and
    // any other value closes with a journal entry (owner's rule, 2026-11-13: no store refuses to open).
  }
  // The opinions resting on one path are found without a scan: the evidence list is indexed as a document.
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(`${table}_owner`, 'index')} ON ${name} (${quote(owner, 'column')}, "state", "id")`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(`${table}_evidence`, 'index')} ON ${name} USING gin ("evidence" jsonb_path_ops)`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  // A row's fields are matched by the producer's name, its language and its context; a lookup by any of them is indexed.
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(`${table}_producer`, 'index')} ON ${name} (split_part("said_by", '@', 1), ${quote(owner, 'column')}, "lang", "context_id") WHERE "state" = 'open'`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  // At most one confirmed opinion of one field of one node in one language and one context (A4; the review of stage 1,
  // finding 11). A null language is a language of its own here, so the index treats nulls as equal.
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${table}_confirmed`, 'index')} ON ${name} (${quote(owner, 'column')}, "confirmed_field", "lang", "context_id") NULLS NOT DISTINCT WHERE "state" = 'confirmed'`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  for (const one of indexes) {
    if (key.includes(one.columns[0] ?? '')) continue;
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(', ')})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  } else {
    for (const field of dictionary.fields) {
      if (!columns.has(field.name)) await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `ALTER TABLE ${name} ADD COLUMN ${quote(field.name, 'field')} ${sqlType(field)}`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await tx.query(statementSql);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
    }
  }
  const index = quote(`${table}_${dictionary.key.join('_')}_key`, 'index');
  const wanted = dictionary.key.map((column) => quote(column, 'column')).join(', ');
  const held = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ definition: string }>(statementSql, [`${table}_${dictionary.key.join('_')}_key`]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  const definition = held.rows[0]?.definition;
  // `pg_get_indexdef` spells a simple identifier without quotes, so the key's columns are compared as the database
  // writes them. The quoted spelling never matched, and a migration dropped and made every dictionary's key index
  // (madarch-8bdc.2.9).
  if (definition === undefined) {
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  } else if (!definition.includes(`(${dictionary.key.join(', ')})`)) {
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `DROP INDEX ${index}`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE UNIQUE INDEX ${index} ON ${name} (${wanted})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  }
  for (const one of dictionary.indexes ?? []) {
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(one.name, 'index')} ON ${name} (${one.columns.map((column) => quote(column, 'column')).join(', ')})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  }
}

/** Authored natural keys cannot be reinterpreted by changing their field declarations. */
async function preserveAuthoredKeys(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const kind of contract.vertex) {
    const held = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT entry.key AS field, entry.value AS value, count(*)::text AS n
      FROM node n JOIN entity e ON e.id = n.entity_id CROSS JOIN LATERAL jsonb_each(n.key) entry
      WHERE e.name = $1 AND EXISTS (SELECT 1 FROM operation o WHERE o.author LIKE 'person:%'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = e.name AND event->>'uid' = n.uid::text))
      GROUP BY entry.key, entry.value`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ field: string; value: unknown; n: string }>(statementSql, [kind.name]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    const missing = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT required.field, count(*)::text AS n
      FROM node n JOIN entity e ON e.id = n.entity_id CROSS JOIN unnest($2::text[]) required(field)
      WHERE e.name = $1 AND NOT (n.key ? required.field)
        AND EXISTS (SELECT 1 FROM operation o WHERE o.author LIKE 'person:%'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = e.name AND event->>'uid' = n.uid::text))
      GROUP BY required.field`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ field: string; n: string }>(statementSql, [kind.name, kind.key]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    for (const row of missing.rows.sort((a, b) => byCodePoint(a.field, b.field))) {
      throw new Error(`${import.meta.path}:199: the kind ${JSON.stringify(kind.name)} field ${JSON.stringify(row.field)} is absent from ${row.n} authored natural keys: the change is refused`);
    }
    const incompatible = new Map<string, number>();
    for (const row of held.rows) {
      const field = kind.fields.find((one) => one.name === row.field);
      const valid = field !== undefined && kind.key.includes(row.field) && (field.reference !== undefined
        ? typeof row.value === 'object' && row.value !== null && 'kind' in row.value && (row.value.kind === field.reference || row.value.kind === `code.${field.reference}`)
        : field.type === 'boolean' ? typeof row.value === 'boolean'
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
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `INSERT INTO entity (name, sort) VALUES ($1, 'node') ON CONFLICT (name) DO UPDATE SET sort = 'node', repeats = false, discriminator = NULL`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql, [vertex.name]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  }
  for (const edge of contract.edge) {
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `INSERT INTO entity (name, sort, repeats, discriminator) VALUES ($1, 'edge', $2, $3) ON CONFLICT (name) DO UPDATE SET sort = 'edge', repeats = EXCLUDED.repeats, discriminator = EXCLUDED.discriminator`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql, [edge.name, edge.repeats, edge.discriminator ?? null]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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
  const incident = `SELECT e.id FROM edge e WHERE e.from_node IN (${nodes}) OR e.to_node IN (${nodes})`;
  const edgeKinds = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT DISTINCT kind.name FROM edge e JOIN entity kind ON kind.id = e.entity_id WHERE e.id IN (${incident}) ORDER BY kind.name`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ name: string }>(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  for (const kind of edgeKinds.rows) {
    const authored = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT count(*)::text AS n FROM edge e
      JOIN entity kind ON kind.id = e.entity_id
      WHERE kind.name = $2 AND e.id IN (${incident}) AND EXISTS (
        SELECT 1 FROM operation o,
          jsonb_array_elements(COALESCE(o.change->'opinions', '[]'::jsonb) || COALESCE(o.change->'edges', '[]'::jsonb)) event
        WHERE o.author LIKE 'person:%' AND event->>'entity' = kind.name AND event->>'edge' = e.id::text
      )`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ n: string }>(statementSql, [name, kind.name]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    const count = Number(authored.rows[0]!.n);
    if (count > 0) throw new Error(`${import.meta.path}: the removed kind ${JSON.stringify(name)} has ${String(count)} incident edge${count === 1 ? '' : 's'} of kind ${JSON.stringify(kind.name)} with authored history that would be lost: the change is refused`);
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `DELETE FROM ${quote(generatedTableName(kind.name, 'edge'), 'table')} WHERE edge_id IN (${incident})`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql, [name]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  }
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DELETE FROM edge WHERE id IN (${incident})`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  // The kind's own table goes before its nodes do: the table's foreign key names the node.
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DROP TABLE IF EXISTS ${quote(table, 'table')}`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DELETE FROM node WHERE id IN (${nodes})`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DELETE FROM entity WHERE name = $1 AND sort = 'node'`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
}

/** Drops the attribute table and the edges of one edge kind the manifest no longer takes. */
async function dropEdgeKind(tx: OuterTransaction, name: string): Promise<void> {
  const table = generatedTableName(name, 'edge');
  const edges = `SELECT e.id FROM edge e JOIN entity en ON en.id = e.entity_id WHERE en.name = $1`;
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DROP TABLE IF EXISTS ${quote(table, 'table')}`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DELETE FROM edge WHERE id IN (${edges})`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `DELETE FROM entity WHERE name = $1 AND sort = 'edge'`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [name]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
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
      await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `CREATE INDEX IF NOT EXISTS ${quote(`${table}_k${String(at)}`, 'index')} ON node (entity_id, ${expression})`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await tx.query(statementSql);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
    }
  }
}
/** Every kind the store registers that this contract no longer declares, its table and its rows removed. */
async function pruneKinds(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  const declaredVertex = new Set(contract.vertex.map((kind) => kind.name));
  const declaredEdge = new Set(contract.edge.map((kind) => kind.name));
  const held = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = 'SELECT name, sort FROM entity ORDER BY name';
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ name: string; sort: 'node' | 'edge' }>(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  for (const row of held.rows.sort((a, b) => byCodePoint(a.name, b.name))) {
    const removed = row.sort === 'node' ? !declaredVertex.has(row.name) : !declaredEdge.has(row.name);
    if (!removed) continue;
    const authored = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT EXISTS (
      SELECT 1 FROM operation o WHERE o.author LIKE 'person:%' AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'opinions') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'vertices') event WHERE event->>'entity' = $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.change->'edges') event WHERE event->>'entity' = $1)
      )) AS present`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ present: boolean }>(statementSql, [row.name]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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
      const count = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `SELECT count(*)::text AS n FROM ${identity} WHERE entity_id IN (SELECT id FROM entity WHERE name = $1)`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await tx.query<{ n: string }>(statementSql, [row.name]);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
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
  const prior = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = "SELECT stamp FROM madarch_meta.schema_stamp WHERE name = 'graph-constraints'";
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ stamp: string }>(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
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
  await resolveRemovedColumns(tx, contract);
  await pruneKinds(tx, contract);
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = "INSERT INTO madarch_meta.schema_stamp (name, stamp) VALUES ('graph-constraints', $1) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()";
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [constraints]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
}

/**
 * The fields a contract no longer declares, resolved so that a populated store still opens: a page's `mentions` values
 * become `mentions` edges (each occurrence place kept as `migrated:<row>:<index>`), and any other value closes with a
 * journal entry naming what went. The column is dropped afterwards; the store never refuses to open.
 */
async function resolveRemovedColumns(tx: OuterTransaction, contract: GraphContract): Promise<void> {
  for (const vertex of contract.vertex) {
    await resolveTable(tx, contract, generatedTableName(vertex.name, 'vertex'), vertex.name, vertex.fields.map((field) => field.name), 'node_id');
  }
  for (const edge of contract.edge) {
    await resolveTable(tx, contract, generatedTableName(edge.name, 'edge'), edge.name, edge.fields.map((field) => field.name), 'edge_id');
  }
}

async function resolveTable(tx: OuterTransaction, contract: GraphContract, table: string, kind: string, declared: readonly string[], owner: 'node_id' | 'edge_id'): Promise<void> {
  const columns = await columnsOf(tx, table);
  const wanted = new Set(declared);
  for (const column of [...columns.keys()].sort(byCodePoint)) {
    if (column === owner || (OPINION_FIELDS as readonly string[]).includes(column) || wanted.has(column)) continue;
    const values = await valuesOf(tx, table, column);
    let migrated = 0;
    if (values > 0) migrated = column === 'mentions' && owner === 'node_id' ? await migrateMentions(tx, contract, table, kind) : 0;
    if (values > 0 && migrated === 0) await recordClosedColumn(tx, kind, column, values);
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `ALTER TABLE ${quote(table, 'table')} DROP COLUMN ${quote(column, 'column')}`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
  }
}

/** One entity the store names, from a value a removed page stated: a uid, or `kind:<uid prefix>`. */
async function mentionedNodeOf(tx: OuterTransaction, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || value === '') return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    return (await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = 'SELECT id::text AS id FROM node WHERE uid = $1::uuid AND NOT removed LIMIT 1';
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query<{ id: string }>(statementSql, [value]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    })).rows[0]?.id;
  }
  const cut = value.lastIndexOf(':');
  if (cut <= 0) return undefined;
  const kind = value.slice(0, cut);
  const prefix = value.slice(cut + 1);
  if (!/^[0-9a-f]{4,}$/iu.test(prefix)) return undefined;
  return (await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT n.id::text AS id FROM node n JOIN entity e ON e.id = n.entity_id
     WHERE e.name = $1 AND n.uid::text LIKE $2 AND n.context_id = 1 AND NOT n.removed LIMIT 1`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ id: string }>(statementSql, [kind, `${prefix.toLowerCase()}%`]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  })).rows[0]?.id;
}

/** A page's `mentions` values become `mentions` edges, one per occurrence value, through the one graph store. */
async function migrateMentions(tx: OuterTransaction, contract: GraphContract, table: string, kind: string): Promise<number> {
  const edge = contract.edge.find((one) => one.name === 'mentions');
  if (edge === undefined || edge.table === undefined) return 0;
  const edgeTable = edge.table;
  const entity = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `INSERT INTO entity (name, sort, repeats, discriminator) VALUES ('mentions', 'edge', true, 'place')
     ON CONFLICT (name) DO UPDATE SET sort = 'edge', repeats = true, discriminator = 'place' RETURNING id::text AS id`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ id: string }>(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  const entityId = entity.rows[0]?.id;
  if (entityId === undefined) return 0;
  const rows = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `SELECT id::text AS opinion_id, node_id::text AS node_id, mentions, context_id::text AS context_id FROM ${quote(table, 'table')} WHERE mentions IS NOT NULL`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query<{ opinion_id: string; node_id: string; mentions: unknown; context_id: string }>(statementSql);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
  let migrated = 0;
  for (const row of rows.rows) {
    const mentions = Array.isArray(row.mentions) ? row.mentions : [];
    for (const [index, value] of mentions.entries()) {
      const to = await mentionedNodeOf(tx, value);
      if (to === undefined) continue;
      const discriminator = `migrated:${row.opinion_id}:${String(index)}`;
      const made = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `INSERT INTO edge (entity_id, from_node, to_node, discriminator, context_id) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::bigint)
         ON CONFLICT (entity_id, from_node, to_node, discriminator, context_id) DO NOTHING RETURNING id::text AS id`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await tx.query<{ id: string }>(statementSql, [entityId, row.node_id, to, discriminator, row.context_id]);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      const madeRow = made.rows[0];
      if (madeRow === undefined) continue;
      await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `INSERT INTO ${quote(edgeTable, 'table')} (edge_id, said_by, evidence, context_id) VALUES ($1::bigint, 'migration@1', '[]'::jsonb, $2::bigint)`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await tx.query(statementSql, [madeRow.id, row.context_id]);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      migrated += 1;
    }
  }
  if (migrated > 0) await recordMigration(tx, `${String(migrated)} mentions of the kind ${JSON.stringify(kind)} became mentions edges`);
  return migrated;
}

/** A journal entry for a migration, in the same transaction and through the same table as every other operation. */
async function recordMigration(tx: OuterTransaction, words: string, change: Record<string, unknown> = {}): Promise<void> {
  await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const statementSql = `INSERT INTO operation (author, words, change) VALUES ('migration@1', $1, $2::jsonb)`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
    const answer = await tx.query(statementSql, [words, JSON.stringify(change)]);
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
}

/** A removed field whose values could not become edges: they close, and the journal says what went. */
async function recordClosedColumn(tx: OuterTransaction, kind: string, column: string, values: number): Promise<void> {
  await recordMigration(
    tx,
    `the field ${JSON.stringify(column)} of the kind ${JSON.stringify(kind)} was removed by a contract change; ${String(values)} values closed`,
    { closed: [{ kind, field: column, values }] },
  );
}
