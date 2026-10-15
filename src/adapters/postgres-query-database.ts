import type { Pool, PoolConfig } from 'pg';
import type { Clock } from '../history/types.js';
import type { AsyncQueryDatabase } from '../query/types.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../query/sql-driver.js';
import { createSqlQueryDatabase } from './sql-query-database.js';

export interface PostgresQueryDatabaseOptions extends PoolConfig {
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
}

class PostgresQueryDriver implements SqlQueryDriver {
  readonly allowConcurrentSnapshots = true;
  private closed = false;

  constructor(private readonly pool: Pool) {}

  async transaction<T>(kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('the PostgreSQL query database is closed');
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      const begin = kind === 'snapshot'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL READ COMMITTED';
      await client.query(begin);
      const executor: SqlExecutor = {
        query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
          const result = await client.query(sql, [...values]);
          return { rows: result.rows as Row[] };
        },
      };
      const value = await work(executor);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

/** Opens the shared PostgreSQL query database used by a server process. */
export async function createPostgresQueryDatabase(options: PostgresQueryDatabaseOptions): Promise<AsyncQueryDatabase> {
  const { clock, ...poolOptions } = options;
  const { Pool } = await import('pg');
  const pool = new Pool(poolOptions);
  return createSqlQueryDatabase(new PostgresQueryDriver(pool), { clock });
}
