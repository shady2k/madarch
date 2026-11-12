/** Graph preparation: the sole writer of the mechanism and contract tables. */
import type { DatabaseOwner, OuterTransaction } from '../database-owner.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from '../schema-lock.js';
import { byCodePoint } from '../../model/order.js';
import { EMPTY_CONTRACT, type GraphContract } from '../../graph/contract.js';
import { createContractTablesIn } from './graph-contract.js';
import { SCHEMA, SCHEMA_REVISION, graphSchemaStamp } from './graph-definition.js';

/** The metadata schema the stamp and the store's own marks stand in: engine metadata, never the graph. */
const META_SCHEMA = 'madarch_meta';
const STAMP_SQL = `CREATE TABLE IF NOT EXISTS ${META_SCHEMA}.schema_stamp (
  name text PRIMARY KEY,
  stamp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`;

/** The tables a reset drops, in the order their foreign keys allow. */
const GENERATED_PREFIXES = ['k_', 'e_', 'd_'] as const;

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
  for (const table of ['evidence', 'claim', 'unresolved_reference', 'gap', 'layer_entry', 'knowledge_fill', 'file_entry', ...generated.sort(byCodePoint), 'edge', 'node', 'kind', 'entity']) {
    await tx.query(`DROP TABLE IF EXISTS "${table}"`);
  }
}

/**
 * Creates the mechanism and, when a contract is given, the tables its entities declare — in one transaction, with
 * a store whose graph predates this shape reset as a whole (the review of stage 1, findings 1 and 2). Answers
 * whether the graph was reset, which is the store saying it needs a fill.
 */
export async function prepareGraphSchema(owner: DatabaseOwner, contract: GraphContract = EMPTY_CONTRACT): Promise<{ reset: boolean }> {
  return await owner.transaction('write', async (tx) => {
    await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${META_SCHEMA}`);
    await tx.query(STAMP_SQL);
    const stamp = graphSchemaStamp(contract);
    // A store whose stamp stands is opened with one statement and no catalog walk: its stamp and its revision are read
    // together, and only a store whose stamp or revision moved is looked at further (the page budget: a page that opens
    // the store pays almost nothing).
    const held = await tx.query<{ name: string; stamp: string }>(
      `SELECT name, stamp FROM ${META_SCHEMA}.schema_stamp WHERE name IN ('one-graph', 'one-graph-revision')`,
    );
    const stampStands = held.rows.find((row) => row.name === 'one-graph')?.stamp === stamp;
    const revisionStands = held.rows.find((row) => row.name === 'one-graph-revision')?.stamp === String(SCHEMA_REVISION);
    if (stampStands && revisionStands && await graphShapeStands(tx)) return { reset: false };
    const reset = !revisionStands || !await graphShapeStands(tx);
    const authorColumn = await tx.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'operation' AND column_name = 'author'`,
    );
    if (reset && authorColumn.rows[0]?.data_type === 'text') {
      const authored = await tx.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM operation WHERE author LIKE 'person:%') AS present`);
      if (authored.rows[0]?.present === true) throw new Error(`${import.meta.path}:96: the graph schema changed and this store holds person-authored history; automatic reset is refused to preserve authored data. Export a backup and apply a preserving schema migration before opening this changed schema.`);
    }
    // The revision is not a shape the store can be migrated into: a store written under another meaning of its rows is
    // reset as a whole — the graph's tables are made again, the journal is kept, and the store says it needs a fill
    // (codex, stage 2 review, P1). A store with this revision whose stamp moved is reset by its shape alone.
    if (reset) {
      await resetGraph(tx);
      await tx.query("DELETE FROM madarch_meta.schema_stamp WHERE name = 'graph-constraints'");
    }
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
