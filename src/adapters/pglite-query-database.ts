import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../query/sql-driver.js';
import { createSqlQueryDatabase } from './sql-query-database.js';

export interface PGliteQueryDatabaseOptions {
  /** The product-local data directory for this shared graph-query projection; omitted for an in-memory database. */
  path?: string;
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
}

function serialExecutor(executor: Pick<PGlite, 'query'> | Transaction): SqlExecutor {
  let queued: Promise<void> = Promise.resolve();
  return {
    query: <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
      const result = queued.then(async () => {
        const response = await executor.query<Row>(sql, [...values]);
        return { rows: response.rows };
      });
      queued = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

class PGliteQueryDriver implements SqlQueryDriver {
  readonly allowConcurrentSnapshots = false;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(private readonly database: PGlite) {
    this.ready = database.waitReady;
  }

  async transaction<T>(kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.closed) throw new Error('the PGlite query database is closed');
    return this.database.transaction(async (transaction) => {
      const executor = serialExecutor(transaction);
      return work(executor);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready;
    await this.database.close();
  }
}

/** Opens one PGlite query database. Graph-scoped engines borrow this owner and never close its connection. */
export async function createPGliteQueryDatabase(options: PGliteQueryDatabaseOptions = {}): Promise<AsyncQueryDatabase> {
  const database = options.path === undefined
    ? new PGlite({ extensions: { vector } })
    : new PGlite(options.path, { extensions: { vector } });
  const driver = new PGliteQueryDriver(database);
  try {
    await database.waitReady;
    return await createSqlQueryDatabase(driver, { clock: options.clock });
  } catch (error) {
    await driver.close().catch(() => {});
    throw error;
  }
}
