/**
 * A PGlite instance behind the fill state store's narrow database interface.
 *
 * Temporary by design: madarch-tzte.19.1's process database owner lends the one
 * database of the process to the history store, the query database and these
 * tables, and madarch-tzte.19.5 switches `state-store.ts` to it. Until then this
 * adapter is how the store's tests (and only the tests) get a real database.
 */
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { FillStateDatabase } from '../src/fill/state-store.js';
import type { SqlExecutor } from '../src/query/sql-driver.js';

export interface TestFillStateDatabase extends FillStateDatabase {
  /** The data directory the instance opened, or null for an in-memory one. */
  readonly path: string | null;
  close(): Promise<void>;
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

/** Opens one PGlite instance, in memory unless `path` names a data directory. */
export async function openFillStateDatabase(path?: string): Promise<TestFillStateDatabase> {
  const database = path === undefined ? new PGlite() : new PGlite(path);
  await database.waitReady;
  let closed = false;
  const root = serialExecutor(database);
  return {
    path: path ?? null,
    async transaction<T>(kind: 'snapshot' | 'write', work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      if (closed) throw new Error('test/fill-fsm-pglite.ts: the PGlite instance is closed');
      if (kind === 'snapshot') return work(root);
      return database.transaction(async (transaction) => work(serialExecutor(transaction)));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await database.close();
    },
  };
}
