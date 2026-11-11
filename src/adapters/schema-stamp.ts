/** Stamped module preparation, called only from the store owner's preparation boundary. */
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

import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from './schema-lock.js';

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
export async function createSchemaOnce(owner: Pick<DatabaseOwner, 'transaction'>, options: SchemaOnceOptions): Promise<boolean> {
  const stamp = schemaStampOf(options.parts);
  return await owner.transaction('write', async (transaction) => {
    // Serialized before anything is read or made: the lock is what makes the check and the DDL one step.
    await transaction.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
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
