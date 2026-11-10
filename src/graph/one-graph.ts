/**
 * The one graph's mechanism (decision 0034, item 14; its amendment of 2026-11-10 and the review of stage 1):
 * `entity`, `node`, `edge`, contexts and layers, the journal, the unresolved references a publication names
 * and the coverage gaps. Every entity's table is built from the product's contract (`contract.ts`) and holds
 * one row per opinion about one vertex or edge; no name of a product's entity (file, commit, touched …) stands
 * in this module.
 *
 * **One transaction, and a reset when the shape moved.** A store whose graph predates this shape cannot be
 * translated in place: every graph row is derived from a producer, and nothing writes an agent's or a person's
 * opinion yet. Such a store drops its graph tables and makes them again in one transaction, keeps the journal
 * (`operation`), and is marked as needing a fill in the store's own metadata. A crash leaves the old store or the
 * new one, never a half-migrated graph (the review of stage 1, findings 1 and 2).
 *
 * What the database itself refuses here:
 * - two vertices of one entity on one key in one context: `node` is unique by them (a keyless vertex excepted);
 * - an edge of one entity between the same ends twice unless the entity says repeats are allowed and its
 *   discriminator tells them apart;
 * - an opinion whose state is none of open, confirmed and closed;
 * - a second confirmed opinion of one node's field in one language and context (the entity table's partial
 *   unique index, `contract.ts`).
 */
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { sha256Hex } from './digest.js';
import { byCodePoint } from '../model/order.js';
import { createContractTablesIn, EMPTY_CONTRACT, generatedTableName, type GraphContract } from './contract.js';


/** The metadata schema the stamp and the store's own marks stand in: engine metadata, never the graph. */
const META_SCHEMA = 'madarch_meta';
const STAMP_SQL = `CREATE TABLE IF NOT EXISTS ${META_SCHEMA}.schema_stamp (
  name text PRIMARY KEY,
  stamp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`;
