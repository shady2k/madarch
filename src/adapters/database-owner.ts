/**
 * One database owner per process: the single PostgreSQL-compatible database
 * connection (PGlite in-process, or a `pg` pool on a server) that the fact
 * log, the query projection and the future queue tables share
 * (decision 0027, "Storage ownership"). Before this module the history
 * adapter and the query adapter each opened a database of their own, so a
 * write of both in one transaction — a unit's publication — was impossible.
 *
 * An owner is created once and lent: the history store and the query
 * database both take one and never close it, because the caller that made
 * it closes it. Work reaches the database in exactly two shapes:
 *
 * - `transaction(kind, work)` runs `work` inside one transaction and
 *   commits it, or rolls it back when `work` throws. The `OuterTransaction`
 *   it hands to `work` can be passed on to any operation of either
 *   adapter, which then makes all of its statements inside it: that is how
 *   a history write and a projection update land together or not at all.
 * - `run(work)` runs `work` with no transaction boundary of its own, for a
 *   single statement or for a caller that already holds a `transaction`.
 *
 * PGlite serves one connection per database, so its owner serializes every
 * transaction and every bare run, first come first served: no statement of
 * one operation can ever land inside another's transaction. A PostgreSQL
 * pool serves one connection per transaction, so its snapshots and writes
 * may overlap (see `allowConcurrentSnapshots`), exactly as the query
 * database's admission gate expects.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Pool, PoolConfig } from 'pg';
import type { OuterTransaction } from '../history/types.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../query/sql-driver.js';

export type { OuterTransaction };

/**
 * The database one process owns, opened once and lent to every adapter that
 * keeps data in it.
 */
export interface DatabaseOwner {
  /**
   * Where the database is, for error messages: a PGlite data directory
   * (`:memory:` when it holds nothing) or a PostgreSQL `host:port/database`
   * description that never carries credentials.
   */
  readonly location: string;
  /** Resolves once the database accepts statements; rejects with the reason it could not open. */
  readonly ready: Promise<void>;
  /** True when independent snapshots may run on separate connections at once; false when the owner has one connection and serializes everything. */
  readonly allowConcurrentSnapshots: boolean;
  /**
   * Whether the database hands the pgvector extension to its statements: a
   * PGlite owner answers whether it was opened with `vector: true`; a
   * PostgreSQL owner answers true, because the extension is a property of the
   * server's database and is reported when the projection's schema creates
   * it. The query database refuses a PGlite owner opened without it instead
   * of failing later inside `CREATE EXTENSION` with the engine's own message.
   */
  readonly hasVector: boolean;
  /**
   * Runs `work` in one transaction of this owner: committed when it
   * resolves, rolled back when it throws, and refused when a statement
   * inside `work` failed and its failure was swallowed — a database answers
   * `COMMIT` of such a transaction with a rollback, so resolving there would
   * report work as kept that was thrown away. The transaction is handed to
   * `work` and may be passed to any operation of an adapter lent this owner,
   * which then runs its own statements inside it.
   */
  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T>;
  /**
   * Runs `work` on the database with no transaction boundary of its own, for
   * a single statement. Serialized with every transaction of this owner, so
   * a bare statement never lands inside another operation's transaction.
   */
  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T>;
  /** Waits for queued work, refuses new work and releases the database once. */
  close(): Promise<void>;
}

export interface PGliteDatabaseOwnerOptions {
  /**
   * The PGlite data directory; omitted for a private in-memory database.
   * Keep persistent paths in product-local state outside the product
   * repository.
   */
  path?: string;
  /**
   * Loads pgvector. The graph-query projection needs it (its vector index
   * and its schema check); a history-only owner does not.
   */
  vector?: boolean;
}

/**
 * Refuses a transaction that a failed statement inside its own work has
 * aborted. PGlite and PostgreSQL both answer `COMMIT` of an aborted
 * transaction by rolling it back, so work that swallowed a failed statement
 * and then resolved would otherwise be reported as committed while every row
 * of it was thrown away — the silent loss decision 0027's publication cannot
 * afford. The probe is one statement inside the transaction: on a healthy one
 * it succeeds, and on an aborted one the database itself refuses it. It runs
 * for a write transaction only: a read-only transaction that aborted commits
 * nothing, so nothing can be lost there, and probing every read would spend a
 * statement of the projection's snapshots for no protection.
 */
