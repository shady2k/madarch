import type { PoolConfig } from 'pg';
import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import { createPostgresDatabaseOwner, ownerQueryDriver, type DatabaseOwner } from './database-owner.js';
import { createSqlQueryDatabase } from './sql-query-database.js';

export interface PostgresQueryDatabaseOptions extends PoolConfig {
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
  /**
   * The process's database owner to lend, opened once and shared with the
   * history store and the future queue tables (decision 0027). Omitted, the
   * query database opens a pool of its own from the pool options beside
   * `clock` and closes it with `close()`; lent, it never closes it — the
   * caller that opened it does. A lent owner is given alone: pool options
   * beside it are refused, because they could only be silently ignored.
   */
  owner?: DatabaseOwner;
}

/** Opens the shared PostgreSQL query database used by a server process. */
export async function createPostgresQueryDatabase(options: PostgresQueryDatabaseOptions): Promise<AsyncQueryDatabase> {
  const { clock, owner, ...poolOptions } = options;
  if (owner !== undefined) {
    const ignored = Object.keys(poolOptions).sort();
    if (ignored.length > 0) {
      throw new Error(`the query database cannot be given both a database owner and the pool options ${ignored.map((key) => `"${key}"`).join(', ')}: the owner already holds the pool it serves, so those options could only be silently ignored`);
    }
    return createSqlQueryDatabase(ownerQueryDriver(owner, { closesOwner: false }), { clock, location: owner.location });
  }
  const opened = await createPostgresDatabaseOwner(poolOptions);
  return createSqlQueryDatabase(ownerQueryDriver(opened, { closesOwner: true }), { clock, location: opened.location });
}
