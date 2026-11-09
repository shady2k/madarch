import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import { createDatabaseOwner, ownerQueryDriver, type DatabaseOwner } from './database-owner.js';
import { createSqlQueryDatabase } from './sql-query-database.js';

export interface QueryDatabaseOptions {
  /** The store this shared graph-query projection keeps its tables in; omitted for a private database in the temporary folder. */
  store?: string;
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
  /**
   * The process's database owner to lend, opened once and shared with the
   * history store and the queue's tables (decision 0027). Omitted, the query
   * database opens an owner of its own at `store` and closes it with
   * `close()`; lent, it never closes it — the caller that opened it does.
   * Giving both `owner` and `store` is refused, because the store could only
   * be silently ignored.
   */
  owner?: DatabaseOwner;
}

/** Opens one graph-query database. Graph-scoped engines borrow this owner and never close its connection. */
export async function createQueryDatabase(options: QueryDatabaseOptions = {}): Promise<AsyncQueryDatabase> {
  const { clock, owner: lent, store } = options;
  if (lent !== undefined && store !== undefined) {
    throw new Error(`the query database cannot be given both a database owner and the store "${store}": the owner already names the database it serves, so a store beside it could only be silently ignored`);
  }
  const owner = lent ?? await createDatabaseOwner(store === undefined ? {} : { store });
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