async function refuseAborted(transaction: OuterTransaction, location: string): Promise<void> {
  try {
    await transaction.query('SELECT 1');
  } catch (error) {
    throw new Error(`the transaction of the database owner "${location}" was aborted by a failed statement and cannot be committed, so it was rolled back and nothing it wrote was kept: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

class PGliteOwner implements DatabaseOwner {
  readonly allowConcurrentSnapshots = false;
  readonly hasVector: boolean;
  readonly location: string;
  readonly ready: Promise<void>;
  private readonly database: PGlite;
  /** True while this owner's own transaction or bare run holds the connection. */
  private readonly ownWork = new AsyncLocalStorage<true>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: PGliteDatabaseOwnerOptions) {
    this.location = options.path ?? ':memory:';
    this.hasVector = options.vector === true;
    const extensions = options.vector === true ? { extensions: { vector } } : {};
    this.database = options.path === undefined ? new PGlite(extensions) : new PGlite(options.path, extensions);
    this.ready = this.database.waitReady;
    // A caller observes a failed open on its own first use of the owner; a
    // handler attached here keeps the constructor from becoming an
    // unhandled rejection while that use has not happened yet.
    void this.ready.catch(() => {});
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error(`the database owner "${this.location}" is closed`));
    if (this.ownWork.getStore() === true) {
      return Promise.reject(new Error(`the database owner "${this.location}" was called from inside its own transaction; pass that transaction to the operation instead of opening another, or the call would wait on the transaction that is waiting on it`));
    }
    const result = this.tail.then(async () => {
      await this.ready;
      return await this.ownWork.run(true, work);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T> {
    // PGlite has one connection, so a snapshot and a write are the same
    // transaction here: one at a time, serialized by the owner's own queue
    // rather than by an isolation level.
    return this.serialize(() => this.database.transaction(async (transaction) => {
      // PGlite's single connection makes a snapshot and a write the same
      // shape of transaction, so a snapshot is declared read-only here to
      // mean what PostgreSQL's `BEGIN … READ ONLY` means: a write inside it
      // fails loudly instead of landing in a transaction this owner never
      // probes. It is the first statement, as PostgreSQL requires.
      if (kind === 'snapshot') await transaction.query('SET TRANSACTION READ ONLY');
      const value = await work(transaction);
      if (kind === 'write') await refuseAborted(transaction, this.location);
      return value;
    }));
  }

  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    return this.serialize(() => work(this.database));
  }

  close(): Promise<void> {
    // The guard stands before the "already closing" short-circuit: a close
    // issued from inside this owner's own transaction would wait on it even
    // when another caller had already begun closing.
    if (this.ownWork.getStore() === true) {
      return Promise.reject(new Error(`the database owner "${this.location}" was closed from inside its own transaction, which could only wait on that transaction; close it after the transaction has committed or rolled back`));
    }
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await this.ready;
      } catch {
        // A failed open reports itself on the operations that asked; close
        // still releases PGlite.
      }
      await this.database.close();
    });
    this.tail = this.closePromise.then(() => undefined, () => undefined);
    return this.closePromise;
  }
}

/** Opens the process's PGlite database once; every adapter lent it shares this one connection. */
export function createPGliteDatabaseOwner(options: PGliteDatabaseOwnerOptions = {}): DatabaseOwner {
  return new PGliteOwner(options);
}

/**
 * A PostgreSQL `host:port/database` description for error messages, built
 * from the pool configuration with every credential left out.
 */
function postgresLocation(options: PoolConfig): string {
  if (typeof options.connectionString === 'string' && options.connectionString.length > 0) {
    try {
      const url = new URL(options.connectionString);
      const port = url.port === '' ? '' : `:${url.port}`;
      const database = url.pathname === '' ? '' : url.pathname;
      return `postgres://${url.hostname}${port}${database}`;
    } catch {
      return 'the PostgreSQL database the connection string names';
    }
  }
  const host = typeof options.host === 'string' ? options.host : 'localhost';
  const port = options.port ?? 5432;
  const database = options.database ?? options.user ?? 'postgres';
  return `postgres://${host}:${port}/${database}`;
}

class PostgresOwner implements DatabaseOwner {
  readonly allowConcurrentSnapshots = true;
  readonly hasVector = true;
  readonly location: string;
  readonly ready: Promise<void>;
  /** True while this owner's own transaction or bare run holds its client. */
  private readonly ownWork = new AsyncLocalStorage<true>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly pool: Pool, options: PoolConfig) {
    this.location = postgresLocation(options);
    this.ready = this.pool.query('SELECT 1').then(() => undefined);
    // As for PGlite: the caller that opened the owner observes a failure;
    // this handler only keeps it from becoming an unhandled rejection first.
    void this.ready.catch(() => {});
  }

  private ensureOpen(): void {
    if (this.closing) throw new Error(`the database owner "${this.location}" is closed`);
  }

  /**
   * Refuses work that would run outside the transaction that is already
   * running: the pool would hand it another client, so its statements would
   * commit separately and it would not see the caller's uncommitted rows — or
   * it would wait for a connection the transaction itself holds.
   */
  private ensureOutsideOwnWork(): void {
    if (this.ownWork.getStore() === true) {
      throw new Error(`the database owner "${this.location}" was called from inside its own transaction; pass that transaction to the operation instead of opening another, or its statements would run outside it and commit separately`);
    }
  }

  async transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T> {
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    await this.ready;
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      const begin = kind === 'snapshot'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL READ COMMITTED';
      await client.query(begin);
      const value = await this.ownWork.run(true, () => work(client));
      if (kind === 'write') await refuseAborted(client, this.location);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(errorMessage(rollbackError));
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    await this.ready;
    const executor: OuterTransaction = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = values === undefined ? await this.pool.query(sql) : await this.pool.query(sql, [...values]);
        return { rows: result.rows as Row[] };
      },
    };
    return await this.ownWork.run(true, () => work(executor));
  }

  close(): Promise<void> {
    // Before the "already closing" short-circuit: pool.end() waits for the
    // client this owner's own transaction holds.
    this.ensureOutsideOwnWork();
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.pool.end();
    return this.closePromise;
  }
}

/** Opens the process's PostgreSQL pool once; every adapter lent it shares this pool. */
export async function createPostgresDatabaseOwner(options: PoolConfig): Promise<DatabaseOwner> {
  const { Pool } = await import('pg');
  const pool = new Pool(options);
  return new PostgresOwner(pool, options);
}

/**
 * The query database's view of an owner: `SqlQueryDriver` is the query
 * layer's transaction port, and this adapter gives it the owner's
 * transactions. `closesOwner` is true only for the adapter that created
 * the owner; a lent owner stays open when the query database closes.
 */
export function ownerQueryDriver(owner: DatabaseOwner, options: { closesOwner: boolean }): SqlQueryDriver {
  return {
    allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    transaction: <T>(kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      owner.transaction(kind, async (transaction) => await work(transaction)),
    close: async (): Promise<void> => {
      if (options.closesOwner) await owner.close();
    },
  };
}