const STORE_SCHEMA_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('madarch:store-schema', 0))`;

/** The tables a reset drops, in the order their foreign keys allow: the opinions and the catalogue before the nodes. */
const GENERATED_PREFIXES = ['k_', 'e_', 'd_'] as const;

const SCHEMA: readonly string[] = [
  // Every opinion's id is unique across the graph (the review of stage 1, finding 14): `{type: 'opinion', id}` has
  // one meaning in every entity's table.
  `CREATE SEQUENCE IF NOT EXISTS opinion_id`,
  `CREATE TABLE IF NOT EXISTS entity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (name <> ''),
    sort text NOT NULL CHECK (sort IN ('node', 'edge')),
    repeats boolean NOT NULL DEFAULT false,
    discriminator text CHECK (discriminator IS NULL OR discriminator <> ''),
    CHECK (sort = 'edge' OR NOT repeats),
    CHECK (repeats = (discriminator IS NOT NULL))
  )`,
  // A context is a layer over its parent; the default branch's graph stands whole in the base context (item 8).
  `CREATE TABLE IF NOT EXISTS context (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent bigint REFERENCES context (id),
    ref text NOT NULL,
    CHECK (parent IS NULL OR id <> parent)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_base ON context (ref) WHERE parent IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS context_child ON context (parent, ref) WHERE parent IS NOT NULL`,
  // A vertex is identity and key: the key belongs to the vertex, never to an opinion, in one canonical encoding
  // (fields in the contract's key order, values normalised) and is the same on every machine (A2 of the amendment).
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity (id),
    uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    key jsonb NOT NULL DEFAULT '{}'::jsonb,
    context_id bigint NOT NULL DEFAULT 1 REFERENCES context (id),
    removed boolean NOT NULL DEFAULT false
  )`,
  // A keyless vertex (a kind with no natural key) is keyed by nothing: it stands by its uid alone.
  `CREATE UNIQUE INDEX IF NOT EXISTS node_key_context ON node (entity_id, key, context_id) WHERE key <> '{}'::jsonb`,
  `CREATE INDEX IF NOT EXISTS node_key_lookup ON node USING gin (key jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS node_entity ON node (entity_id, id)`,
  `CREATE TABLE IF NOT EXISTS edge (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id bigint NOT NULL REFERENCES entity (id),
    from_node bigint NOT NULL REFERENCES node (id),
    to_node bigint NOT NULL REFERENCES node (id),
    discriminator text NOT NULL DEFAULT '',
    context_id bigint NOT NULL DEFAULT 1,
    CHECK (from_node <> to_node)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS edge_once ON edge (entity_id, from_node, to_node, discriminator, context_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge (to_node, entity_id)`,
  `CREATE INDEX IF NOT EXISTS edge_from ON edge (from_node, entity_id)`,
  // One journal of every change: each publication's unit, and every operation a person or the agent makes. Its author
  // is a producer and its version, `agent`, or `person:<uid>`; the change names the vertices, edges and opinions it
  // touched, by id (stage 2).
  `CREATE TABLE IF NOT EXISTS operation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author text NOT NULL CHECK (author <> ''),
    machine text NOT NULL DEFAULT '',
    session text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    words text NOT NULL DEFAULT '',
    expectation jsonb,
    change jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS layer_entry (
    context_id bigint NOT NULL REFERENCES context (id),
    slot text NOT NULL CHECK (slot <> ''),
    replaces bigint,
    removed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (context_id, slot)
  )`,
  // What a pass could not read, under the pass that read it (kept from the record store's explicit coverage gaps).
  `CREATE TABLE IF NOT EXISTS gap (
    repository_node bigint NOT NULL REFERENCES node (id),
    what text NOT NULL CHECK (what <> ''),
    reason text NOT NULL CHECK (reason IN ('non-utf8-path', 'shallow-history', 'unreadable')),
    producer text NOT NULL CHECK (producer IN ('tree', 'history')),
    PRIMARY KEY (repository_node, what)
  )`,
  // A reference to a key no vertex holds: the publication records it and goes on (A2; the consistency plugin
  // madarch-stm0.7 reads these). A rerun of the same answer records the same row once (nulls not distinct); the row
  // names its producer and, for an edge end, the edge kind and the other endpoint; and it goes when the reference
  // resolves.
  `CREATE TABLE IF NOT EXISTS unresolved_reference (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_node bigint REFERENCES node (id),
    edge_entity text,
    field text NOT NULL CHECK (field <> ''),
    target_entity text NOT NULL CHECK (target_entity <> ''),
    target_key jsonb NOT NULL,
    producer text NOT NULL CHECK (producer <> ''),
    against_node bigint REFERENCES node (id),
    context_id bigint NOT NULL DEFAULT 1,
    at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, context_id)
  )`,
];


/**
 * Whether the store's graph tables are the shape this module makes: `node` holds its key and its removal, and the
 * opinions number from one sequence the whole graph shares. A store made before this shape has neither.
 */
