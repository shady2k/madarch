import { startupBegin, startupPreparation } from '../obs/log.js';
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
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, types } from 'pg';
import { loadModule, scanSync } from 'libpg-query';
import { withSpan, withSpanSync } from '../obs/trace.js';
import { GRAPH_CHECK_STATS, GRAPH_CHECK_DIAGNOSTIC_SCHEMA } from './schemas/graph-definition.js';
import type { Pool, PoolConfig } from 'pg';
import type { OuterTransaction } from '../history-types.js';
import type { SqlExecutor, SqlTransactionKind } from '../sql-driver.js';
import { clusterEndpoint, clusterPaths, clusterQuery, openCluster, CLUSTER_ADMIN_DATABASE, CLUSTER_PORT, CLUSTER_USER, type RunningCluster } from './postgres-cluster.js';

export type { OuterTransaction };

const EXECUTOR_OWNER = new WeakMap<object, DatabaseOwner>();

/** The host owner of an executor; arbitrary query objects carry no write authority. */
export function databaseOwnerOf(executor: SqlExecutor): DatabaseOwner | undefined {
  return EXECUTOR_OWNER.get(executor);
}

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
  const operation = (sql.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/u)?.[1] ?? 'SQL').toUpperCase();
  const table = sql.match(/(?:\bFROM|\bINTO|\bUPDATE|\bTABLE|\bJOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)/iu)?.[1] ?? '';
  return { operation, table, name: `${operation}${table === '' ? '' : ` ${table}`}` };
}

/** The counts one transaction states of its statements, never one span per statement. */
interface StatementCounts {
  select: number;
  insert: number;
  update: number;
  delete: number;
  other: number;
  rows: number;
}

/** Runs one statement and counts it for the transaction's span: a span per statement made a fill's trace 157 MB. */
async function spannedStatement<T extends { readonly rows: readonly unknown[] }>(
  sql: string,
  run: () => Promise<T>,
  counts?: StatementCounts,
): Promise<T> {
  const held = statementOf(sql);
  // One span per statement: the client's send to its answer, the operation and the statement's own size (a statement's
  // text is never written to a trace — its parameters hold the data). The duration is server execution and the trip.
  const answer = await withSpan('db.statement', { 'db.system': 'postgres', 'db.operation': held.operation, 'db.sql.bytes': new TextEncoder().encode(sql).length }, async () => await run());
  if (counts !== undefined) {
    if (held.operation === 'SELECT') counts.select += 1;
    else if (held.operation === 'INSERT') counts.insert += 1;
    else if (held.operation === 'UPDATE') counts.update += 1;
    else if (held.operation === 'DELETE') counts.delete += 1;
    else counts.other += 1;
    counts.rows += answer.rows.length;
  }
  return answer;
}

/** Opt-in diagnostics: capture deferred function counters before COMMIT resets transaction statistics. */
const graphDiagnosticClients = new WeakSet<Client>();
type GraphCheckStats = Record<string, { calls: number; total_ms: number; self_ms: number }>;

async function prepareGraphDiagnostics(client: Client): Promise<void> {
  if (graphDiagnosticClients.has(client)) return;
  // Session-local objects, created outside the business transaction. The last queued row samples the graph's
  // completed deferred triggers while their transaction counters still exist; no graph constraint is fired early.
  await withSpan('db.diagnostic.setup', { 'db.system': 'postgres', 'db.diagnostic.statements': 3 }, async () => {
    await loadModule();
    await client.query(GRAPH_CHECK_DIAGNOSTIC_SCHEMA);
  });
  graphDiagnosticClients.add(client);
}

/** PostgreSQL's lexer recognizes comments and whitespace without a second SQL grammar. */
function setsConstraints(sql: string): boolean {
  try {
    const tokens = (scanSync(sql).tokens ?? []).filter(token => token.tokenName !== 'C_COMMENT' && token.tokenName !== 'SQL_COMMENT');
    return tokens[0]?.text.toUpperCase() === 'SET' && tokens[1]?.text.toUpperCase() === 'CONSTRAINTS';
  } catch { return false; } // Let PostgreSQL report malformed SQL through the normal statement path.
}

function graphCheckAttributes(before: GraphCheckStats, after: GraphCheckStats): Record<string, number> {
  const attributes: Record<string, number> = {};
  for (const name of ['graph_relations_check', 'graph_checks_pass']) {
    for (const field of ['calls', 'total_ms', 'self_ms'] as const) {
      attributes[`db.${name}.${field}`] = (after[name]?.[field] ?? 0) - (before[name]?.[field] ?? 0);
    }
  }
  return attributes;
}

