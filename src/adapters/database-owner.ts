/**
 * One database owner per process: the single PostgreSQL database the fact log,
 * the query projection, the graph store and the queue's tables share
 * (decision 0027, "Storage ownership"). Before this module the history adapter
 * and the query adapter each opened a database of their own, so a write of both
 * in one transaction — a unit's publication — was impossible.
 *
 * An owner is created once and lent: the history store and the query database
 * both take one and never close it, because the caller that made it closes it.
 * Work reaches the database in exactly two shapes:
 *
 * - `transaction(kind, work)` runs `work` inside one transaction and commits it,
 *   or rolls it back when `work` throws. The `OuterTransaction` it hands to
 *   `work` can be passed on to any operation of either adapter, which then makes
 *   all of its statements inside it: that is how a history write and a
 *   projection update land together or not at all.
 * - `run(work)` runs `work` with no transaction boundary of its own, for a
 *   single statement or for a caller that already holds a `transaction`.
 *
 * The database is a server's (madarch-8bdc.2.5, item 3). A store's cluster
 * lives in `<store>/pgdata` and listens on a socket folder of its own in the system temporary folder; the processes of
 * the binary share it by holding its two locks (`postgres-cluster.ts`), so one of them starts it and the last one
 * stops it, in whatever roles they run. One pool connection per transaction lets snapshots and writes overlap, which is
 * what the query database's admission gate expects.
 *
 * The client is `pg`, pinned exactly: it sends a bound value as text and lets
 * the server read it through the statement's own cast, which is what the store's
 * SQL is written for.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { types } from 'pg';
import { withSpan } from '../obs/trace.js';
import type { Pool, PoolConfig } from 'pg';
import type { OuterTransaction } from '../history-types.js';
import type { SqlExecutor, SqlQueryDriver, SqlTransactionKind } from '../sql-driver.js';
import { clusterPaths, clusterQuery, openCluster, CLUSTER_ADMIN_DATABASE, CLUSTER_PORT, CLUSTER_USER, type RunningCluster } from './postgres-cluster.js';

export type { OuterTransaction };

/**
 * A `bigint` column read as a number. The store's bigint columns are epoch
 * milliseconds, row counts and digests of small integers, all far inside the
 * 2^53 a JavaScript number holds exactly, and every reader of them (a span
 * record's times, a unit's retries, a draft's moment) adds and compares numbers:
 * `pg` answers `int8` as a string by default, which turned a stored moment into
 * `"1700000000000"` the moment the store moved to a server. The cast is on the
 * client, once, so no reader carries it.
 */
types.setTypeParser(20, (value: string) => Number(value));

/** The database a store's cluster holds by default: one store, one database of its own. */
const STORE_DATABASE = 'madarch';

/**
 * What one statement is, for the trace: its verb, the relation it names and a
 * name a reader can follow. A span records none of the values a statement was
 * given — the name is the shape of the statement, never its data.
 */
function statementOf(sql: string): { operation: string; table: string; name: string } {
  const operation = (/^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/u.exec(sql)?.[1] ?? 'SQL').toUpperCase();
  const table = /(?:\bFROM|\bINTO|\bUPDATE|\bTABLE|\bJOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)/iu.exec(sql)?.[1] ?? '';
  return { operation, table, name: `${operation}${table === '' ? '' : ` ${table}`}` };
}

/** Runs one statement inside its own span: the operation, the rows it answered, its duration; never its values. */
async function spannedStatement<T extends { readonly rows: readonly unknown[] }>(
  sql: string,
  values: readonly unknown[] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const held = statementOf(sql);
  return await withSpan(`db.${held.operation}`, {
    'db.system': 'postgres',
    'db.operation': held.operation,
    'db.table': held.table,
    'db.name': held.name,
    'db.params': values?.length ?? 0,
  }, async (span) => {
    const answer = await run();
    span.setAttribute('db.rows', answer.rows.length);
    return answer;
  });
}

/**
 * The database one process owns, opened once and lent to every adapter that
 * keeps data in it.
 */
