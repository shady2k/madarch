/**
 * A schema that stands is not made again (madarch-8bdc.2.5, the page latency of a fill): each fill runs in a worker of its
 * own, and every worker used to re-issue its schema's `CREATE … IF NOT EXISTS` statements — forty DDL statements that take
 * `ACCESS EXCLUSIVE` on the tables a reader is reading, so a page asked while a fill started waited for them (measured on
 * the responsive test: 321 and 335 ms in the first third of a second after the press, and again at a generation
 * publish).
 *
 * A schema now records the digest of what made it, in `schema_stamp` (one row a schema), and a later call with the same
 * digest runs no DDL at all: one `CREATE TABLE IF NOT EXISTS` and one `SELECT`. A build whose statements changed has
 * another digest and runs them again — every statement it runs is idempotent, so that is a re-application, never a
 * rebuild.
 */
import { sha256Hex } from '../graph/digest.js';
import type { DatabaseOwner, OuterTransaction } from './database-owner.js';

/**
 * The schema the stamps stand in, and the table itself. A schema of its own, because the graph's store answers for the
 * tables it holds (`GRAPH_TABLES`) and a stamp table beside them would be a table the graph does not own.
 */
const STAMP_SCHEMA = 'madarch_meta';
const STAMP_TABLE = `CREATE TABLE IF NOT EXISTS ${STAMP_SCHEMA}.schema_stamp (
  name text PRIMARY KEY,
  stamp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`;

/**
 * The advisory lock one schema's creation takes, from the schema's own name: PostgreSQL does not make `CREATE SCHEMA IF
 * NOT EXISTS` or `CREATE TABLE IF NOT EXISTS` safe under concurrency — two connections pass the existence check and the
 * second insert into `pg_namespace` fails with a duplicate key (CI run 42498133661: `duplicate key value violates unique
 * constraint "pg_namespace_nspname_index"`, three processes of one store making the schema at once). The lock is
 * transaction-scoped: the transaction that holds it makes the schema and writes the stamp, and the next caller finds
 * both. It is derived from the name, so every process of every store computes the same key.
 */
function lockKeyOf(name: string): string {
  return BigInt(`0x${sha256Hex(new TextEncoder().encode(`madarch:schema:${name}`)).slice(0, 15)}`).toString();
}

/**
 * One key for every schema one store makes, so the schemas of one store are made one at a time, whatever their names: the
 * stamp's own schema (`madarch_meta`) is made by all of them, and two of them under different keys would race over it.
 */
const STORE_SCHEMA_LOCK = lockKeyOf('store');

/** The key of the store's schema lock, for a schema creator that opens its own transaction. */
export function storeSchemaLockKey(): string {
  return STORE_SCHEMA_LOCK;
}

/** The one statement that takes the store's schema lock inside a transaction the caller already holds. */
export const SCHEMA_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1::bigint)';


/** The digest of one schema: its statements and the names it registers, in the order it runs them. */
function schemaStampOf(parts: readonly string[]): string {
  return sha256Hex(new TextEncoder().encode(parts.join('\n')));
}

export interface SchemaOnceOptions {
  /** The schema's own name in `schema_stamp` (`graph`, `records`, …). */
  readonly name: string;
  /** What the schema is made of, in the order it runs: the digest a later call compares. */
  readonly parts: readonly string[];
  /** The tables the schema makes: a store whose tables were dropped does not stand, whatever its stamp says. */
  readonly tables: readonly string[];
  /** Runs the statements, inside the transaction this call holds. */
  readonly create: (transaction: OuterTransaction) => Promise<void>;
}

/** Whether the schema now stands with this digest, and answers whether this call made it. */
export async function createSchemaOnce(owner: DatabaseOwner, options: SchemaOnceOptions): Promise<boolean> {
  const stamp = schemaStampOf(options.parts);
  return await owner.transaction('write', async (transaction) => {
    // Serialized before anything is read or made: the lock is what makes the check and the DDL one step.
    await transaction.query(SCHEMA_LOCK_SQL, [STORE_SCHEMA_LOCK]);
    await transaction.query(`CREATE SCHEMA IF NOT EXISTS ${STAMP_SCHEMA}`);
    await transaction.query(STAMP_TABLE);
    const held = await transaction.query<{ stamp: string; standing: string }>(
      `SELECT s.stamp, (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($2::text[])) AS standing
         FROM ${STAMP_SCHEMA}.schema_stamp s WHERE s.name = $1`,
      [options.name, options.tables],
    );
    // The stamp stands only while the tables it describes stand: a store reset by a tool or a test drops them, and the
    // stamp beside them must not claim a schema that is gone.
    if (held.rows[0]?.stamp === stamp && Number(held.rows[0]?.standing) === options.tables.length) return false;
    await options.create(transaction);
    await transaction.query(
      `INSERT INTO ${STAMP_SCHEMA}.schema_stamp (name, stamp) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()`,
      [options.name, stamp],
    );
    return true;
  });
}