async function graphShapeStands(tx: OuterTransaction): Promise<boolean> {
  const found = await tx.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'S') AND c.relname IN ('opinion_id', 'node', 'edge', 'entity')`,
  );
  if (found.rows.length !== 4) return false;
  const columns = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'node' AND column_name IN ('key', 'removed')`,
  );
  const author = await tx.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'operation' AND column_name = 'author'`,
  );
  return columns.rows.length === 2 && author.rows[0]?.data_type === 'text';
}

/** Drops every graph table, and the opinions of every entity kind the store held, in one transaction. */
async function resetGraph(tx: OuterTransaction): Promise<void> {
  const held = await tx.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
  );
  const tables = new Set(held.rows.map((row) => row.name));
  const generated = [...tables].filter((name) => GENERATED_PREFIXES.some((prefix) => name.startsWith(prefix)));
  // The journal's rows are kept; its author links name vertices a fill makes again, so they are cleared here, and the
  // constraint that names a node is dropped and made again once the graph stands.
  if (tables.has('operation')) {
    const author = await tx.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'operation' AND column_name = 'author'`,
    );
    const type = author.rows[0]?.data_type;
    if (type !== undefined && type !== 'text') {
      // A journal written before stage 2 linked its author to a node; its rows are kept, the link is kept beside the
      // new author (which a person's or the agent's operation states in words), and the vertices are made again.
      await tx.query('ALTER TABLE operation DROP CONSTRAINT IF EXISTS operation_author_fkey');
      await tx.query('ALTER TABLE operation RENAME COLUMN author TO author_node');
      await tx.query(`ALTER TABLE operation ADD COLUMN author text NOT NULL DEFAULT ''`);
      await tx.query('UPDATE operation SET author_node = NULL WHERE author_node IS NOT NULL');
    } else if (type === undefined) {
      await tx.query(`ALTER TABLE operation ADD COLUMN author text NOT NULL DEFAULT ''`);
    }
    // A journal row written before stage 2 may carry no default for its id; the writer names none, so the database does.
    await tx.query(`ALTER TABLE operation ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  }
  for (const table of ['evidence', 'claim', 'unresolved_reference', 'gap', 'layer_entry', ...generated.sort(byCodePoint), 'edge', 'node', 'kind', 'entity']) {
    await tx.query(`DROP TABLE IF EXISTS "${table}"`);
  }
}

/**
 * Creates the mechanism and, when a contract is given, the tables its entities declare — in one transaction, with
 * a store whose graph predates this shape reset as a whole (the review of stage 1, findings 1 and 2). Answers
 * whether the graph was reset, which is the store saying it needs a fill.
 */
export async function createOneGraphSchema(owner: DatabaseOwner, contract: GraphContract = EMPTY_CONTRACT): Promise<{ reset: boolean }> {
  return await owner.transaction('write', async (tx) => {
    await tx.query(STORE_SCHEMA_LOCK);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${META_SCHEMA}`);
    await tx.query(STAMP_SQL);
    const parts = [
      ...SCHEMA,
      ...contract.vertex.map((kind) => `vertex ${kind.name} ${generatedTableName(kind.name, 'vertex')} ${kind.key.join(',')}`),
      ...contract.edge.map((kind) => `edge ${kind.name} ${generatedTableName(kind.name, 'edge')} ${String(kind.repeats)} ${kind.discriminator ?? ''}`),
      ...contract.dictionary.map((one) => `dictionary ${one.name} ${generatedTableName(one.name, 'dictionary')}`),
    ];
    const stamp = sha256Hex(new TextEncoder().encode(parts.join('\n')));
    // A store whose stamp stands is opened with two statements and no catalog walk: the stamp is read first, and only a
    // store whose stamp moved is looked at further (the page budget: a page that opens the store pays almost nothing).
    const held = await tx.query<{ stamp: string }>(`SELECT stamp FROM ${META_SCHEMA}.schema_stamp WHERE name = 'one-graph'`);
    if (held.rows[0]?.stamp === stamp && await graphShapeStands(tx)) return { reset: false };
    const reset = !await graphShapeStands(tx);
    if (reset) await resetGraph(tx);
    for (const statement of SCHEMA) await tx.query(statement);

    const base = await tx.query<{ id: string }>('SELECT id::text AS id FROM context WHERE parent IS NULL ORDER BY id LIMIT 1');
    if (base.rows[0] === undefined) await tx.query(`INSERT INTO context (parent, ref) VALUES (NULL, '')`);
    await createContractTablesIn(tx, contract);
    await tx.query(
      `INSERT INTO ${META_SCHEMA}.schema_stamp (name, stamp) VALUES ('one-graph', $1) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()`,
      [stamp],
    );
    // The store says it needs a fill: the graph is empty and every row of it is a producer's to state again. A fresh
    // store says the same thing, and a fill makes it true either way.
    if (reset) await tx.query(`INSERT INTO ${META_SCHEMA}.schema_stamp (name, stamp) VALUES ('graph-reset', now()::text) ON CONFLICT (name) DO UPDATE SET stamp = now()::text, created_at = now()`);
    return { reset };
  });
}
