import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import { createPGliteDatabaseOwner, ownerQueryDriver, type DatabaseOwner } from './database-owner.js';
import { createSqlQueryDatabase } from './sql-query-database.js';

export interface PGliteQueryDatabaseOptions {
  /** The product-local data directory for this shared graph-query projection; omitted for an in-memory database. */
  path?: string;
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
  /**
   * The process's database owner to lend, opened once and shared with the
   * history store and the future queue tables (decision 0027). It must have
   * been opened with `vector: true`, which this projection's schema and
   * vector index need; one opened without it is refused, naming the owner,
   * because the engine could only fail later inside `CREATE EXTENSION`.
   * Omitted, the query database opens a PGlite of its own
   * at `path` and closes it with `close()`; lent, it never closes it — the
   * caller that opened it does. Giving both `owner` and `path` is refused,
   * because the path could only be silently ignored.
   */
  owner?: DatabaseOwner;
}

/** Opens one PGlite query database. Graph-scoped engines borrow this owner and never close its connection. */
export async function createPGliteQueryDatabase(options: PGliteQueryDatabaseOptions = {}): Promise<AsyncQueryDatabase> {
  const { clock, owner: lent, path } = options;
  if (lent !== undefined && path !== undefined) {
    throw new Error(`the query database cannot be given both a database owner and the path "${path}": the owner already names the database it serves, so a path beside it could only be silently ignored`);
  }
  if (lent !== undefined && !lent.hasVector) {
    throw new Error(`the query database was lent the database owner "${lent.location}", whose database was not opened with the pgvector extension: this projection creates the extension and its vector index needs it, so open the owner with vector: true`);
  }
  const owner = lent ?? createPGliteDatabaseOwner({ path, vector: true });
  if (lent === undefined) {
    try {
      await owner.ready;
    } catch (error) {
      await owner.close().catch(() => {});
      throw error;
    }
  }
  // The driver closes the owner only for the database this call opened; a
  // lent owner outlives the query database that borrows it.
  return createSqlQueryDatabase(ownerQueryDriver(owner, { closesOwner: lent === undefined }), { clock, location: owner.location });
}