/**
 * The database one process owns, opened once and lent to every adapter that
 * keeps data in it.
 */
export interface TransactionOptions {
  readonly signal?: AbortSignal;
}

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
  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
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
   * Registers work that runs when this owner closes, before its pool is given up:
   * an adapter that keeps background passes of its own on the owner's database —
   * the queue's supervision timer — stops them here, so nothing keeps asking a
   * database the process has closed (madarch-64o5.74). A failure of the work is
   * reported with the close once the pool is given up, never instead of it.
   * Returns an idempotent removal function for an adapter that stops before the owner.
   */
  onClose(work: () => Promise<void> | void): () => void;
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
    await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('SELECT 1') }, async (span) => {
      const answer = await transaction.query('SELECT 1');
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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

/** An owner called from inside its own transaction: nothing it was asked to close was closed. */
class OwnWorkError extends Error {}

class PostgresOwner implements DatabaseOwner {
  readonly allowConcurrentSnapshots = true;
  readonly hasVector: boolean;
  readonly location: string;
  readonly ready: Promise<void>;
  /** True while this owner's own transaction or bare run holds its client. */
  private readonly ownWork = new AsyncLocalStorage<true>();
  private closing = false;
  private closePromise: Promise<void> | undefined;
  /** Work a lent adapter stops with this owner, in registration order (`onClose`). */
  private readonly attached: (() => Promise<void> | void)[] = [];

  constructor(private readonly pool: Pool, private readonly options: PoolConfig, hasVector = true, store?: string) {
    this.location = store === undefined ? postgresLocation(options) : `${store} (${postgresLocation(options)})`;
    // pg removes failed idle clients before emitting this event. An unobserved event would crash the process.
    this.pool.on('error', (error) => console.error(`PostgreSQL pool "${this.location}": ${errorMessage(error)}`));
    this.pool.on('connect', (client) => {
      client.on('error', (error) => console.error(`PostgreSQL client "${this.location}": ${errorMessage(error)}`));
    });
    this.hasVector = hasVector;
    this.ready = this.named(async () => { await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('SELECT 1') }, async (span) => {
      const answer = await this.pool.query('SELECT 1');
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    }); });
    // The caller that opened the owner observes a failure; this handler only
    // keeps it from becoming an unhandled rejection before that use happens.
    void this.ready.catch(() => {});
  }

  /** Name database failures only; application callbacks must keep their own refusal message. */
  private async named<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      // Keep PostgreSQL codes and fields used by callers while naming the failed store.
      if (error instanceof Error) { error.message = `database owner "${this.location}": ${error.message}`; throw error; }
      throw new Error(`database owner "${this.location}": ${errorMessage(error)}`);
    }
  }

  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return this.transactionWork(kind, work, options.signal);
  }

  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    return this.runWork(work);
  }

  exec<Row extends object>(text: string): Promise<{ rows: Row[] }[]> {
    return this.execWork<Row>(text);
  }

  onClose(work: () => Promise<void> | void): () => void {
    this.attached.push(work);
    return () => {
      const index = this.attached.indexOf(work);
      if (index !== -1) this.attached.splice(index, 1);
    };
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
      throw new OwnWorkError(`the database owner "${this.location}" was called from inside its own transaction; pass that transaction to the operation instead of opening another, or its statements would run outside it and commit separately`);
    }
  }

  private async transactionWork<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    const client = await withSpan('db.connection.wait', { 'db.system': 'postgres' }, async () => {
      await this.ready;
      return await this.named(async () => await this.pool.connect());
    });
    let releaseError: Error | undefined;
    let activeStatement = false;
    let cancellation: Promise<void> | undefined;
    let cancel: (() => void) | undefined;
    const query = async <Row extends object = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }> => {
      signal?.throwIfAborted();
      activeStatement = true;
      try { return await this.named(async () => await client.query<Row>(parameters?.length ? queryConfig(client, sql, parameters) : sql)); }
      finally { activeStatement = false; }
    };
    try {
      signal?.throwIfAborted();
      if (signal !== undefined) {
        const pid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        cancel = () => {
          if (!activeStatement || cancellation !== undefined) return;
          cancellation = (async () => {
            const control = new Client(this.options);
            try {
              await control.connect();
              const answer = await control.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [pid]);
              if (answer.rows[0]?.cancelled !== true) throw new Error(`${import.meta.path}:300: PostgreSQL refused cancellation of this transaction`);
            } finally { await control.end(); }
          })();
          // The transaction observes this failure after its work drains.
          void cancellation.catch(() => undefined);
        };
        signal.addEventListener('abort', cancel, { once: true });
        signal.throwIfAborted();
      }
      const graphDiagnostics = kind === 'write' && process.env['MADARCH_TRACE_GRAPH_CHECKS'] === '1';
      if (graphDiagnostics) await this.named(async () => await prepareGraphDiagnostics(client));
      const begin = kind === 'snapshot'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL READ COMMITTED';
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength(begin) }, async (span) => {
        const answer = await query(begin);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      const value = await withSpan('db.transaction', { 'db.system': 'postgres', 'db.kind': kind }, async (span) => {
        let diagnosticStatements = 0;
        const readGraphStats = async (): Promise<GraphCheckStats> => {
          diagnosticStatements += 1;
          return (await query<{ stats: GraphCheckStats }>(GRAPH_CHECK_STATS)).rows[0]!.stats;
        };
        if (graphDiagnostics) {
          diagnosticStatements += 1;
          await query("SET LOCAL track_functions = 'pl'");
          diagnosticStatements += 1;
          await query('DELETE FROM pg_temp.madarch_graph_check_trace');
        }
        let statements = 0;
        let rows = 0;
        const counts: StatementCounts = { select: 0, insert: 0, update: 0, delete: 0, other: 0, rows: 0 };
        let tail: Promise<void> = Promise.resolve();
        let accepting = true;
        const committed: (() => void)[] = [];
        const counted: OuterTransaction = {
          afterCommit: work => { committed.push(work); },
          query: <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            if (!accepting) return Promise.reject(new Error(`the database owner "${this.location}" transaction has ended`));
            if (signal?.aborted === true) return Promise.reject(signal.reason);
            const parameters = values === undefined ? undefined : [...values];
            const answer = tail.then(async () => {
              signal?.throwIfAborted();
              statements += 1;
              const result = graphDiagnostics && setsConstraints(sql)
                ? await withSpan('db.constraints', { 'db.system': 'postgres' }, async (constraintSpan) => {
                  const before = await readGraphStats();
                  try { return await spannedStatement(sql, async () => await query<Row>(sql, parameters), counts); }
                  finally {
                    // A refused constraint aborts the transaction; its counters cannot then be queried.
                    // Keep the original failure rather than replacing it with the diagnostic query's failure.
                    try { constraintSpan.setAttributes(graphCheckAttributes(before, await readGraphStats())); }
                    catch (error) { constraintSpan.recordException(error instanceof Error ? error : new Error(errorMessage(error))); }
                  }
                })
                : await spannedStatement(sql, async () => await query<Row>(sql, parameters), counts);
              rows += result.rows.length;
              return result;
            });
            tail = answer.then(() => undefined, () => undefined);
            return answer;
          },
        };
        EXECUTOR_OWNER.set(counted, this);
        let held: T;
        try {
          held = await this.ownWork.run(true, () => work(counted));
        } finally {
          accepting = false;
          await tail;
        }
        signal?.throwIfAborted();
        if (kind === 'write') await refuseAborted({ query }, this.location);
        signal?.throwIfAborted();
        const preparation = kind === 'write' ? startupPreparation() : undefined;
        const commitTrace = preparation === undefined ? undefined : startupBegin('schema.commit', preparation);
        const commit = async (): Promise<void> => {
          try {
            const result = await this.named(async () => await client.query('COMMIT'));
            commitTrace?.(result.command === 'COMMIT' ? 'acknowledged' : 'unknown');
          } catch (error) {
            const response = (typeof error === 'object' && error !== null ? error : {}) as { severity?: string; code?: string };
            const rejected = response.severity === 'ERROR' && typeof response.code === 'string' && response.code !== '40003' && !response.code.startsWith('08');
            commitTrace?.(rejected ? 'error' : 'unknown');
            throw error;
          }
        };
        // COMMIT dispatch is the boundary: after it the server may already have kept the write.
        if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
        await withSpan('db.commit', { 'db.system': 'postgres' }, async (commitSpan) => {
          if (!graphDiagnostics) { await commit(); return; }
          const before = await readGraphStats();
          // Last INSERT means the diagnostic trigger follows all graph events already queued by the work.
          diagnosticStatements += 1;
          await query('INSERT INTO pg_temp.madarch_graph_check_trace VALUES (NULL)');
          await commit();
          diagnosticStatements += 1;
          try {
            const measured = (await client.query<{ stats: GraphCheckStats }>('SELECT stats FROM pg_temp.madarch_graph_check_trace')).rows[0]?.stats;
            if (measured === undefined || measured === null) throw new Error('PostgreSQL did not report deferred graph check diagnostics');
            commitSpan.setAttributes(graphCheckAttributes(before, measured));
          } catch (error) {
            // COMMIT already kept the work: missing evidence must not suppress publication callbacks or report rollback.
            commitSpan.recordException(error instanceof Error ? error : new Error(errorMessage(error)));
          }
        });
        for (const publish of committed) {
          try { publish(); } catch (error) { span.recordException(error instanceof Error ? error : new Error(errorMessage(error))); }
        }
        span.setAttribute('db.statements', statements);
        if (graphDiagnostics) span.setAttribute('db.diagnostic.statements', diagnosticStatements);
        span.setAttribute('db.rows', rows);
        span.setAttribute('db.selects', counts.select);
        span.setAttribute('db.inserts', counts.insert);
        span.setAttribute('db.updates', counts.update);
        span.setAttribute('db.deletes', counts.delete);
        span.setAttribute('db.other', counts.other);
        return held;
      });
      return value;
    } catch (error) {
      const preparation = kind === 'write' ? startupPreparation() : undefined;
      const rolledBack = preparation === undefined ? undefined : startupBegin('schema.rollback', preparation);
      // A late cancellation must never reach ROLLBACK or a subsequent pool borrower.
      if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
      if (cancellation !== undefined) {
        try { await cancellation; }
        catch (cancelError) { releaseError = cancelError instanceof Error ? cancelError : new Error(errorMessage(cancelError)); }
      }
      try {
        await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('ROLLBACK') }, async (span) => {
          const answer = await client.query('ROLLBACK');
          rolledBack?.(answer.command === 'ROLLBACK' ? 'acknowledged' : 'unknown');
          span.setAttribute('db.rows', answer.rows.length);
          return answer;
        });
      } catch (rollbackError) {
        rolledBack?.('unknown');
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(errorMessage(rollbackError));
      }
      throw signal?.aborted === true ? signal.reason : error;
    } finally {
      if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
      if (cancellation !== undefined) {
        try { await cancellation; }
        catch (cancelError) { releaseError ??= cancelError instanceof Error ? cancelError : new Error(errorMessage(cancelError)); }
      }
      client.release(releaseError);
    }
  }

  private async runWork<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    await this.ready;
    const executor: OuterTransaction = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await spannedStatement(sql, async () => await this.named(async () => {
          const client = await this.pool.connect();
          try { return await client.query(values?.length ? queryConfig(client, sql, values) : sql); }
          finally { client.release(); }
        }));
        return { rows: result.rows as Row[] };
      },
    };
    EXECUTOR_OWNER.set(executor, this);
    return await withSpan('db.run', { 'db.system': 'postgres' }, async () => await this.ownWork.run(true, () => work(executor)));
  }

  private async execWork<Row extends object>(text: string): Promise<{ rows: Row[] }[]> {
    this.ensureOpen();
    this.ensureOutsideOwnWork();
    const client = await withSpan('db.connection.wait', { 'db.system': 'postgres' }, async () => {
      await this.ready;
      return await this.named(async () => await this.pool.connect());
    });
    let releaseError: Error | undefined;
    try {
      // One client for the whole text: `pg` sends a statement text with no
      // values through the simple protocol, so a `BEGIN … COMMIT` block is one
      // message on one connection and answers one result per statement.
      return await withSpan('db.batch', { 'db.system': 'postgres' }, async (span) => {
        const result = await this.named(async () => await client.query(text));
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
        await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('ROLLBACK') }, async (span) => {
          const answer = await client.query('ROLLBACK');
          span.setAttribute('db.rows', answer.rows.length);
          return answer;
        });
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
    const work = (async () => {
      // The work lent adapters stop with this owner runs first, while their
      // statements can still reach the pool, and every piece of it runs even
      // when an earlier one failed: the pool is given up either way, and the
      // first failure is the one the close reports.
      let failure: unknown;
      for (const stop of this.attached.splice(0)) {
        try { await stop(); }
        catch (error) { failure ??= error; }
      }
      await this.pool.end();
      if (failure !== undefined) throw failure;
    })();
    this.closePromise = work;
    return work;
  }
}