export interface DatabaseOwner {
  /** Where the database is, for error messages: a PostgreSQL `host:port/database` description that never carries credentials. */
  readonly location: string;
  /** Resolves once the database accepts statements; rejects with the reason it could not open. */
  readonly ready: Promise<void>;
  /** True when independent snapshots may run on separate connections at once; false when the owner has one connection and serializes everything. */
  readonly allowConcurrentSnapshots: boolean;
  /**
   * Whether the database hands pgvector to its statements. The server madarch
   * installs (the pinned `18.6.1` build) carries PostgreSQL's own contrib
   * extensions and no pgvector, so a store's owner answers false and the query
   * database refuses it by name instead of failing inside `CREATE EXTENSION`;
   * an owner on a server a caller names by connection string answers true.
   */
  readonly hasVector: boolean;
  /**
   * Runs `work` in one transaction of this owner: committed when it resolves,
   * rolled back when it throws, and refused when a statement inside `work`
   * failed and its failure was swallowed — a database answers `COMMIT` of such
   * a transaction with a rollback, so resolving there would report work as kept
   * that was thrown away. The transaction is handed to `work` and may be passed
   * to any operation of an adapter lent this owner, which then runs its own
   * statements inside it.
   */
  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T>;
  /**
   * Runs `work` on the database with no transaction boundary of its own, for a
   * single statement.
   */
  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T>;
  /**
   * Runs a text of statements that carries no parameters — the `BEGIN …; …
   * COMMIT;` block and the schema creation a library sends as one message — as
   * one message to one connection, and answers one result per statement in the
   * order the text writes them. The extended protocol `query` speaks takes
   * exactly one statement, so the queue's schema creation and its migrations
   * have nowhere else to run.
   */
  exec<Row extends object = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }[]>;
  /**
   * Stops accepting work, releases the pool and gives up this owner's hold of the store's server: the server stops only
   * when no process of the binary uses it any more, and keeps answering for the ones that do.
   */
  close(): Promise<void>;
}

/**
 * Refuses a transaction that a failed statement inside its own work has
 * aborted. PostgreSQL answers `COMMIT` of an aborted transaction by rolling it
 * back, so work that swallowed a failed statement and then resolved would
 * otherwise be reported as committed while every row of it was thrown away —
 * the silent loss decision 0027's publication cannot afford. The probe is one
 * statement inside the transaction: on a healthy one it succeeds, and on an
 * aborted one the database itself refuses it. It runs for a write transaction
 * only: a read-only transaction that aborted commits nothing, so nothing can be
 * lost there, and probing every read would spend a statement of the projection's
 * snapshots for no protection.
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

/**
 * A PostgreSQL `host:port/database` description for error messages, built from
 * the pool configuration with every credential left out.
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
  readonly hasVector: boolean;
  readonly location: string;
  readonly ready: Promise<void>;
  /** True while this owner's own transaction or bare run holds its client. */
  private readonly ownWork = new AsyncLocalStorage<true>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly pool: Pool, options: PoolConfig, hasVector = true) {
    this.location = postgresLocation(options);
    this.hasVector = hasVector;
    this.ready = this.pool.query('SELECT 1').then(() => undefined);
    // The caller that opened the owner observes a failure; this handler only
    // keeps it from becoming an unhandled rejection before that use happens.
    void this.ready.catch(() => {});
  }

  private ensureOpen(): void {
    if (this.closing) throw new Error(`the database owner "${this.location}" is closed`);
  }

  /**
   * Refuses work that would run outside the transaction that is already
   * running: the pool would hand it another client, so its statements would
   * commit separately and it would not see the caller's uncommitted rows — or it
   * would wait for a connection the transaction itself holds.
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
      const value = await withSpan('db.transaction', { 'db.system': 'postgres', 'db.kind': kind }, async (span) => {
        let statements = 0;
        let rows = 0;
        const counted: OuterTransaction = {
          query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            statements += 1;
            const answer = (await spannedStatement(sql, values, async () => await client.query(sql, values === undefined ? undefined : [...values]) as { rows: unknown[] })) as { rows: Row[] };
            rows += answer.rows.length;
            return answer;
          },
        };
        const held = await this.ownWork.run(true, () => work(counted));
        if (kind === 'write') await refuseAborted(client, this.location);
        await client.query('COMMIT');
        span.setAttribute('db.statements', statements);
        span.setAttribute('db.rows', rows);
        return held;
      });
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
        const result = await spannedStatement(sql, values, async () => values === undefined ? await this.pool.query(sql) : await this.pool.query(sql, [...values]));
        return { rows: result.rows as Row[] };
      },
    };
    return await withSpan('db.run', { 'db.system': 'postgres' }, async () => await this.ownWork.run(true, () => work(executor)));
  }

  async exec<Row extends object>(text: string): Promise<{ rows: Row[] }[]> {
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    await this.ready;
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      // One client for the whole text: `pg` sends a statement text with no
      // values through the simple protocol, so a `BEGIN … COMMIT` block is one
      // message on one connection and answers one result per statement.
      return await withSpan('db.batch', { 'db.system': 'postgres' }, async (span) => {
        const result = await client.query(text);
        const results = Array.isArray(result) ? result : [result];
        const answered = results.map((one) => ({ rows: one.rows as Row[] }));
        span.setAttribute('db.rows', answered.reduce((sum, one) => sum + one.rows.length, 0));
        return answered;
      });
    } catch (error) {
      try {
        // The failed statement left this client's transaction open (or
        // aborted); returning it to the pool without rolling back would hand the
        // next caller a connection inside someone else's transaction.
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(errorMessage(rollbackError));
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
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

/** A cluster another part of the run already started, which an owner only connects to. */
export interface DatabaseClusterRef {
  readonly socketDir: string;
  readonly port?: number;
  readonly user?: string;
  /** The folder the server's programs are in, for the copy and the database creation. */
  readonly bin?: string;
}

