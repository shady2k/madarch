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

/**
 * The product repository's files as mechanism state (decision 0034, item 14; the stage C review of madarch-hsqs): the
 * path index, the blob text and the entry that joins them to one repository. Every product's own repository is stored
 * here by the files producer, whatever entities its manifest declares, so a product that binds no code kind still has
 * its files in the graph. The names are the dictionary names stage B used, so a store keeps its ids; the entity kinds'
 * opinion tables refer to the same blob rows.
 */
export const FILE_PATH_TABLE = generatedTableName('path', 'dictionary');
export const FILE_BLOB_TABLE = generatedTableName('blob', 'dictionary');
export const FILE_ENTRY_TABLE = 'file_entry';


/** The metadata schema the stamp and the store's own marks stand in: engine metadata, never the graph. */
const META_SCHEMA = 'madarch_meta';
const STAMP_SQL = `CREATE TABLE IF NOT EXISTS ${META_SCHEMA}.schema_stamp (
  name text PRIMARY KEY,
  stamp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`;
const STORE_SCHEMA_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('madarch:store-schema', 0))`;

/**
 * The revision of the graph's meaning, part of the stamp: a store whose revision differs is reset as a whole, because
 * what its rows say changed even where their shape did not. Revision 2 (madarch-64o5.2): a file's programming language
 * is an opinion field, `language`, not the opinion's `lang`, which is the natural language of a text value and stands
 * null for a language name; a file opinion written under revision 1 cannot be matched by the writer any more, and its
 * store is made again and filled. Revision 3: the store holds no table but the graph's and its mechanisms' —
 * `layer_entry`, `gap` and `knowledge_fill` are gone — and a store that still holds them is reset and filled once.
 * Revision 4: the product repository's files are mechanism state (`file_entry` beside its path and blob dictionaries),
 * so a store written under revision 3 holds no such table and is reset and filled once. Revision 5: a dangling edge's
 * row carries its discriminator (`unresolved_reference.edge_discriminator`), so two dangling edges of one kind and one
 * target are two rows; a store written under revision 4 is reset and filled once.
 */
const SCHEMA_REVISION = 5;

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
    -- The journal's durable total order: a row's number is assigned when it is inserted, never by a clock, so the
    -- entries of one publication and of two publications are replayed in the order they were written (codex, stage 2
    -- review, P2). The time column is kept for a reader that shows when a row was written, never for order.
    seq bigint GENERATED BY DEFAULT AS IDENTITY,
    author text NOT NULL CHECK (author <> ''),
    machine text NOT NULL DEFAULT '',
    session text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    words text NOT NULL DEFAULT '',
    expectation jsonb,
    change jsonb NOT NULL
  )`,
  // The product repository's files as mechanism state: a path's text once, a blob's bytes once, and the entry of each
  // repository path. The code kinds' opinion rows name the same blob rows (see src/graph/write.ts).
  `CREATE TABLE IF NOT EXISTS ${FILE_PATH_TABLE} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    text text NOT NULL UNIQUE CHECK (text <> '')
  )`,
  `CREATE TABLE IF NOT EXISTS ${FILE_BLOB_TABLE} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hash text NOT NULL UNIQUE,
    algorithm text NOT NULL,
    bytes bigint NOT NULL,
    form text NOT NULL,
    lines bigint,
    content text,
    CHECK ((algorithm = 'sha1' AND length(hash) = 40) OR (algorithm = 'sha256' AND length(hash) = 64)),
    CHECK ((form = 'binary') = (lines IS NULL)),
    CHECK ((form = 'text') OR (content IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS ${FILE_ENTRY_TABLE} (
    repository text NOT NULL CHECK (repository <> ''),
    path_id bigint NOT NULL REFERENCES ${FILE_PATH_TABLE} (id),
    mode text,
    blob_id bigint REFERENCES ${FILE_BLOB_TABLE} (id),
    PRIMARY KEY (repository, path_id),
    CHECK ((mode IS NULL) = (blob_id IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS file_entry_blob ON ${FILE_ENTRY_TABLE} (blob_id)`,
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
    edge_discriminator text,
    context_id bigint NOT NULL DEFAULT 1,
    at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id)
  )`,
  // A store made before the discriminator: the column is added, the old identity is replaced, and the rows keep their
  // place. The discriminator tells two dangling edges of one kind and one target apart.
  `ALTER TABLE unresolved_reference ADD COLUMN IF NOT EXISTS edge_discriminator text`,
  `UPDATE unresolved_reference SET edge_discriminator = '' WHERE edge_entity IS NOT NULL AND edge_discriminator IS NULL`,
  `DO $$ DECLARE held text; BEGIN
     SELECT conname INTO held FROM pg_constraint WHERE conrelid = 'unresolved_reference'::regclass AND contype = 'u';
     IF held IS NOT NULL THEN EXECUTE 'ALTER TABLE unresolved_reference DROP CONSTRAINT ' || quote_ident(held); END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS unresolved_reference_identity ON unresolved_reference
     (referrer_node, edge_entity, field, target_entity, target_key, producer, against_node, edge_discriminator, context_id) NULLS NOT DISTINCT`,
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
  for (const table of ['evidence', 'claim', 'unresolved_reference', 'gap', 'layer_entry', 'knowledge_fill', FILE_ENTRY_TABLE, ...generated.sort(byCodePoint), 'edge', 'node', 'kind', 'entity']) {
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
      `revision ${String(SCHEMA_REVISION)}`,
      ...SCHEMA,
      ...contract.vertex.map((kind) => `vertex ${kind.name} ${generatedTableName(kind.name, 'vertex')} ${kind.key.join(',')}`),
      ...contract.edge.map((kind) => `edge ${kind.name} ${generatedTableName(kind.name, 'edge')} ${String(kind.repeats)} ${kind.discriminator ?? ''}`),
      ...contract.dictionary.map((one) => `dictionary ${one.name} ${generatedTableName(one.name, 'dictionary')}`),
    ];
    const stamp = sha256Hex(new TextEncoder().encode(parts.join('\n')));
    // A store whose stamp stands is opened with one statement and no catalog walk: its stamp and its revision are read
    // together, and only a store whose stamp or revision moved is looked at further (the page budget: a page that opens
    // the store pays almost nothing).
    const held = await tx.query<{ name: string; stamp: string }>(
      `SELECT name, stamp FROM ${META_SCHEMA}.schema_stamp WHERE name IN ('one-graph', 'one-graph-revision')`,
    );
    const stampStands = held.rows.find((row) => row.name === 'one-graph')?.stamp === stamp;
    const revisionStands = held.rows.find((row) => row.name === 'one-graph-revision')?.stamp === String(SCHEMA_REVISION);
    if (stampStands && revisionStands && await graphShapeStands(tx)) return { reset: false };
    // The revision is not a shape the store can be migrated into: a store written under another meaning of its rows is
    // reset as a whole — the graph's tables are made again, the journal is kept, and the store says it needs a fill
    // (codex, stage 2 review, P1). A store with this revision whose stamp moved is reset by its shape alone.
    const reset = !revisionStands || !await graphShapeStands(tx);
    if (reset) await resetGraph(tx);
    for (const statement of SCHEMA) await tx.query(statement);
    // The journal's durable order: a store made before it gains the column, once, and its rows take their numbers in
    // the order the journal was read in until now (`at`, then the id) — never a physical row's place.
    const sequenced = await tx.query<{ there: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'operation' AND column_name = 'seq') AS there`,
    );
    if (sequenced.rows[0]?.there !== true) {
      await tx.query('ALTER TABLE operation ADD COLUMN seq bigint');
      await tx.query(`WITH ordered AS (SELECT id, row_number() OVER (ORDER BY at, id) AS n FROM operation) UPDATE operation o SET seq = ordered.n FROM ordered WHERE o.id = ordered.id`);
      await tx.query('CREATE SEQUENCE IF NOT EXISTS operation_seq_seq');
      await tx.query(`SELECT setval('operation_seq_seq', coalesce((SELECT max(seq) FROM operation), 0) + 1, false)`);
      await tx.query(`ALTER TABLE operation ALTER COLUMN seq SET DEFAULT nextval('operation_seq_seq')`);
      await tx.query('ALTER TABLE operation ALTER COLUMN seq SET NOT NULL');
      await tx.query('ALTER SEQUENCE operation_seq_seq OWNED BY operation.seq');
    }

    const base = await tx.query<{ id: string }>('SELECT id::text AS id FROM context WHERE parent IS NULL ORDER BY id LIMIT 1');
    if (base.rows[0] === undefined) await tx.query(`INSERT INTO context (parent, ref) VALUES (NULL, '')`);
    await createContractTablesIn(tx, contract);
    await tx.query(
      `INSERT INTO ${META_SCHEMA}.schema_stamp (name, stamp) VALUES ('one-graph', $1) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()`,
      [stamp],
    );
    await tx.query(
      `INSERT INTO ${META_SCHEMA}.schema_stamp (name, stamp) VALUES ('one-graph-revision', $1) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()`,
      [String(SCHEMA_REVISION)],
    );
    // The store says it needs a fill: the graph is empty and every row of it is a producer's to state again. A fresh
    // store says the same thing, and a fill makes it true either way.
    if (reset) await tx.query(`INSERT INTO ${META_SCHEMA}.schema_stamp (name, stamp) VALUES ('graph-reset', now()::text) ON CONFLICT (name) DO UPDATE SET stamp = now()::text, created_at = now()`);
    return { reset };
  });
}
