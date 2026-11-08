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

/** The table the stamps stand in, made by the first schema this module is asked for. */
const STAMP_TABLE = `CREATE TABLE IF NOT EXISTS schema_stamp (
  name text PRIMARY KEY,
  stamp text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`;

/** The digest of one schema: its statements and the names it registers, in the order it runs them. */
function schemaStampOf(parts: readonly string[]): string {
  return sha256Hex(new TextEncoder().encode(parts.join('\n')));
}

export interface SchemaOnceOptions {
  /** The schema's own name in `schema_stamp` (`graph`, `records`, …). */
  readonly name: string;
  /** What the schema is made of, in the order it runs: the digest a later call compares. */
  readonly parts: readonly string[];
  /** Runs the statements, inside the transaction this call holds. */
  readonly create: (transaction: OuterTransaction) => Promise<void>;
}

/** Whether the schema now stands with this digest, and answers whether this call made it. */
export async function createSchemaOnce(owner: DatabaseOwner, options: SchemaOnceOptions): Promise<boolean> {
  const stamp = schemaStampOf(options.parts);
  return await owner.transaction('write', async (transaction) => {
    await transaction.query(STAMP_TABLE);
    const held = await transaction.query<{ stamp: string }>('SELECT stamp FROM schema_stamp WHERE name = $1', [options.name]);
    if (held.rows[0]?.stamp === stamp) return false;
    await options.create(transaction);
    await transaction.query(
      'INSERT INTO schema_stamp (name, stamp) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, created_at = now()',
      [options.name, stamp],
    );
    return true;
  });
}