export interface DatabaseOwnerOptions {
  /**
   * The store whose database this is: its cluster is `<store>/pgdata`, its
   * socket folder a private one under the system temporary folder, and the database `madarch` unless
   * `database` names another.
   */
  readonly store?: string;
  /** The database inside the cluster: `madarch` unless a caller keeps its own (a snapshot, a source's history). */
  readonly database?: string;
  /** A server another process runs: the owner connects and never starts or stops it. */
  readonly cluster?: DatabaseClusterRef;
  /** Loads `btree_gist`, which the temporal graph's no-overlap constraints need (decision 0028). */
  readonly btreeGist?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

/**
 * The owner that holds its server: the pool and, when this owner opened the
 * cluster, the server itself, which stops with it.
 */
class ServerStoreOwner implements DatabaseOwner {
  readonly location: string;
  readonly ready: Promise<void>;
  readonly allowConcurrentSnapshots = true;
  readonly hasVector = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly inner: DatabaseOwner,
    private readonly release: () => Promise<void>,
  ) {
    this.location = inner.location;
    this.ready = inner.ready;
  }

  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T> {
    return this.inner.transaction<T>(kind, work);
  }

  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    return this.inner.run(work);
  }

  exec<Row extends object = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }[]> {
    return this.inner.exec<Row>(text);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const work = (async () => {
      // The server is given up only when the pool really closed: a close the
      // owner refused (one called from inside the owner's own transaction)
      // leaves the pool and its connections in use, and a process that still
      // holds connections is a process that still uses the server — giving the
      // hold up here would let another process stop the server under it.
      await this.inner.close();
      await this.release();
    })();
    // A close the owner refused closed nothing: the next close asks again rather
    // than handing back the same rejection, and this handler keeps the refused
    // promise from becoming an unhandled one of its own.
    work.catch(() => { this.closePromise = undefined; });
    this.closePromise = work;
    return work;
  }
}