/** Bound prepared statement storage per connection; PostgreSQL chooses custom or generic plans. */
const preparedQueries = new WeakMap<Client, Map<string, string>>();
const MAX_PREPARED_QUERIES = 512;
function queryConfig(client: Client, text: string, values?: readonly unknown[]): { text: string; values?: unknown[]; name?: string } {
  const config = { text, ...(values === undefined ? {} : { values: [...values] }) };
  if (!values?.length) return config;
  let known = preparedQueries.get(client);
  if (known === undefined) { known = new Map(); preparedQueries.set(client, known); }
  let name = known.get(text);
  if (name === undefined && known.size < MAX_PREPARED_QUERIES) {
    name = 'madarch_' + createHash('sha256').update(text).digest('hex').slice(0, 40);
    known.set(text, name);
  }
  return { ...config, ...(name === undefined ? {} : { name }) };
}

/** Opens the process's PostgreSQL pool once; every adapter lent it shares this pool. */
export async function createPostgresDatabaseOwner(options: PoolConfig, store?: string): Promise<DatabaseOwner> {
  const { Pool } = await import('pg');
  const pool = new Pool(options);
  return new PostgresOwner(pool, options, true, store);
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
  /** Attach to a prepared database without creating it or extensions. */
  readonly connectOnly?: boolean;
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
    store?: string,
  ) {
    this.location = store === undefined ? inner.location : `${store} (${inner.location})`;
    this.ready = inner.ready;
  }

  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return this.inner.transaction<T>(kind, async tx => {
      EXECUTOR_OWNER.set(tx, this);
      return await work(tx);
    }, options);
  }

  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    return this.inner.run(async tx => {
      EXECUTOR_OWNER.set(tx, this);
      return await work(tx);
    });
  }

  async exec<Row extends object = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }[]> {
    return await withSpan('db.batch', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength(text) }, async (span) => {
      const results = await this.inner.exec<Row>(text);
      span.setAttribute('db.rows', results.reduce((sum, result) => sum + result.rows.length, 0));
      return results;
    });
  }

  onClose(work: () => Promise<void> | void): () => void {
    return this.inner.onClose(work);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const work = (async () => {
      try {
        await this.inner.close();
      } catch (error) {
        // A close the owner refused (one called from inside the owner's own
        // transaction) closed nothing: the pool and its connections are in use,
        // and giving the server hold up would let another process stop the
        // server under them.
        if (error instanceof OwnWorkError) throw error;
        // Everything else came after the borrows were given up — the pool asked
        // to end, or a client attached to it failed to stop on the way — and this
        // owner's hold of the server is still its own to give up.
        await this.release();
        throw error;
      }
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
  return withSpanSync('store.legacy', { 'file.path': store, 'store.folders': LEGACY_DATABASE_FOLDERS.length }, () => {
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
  });
}

/**
 * Opens a database on a cluster: the store's own (`<store>/pgdata`) with the
 * server started when nothing answers on its socket, a cluster a caller names,
 * or — with neither — a private cluster in the temporary folder that is removed
 * with the owner, which is what a temporary projection or a rendering wants.
 */
export class StoreNotPreparedError extends Error {}

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
    if (options.connectOnly === true && !existsSync(join(paths.dataDir, 'PG_VERSION'))) {
      throw new StoreNotPreparedError(`src/adapters/database-owner.ts:1: store "${options.store}" has no prepared PostgreSQL cluster; run madarch start for this store before connecting`);
    }
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
      withSpanSync('fs.remove', { 'file.path': root }, () => rmSync(root, { recursive: true, force: true }));
    };
  }
  try {
    if (options.connectOnly === true) {
      const held = await clusterQuery(cluster, CLUSTER_ADMIN_DATABASE, 'SELECT 1 AS held FROM pg_database WHERE datname = $1', [database]);
      if (held.length !== 1) throw new StoreNotPreparedError(`src/adapters/database-owner.ts:1: store "${options.store ?? cluster.socketDir}" has no prepared database "${database}"; run madarch start for this store before connecting`);
    } else await ensureDatabase(cluster, database);
    const inner = await createPostgresDatabaseOwner({ ...(process.platform === 'win32' ? clusterEndpoint(cluster.socketDir) : { host: cluster.socketDir, port: cluster.port }), database, user: cluster.user, max: 8 }, options.store ?? cluster.dataDir);
    await inner.ready;
    return new ServerStoreOwner(inner, release, options.store);
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