/** A database name as SQL spells it: the names madarch makes are plain, but a caller may name its own. */
function quoted(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/** Makes the database when the cluster holds none of that name. */
async function ensureDatabase(cluster: RunningCluster, database: string): Promise<void> {
  const held = await clusterQuery(cluster, CLUSTER_ADMIN_DATABASE, 'SELECT 1 AS held FROM pg_database WHERE datname = $1', [database]);
  if (held.length === 1) return;
  try {
    await clusterQuery(cluster, CLUSTER_ADMIN_DATABASE, `CREATE DATABASE ${quoted(database)}`);
  } catch (error) {
    // Two processes opening one store's owner at the same moment both ask for the database: the one that lost reads it again.
    const again = await clusterQuery(cluster, CLUSTER_ADMIN_DATABASE, 'SELECT 1 AS held FROM pg_database WHERE datname = $1', [database]);
    if (again.length !== 1) throw error;
  }
}

/**
 * The folders an older madarch kept its in-process database in, under a store:
 * `<store>/graph` for a knowledge or graph store and `<store>/state.db` for the
 * fill's. Nothing reads them any more and nothing migrates them, so a store that
 * holds one and no data directory is refused with what to do: the fill runs
 * again, into a fresh store.
 */
const LEGACY_DATABASE_FOLDERS = ['graph', 'state.db'] as const;

/** Why a store folder cannot be opened as a store of this build, or undefined when it can. */
function legacyStoreProblem(store: string): string | undefined {
  if (existsSync(join(store, 'pgdata'))) return undefined;
  const held = LEGACY_DATABASE_FOLDERS.filter((name) => {
    try {
      return statSync(join(store, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (held.length === 0) return undefined;
  const folders = held.map((name) => join(store, name)).join(' and ');
  return `the store "${store}" holds ${folders}, a database of an older madarch kept as files in the store itself: this build runs a PostgreSQL server and reads no such files, and nothing migrates them. Run the fill again into a store of this build, or remove ${folders} first (src/adapters/database-owner.ts)`;
}

/**
 * Opens a database on a cluster: the store's own (`<store>/pgdata`) with the
 * server started when nothing answers on its socket, a cluster a caller names,
 * or — with neither — a private cluster in the temporary folder that is removed
 * with the owner, which is what a temporary projection or a rendering wants.
 */
export async function createDatabaseOwner(options: DatabaseOwnerOptions = {}): Promise<DatabaseOwner> {
  const env = options.env ?? process.env;
  const log = options.log;
  const database = options.database ?? STORE_DATABASE;
  let cluster: RunningCluster;
  let release: () => Promise<void> = async () => await Promise.resolve();
  if (options.store !== undefined && options.cluster !== undefined) {
    throw new Error(`the database owner cannot be given both a store and a running cluster: "${options.store}" names the cluster it should open, so the cluster beside it could only be silently ignored (src/adapters/database-owner.ts)`);
  }
  if (options.store !== undefined) {
    const legacy = legacyStoreProblem(options.store);
    if (legacy !== undefined) throw new Error(legacy);
    const paths = clusterPaths(options.store);
    cluster = await openCluster({ ...paths, ...(log === undefined ? {} : { log }), env });
    const opened = cluster;
    // The server is given up with the last owner of it: another process of the binary may still read it.
    release = async () => { await opened.stop(); };
  } else if (options.cluster !== undefined) {
    cluster = {
      dataDir: options.cluster.socketDir,
      socketDir: options.cluster.socketDir,
      port: options.cluster.port ?? CLUSTER_PORT,
      user: options.cluster.user ?? CLUSTER_USER,
      bin: options.cluster.bin ?? '',
      stop: async () => await Promise.resolve(),
    };
  } else {
    const root = mkdtempSync(join(tmpdir(), 'madarch-postgres-'));
    const paths = clusterPaths(root);
    cluster = await openCluster({ ...paths, ...(log === undefined ? {} : { log }), env });
    const opened = cluster;
    release = async () => {
      await opened.stop();
      rmSync(root, { recursive: true, force: true });
    };
  }
  try {
    await ensureDatabase(cluster, database);
    if (options.btreeGist === true) {
      try {
        await clusterQuery(cluster, database, 'CREATE EXTENSION IF NOT EXISTS btree_gist');
      } catch (error) {
        // `CREATE EXTENSION IF NOT EXISTS` is not race-free: two processes opening one store at the same instant can
        // both create it, and one of them reads the other's row as a duplicate key. The extension standing is what was
        // asked for, so that answer is the success it is.
        const held = await clusterQuery(cluster, database, "SELECT 1 AS held FROM pg_extension WHERE extname = 'btree_gist'");
        if (held.length === 0) throw error;
      }
    }
    const inner = await createPostgresDatabaseOwner({ host: cluster.socketDir, port: cluster.port, database, user: cluster.user, max: 8 });
    await inner.ready;
    return new ServerStoreOwner(inner, release);
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

/** A store's server, held open for owners that attach to it: the lease stops the server if it started it. */
export interface ClusterLease {
  readonly ref: DatabaseClusterRef;
  close(): Promise<void>;
}

/**
 * Starts a store's cluster, or attaches to the one already answering, for a
 * caller that opens several databases on it — a server's data folder holds one
 * database per source's history — and gives that hold up when the caller is done: the cluster stops when no other
 * process uses it.
 */
export async function leaseStoreCluster(store: string, options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void } = {}): Promise<ClusterLease> {
  const cluster = await openCluster({ ...clusterPaths(store), ...(options.log === undefined ? {} : { log: options.log }), ...(options.env === undefined ? {} : { env: options.env }) });
  return {
    ref: { socketDir: cluster.socketDir, port: cluster.port, user: cluster.user, bin: cluster.bin },
    close: async () => { await cluster.stop(); },
  };
}

/**
 * Replaces `to`'s database with `from`'s, rows and schema, through the pinned
 * build's own `pg_dump` and `psql`: the graph store's tables and the fill's
 * bookkeeping move as one database, which is how the knowledge wiki makes a
 * snapshot for its reader and how an MCP start reuses a product's graph.
 *
 * Neither owner may be open on `to` when it runs: its database is dropped
 * first. The source's server is started when it does not answer, and both
 * servers are given up again before it answers — stopped when this call was
 * their last user, left answering for a process that still reads them otherwise.
 */
async function copyStore(options: { readonly from: string; readonly to: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void }): Promise<void> {
  const env = options.env ?? process.env;
  const source = await openCluster({ ...clusterPaths(options.from), ...(options.log === undefined ? {} : { log: options.log }), env });
  const target = await openCluster({ ...clusterPaths(options.to), ...(options.log === undefined ? {} : { log: options.log }), env });
  try {
    await clusterQuery(target, CLUSTER_ADMIN_DATABASE, `DROP DATABASE IF EXISTS ${quoted(STORE_DATABASE)}`);
    await clusterQuery(target, CLUSTER_ADMIN_DATABASE, `CREATE DATABASE ${quoted(STORE_DATABASE)}`);
    await dumpInto(source, target, STORE_DATABASE);
  } finally {
    await target.stop();
    await source.stop();
  }
}

/** Streams one database's dump into another's, both from the pinned build's programs. */
function dumpInto(source: RunningCluster, target: RunningCluster, database: string): Promise<void> {
  const bin = source.bin;
  return new Promise<void>((resolve, reject) => {
    const dump = spawn(join(bin, 'pg_dump'), ['-h', source.socketDir, '-p', String(source.port), '-U', source.user, '-d', database, '--no-owner', '--no-privileges', '--no-tablespaces'], { env: { ...process.env, LC_ALL: 'C' } });
    const restore = spawn(join(bin, 'psql'), ['-h', target.socketDir, '-p', String(target.port), '-U', target.user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-q'], { env: { ...process.env, LC_ALL: 'C' } });
    let said = '';
    const keep = (chunk: Buffer | string): void => { said = (said + String(chunk)).slice(-4_000); };
    dump.stderr.on('data', keep);
    restore.stderr.on('data', keep);
    let failed: string | undefined;
    dump.once('error', (error: Error) => { failed = `pg_dump could not run: ${error.message}`; });
    restore.once('error', (error: Error) => { failed = `psql could not run: ${error.message}`; });
    dump.stdout.pipe(restore.stdin);
    dump.once('close', (code) => { if (code !== 0) { failed ??= `pg_dump exited ${String(code)}`; restore.stdin.end(); } });
    restore.once('close', (code) => {
      if (code !== 0) failed ??= `psql exited ${String(code)}`;
      if (failed === undefined) resolve();
      else reject(new Error(`src/adapters/database-owner.ts:1: the database of ${source.socketDir} could not be copied into ${target.socketDir}: ${failed}${said === '' ? '' : `: ${said.trim()}`}`));
    });
  });
}

/** The database names a store's cluster holds, in code-point order, the templates left out. */
export async function clusterDatabases(cluster: DatabaseClusterRef): Promise<string[]> {
  const running: RunningCluster = {
    dataDir: cluster.socketDir,
    socketDir: cluster.socketDir,
    port: cluster.port ?? CLUSTER_PORT,
    user: cluster.user ?? CLUSTER_USER,
    bin: cluster.bin ?? '',
    stop: async () => await Promise.resolve(),
  };
  const rows = await clusterQuery<{ datname: string }>(running, CLUSTER_ADMIN_DATABASE, 'SELECT datname FROM pg_database ORDER BY 1');
  return rows.map((row) => row.datname).filter((name) => !name.startsWith('template'));
}

/** Renames one database of a cluster, in one statement; no other session may hold it open. */
export async function renameClusterDatabase(cluster: DatabaseClusterRef, from: string, to: string): Promise<void> {
  const running: RunningCluster = {
    dataDir: cluster.socketDir,
    socketDir: cluster.socketDir,
    port: cluster.port ?? CLUSTER_PORT,
    user: cluster.user ?? CLUSTER_USER,
    bin: cluster.bin ?? '',
    stop: async () => await Promise.resolve(),
  };
  await clusterQuery(running, CLUSTER_ADMIN_DATABASE, `ALTER DATABASE ${quoted(from)} RENAME TO ${quoted(to)}`);
}


/**
 * The query database's view of an owner: `SqlQueryDriver` is the query
 * layer's transaction port, and this adapter gives it the owner's
 * transactions. `closesOwner` is true only for the adapter that created
 * the owner; a lent owner stays open when the query database closes.
 */
function ownerQueryDriver(owner: DatabaseOwner, options: { closesOwner: boolean }): SqlQueryDriver {
  return {
    allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    transaction: <T>(kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T> =>
      owner.transaction(kind, async (transaction) => await work(transaction)),
    close: async (): Promise<void> => {
      if (options.closesOwner) await owner.close();
    },
  };
}
