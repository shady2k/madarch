/**
 * The database this test run's cases open (madarch-8bdc.2.5, item 2): one
 * PostgreSQL server for the run, started by the preload (`run-scratch.ts`), and
 * one database per case or per file on it, dropped when the case's owner closes.
 * Default empty-contract cases clone a template prepared by the preload once;
 * explicit stores, database names, sockets and graph contracts prepare directly.
 *
 * Before this, a case that opened a store booted a database of its own: 1.66 s on
 * the pod the suite runs on (measured 2026-10-20, madarch-cznn), which is what
 * made a store-opening case several times the cost of any other. A database on
 * a server that is already running is created in about 30 ms, so a case can hold
 * the fresh, empty database it used to get without paying for a server.
 *
 * The server's socket folder travels in `MADARCH_TEST_PG_SOCKET`, which a child
 * process a test starts inherits, so a test that reopens a store in another
 * process still finds the run's server.
 *
 * A case that needs a *store folder* of its own — a file layout a second process
 * reopens, a queue's data directory, a crash driver's state — names one with
 * `store`, and pays for that store's own cluster.
 */
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import type { GraphContract } from '../src/graph/contract.js';
import { clusterQuery, CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';
import { ensureRunPostgres } from './run-postgres.js';
import { createHistoryStore } from '../src/adapters/sql-history.js';
import { sha256Hex } from '../src/graph/digest.js';
import type { Clock, HistoryStore } from '../src/history-types.js';

/** The database one source's history lives in (the shape `src/adapters/store-histories.ts` keeps for itself). */
function historyDatabaseOf(stem: string, namespace?: string): string {
  const prefix = 'h_';
  if (namespace === undefined) return `${prefix}${sha256Hex(new TextEncoder().encode(stem)).slice(0, 40)}`;
  const store = sha256Hex(new TextEncoder().encode(namespace)).slice(0, 10);
  return `${prefix}${store}_${sha256Hex(new TextEncoder().encode(stem)).slice(0, 28)}`;
}

/** The variable naming the run server's socket folder; `run-postgres.ts` sets it before any test file loads. */
export const TEST_SERVER_VARIABLE = 'MADARCH_TEST_PG_SOCKET';

/** One prepared database on the run's server, never opened by a case. */
const TEST_DATABASE_TEMPLATE = 'template_madarch_test';
let templateReady: Promise<void> | undefined;

/** How many databases this process has made, so two cases of one file never share a name. */
let made = 0;

/** A database identifier, including names a caller supplies, as SQL spells it. */
function quotedDatabase(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/**
 * Prepares the run's empty-contract store before test cases load. Closing the
 * owner's pool is part of readiness: PostgreSQL cannot clone a connected database.
 * Children on this server reuse the prepared template instead of preparing it again.
 */
export async function prepareTestDatabaseTemplate(): Promise<void> {
  templateReady ??= (async () => {
    await ensureRunPostgres();
    const socketDir = testServerSocket();
    const cluster = { dataDir: socketDir, socketDir, port: CLUSTER_PORT, user: 'postgres', bin: '', stop: async () => await Promise.resolve() };
    const held = await clusterQuery(cluster, 'postgres', 'SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DATABASE_TEMPLATE]);
    if (held.length !== 0) return;
    const owner = await createDatabaseOwner({ cluster: { socketDir }, database: TEST_DATABASE_TEMPLATE });
    try {
      await prepareStore(owner);
    } finally {
      await owner.close();
    }
  })();
  await templateReady;
}

/**
 * Why the run's server is not there, when the preload could not start it. The
 * preload notes the failure here rather than this module importing the preload:
 * a compiled driver (`fill-crash-driver.ts`) imports this file and needs no
 * test run's scratch folder or server.
 */
let serverFailure: Error | undefined;

/** Records why the run's server could not start, for every case that then tries to open a database. */
export function noteTestServerFailure(error: Error): void {
  serverFailure = error;
}

/**
 * Drops every history database a store folder made on the run's server (madarch-8bdc.2.5): a case's folder names its
 * databases, and the folder's own removal does not reach them.
 */
export async function dropTestStoreDatabases(folder: string): Promise<void> {
  const socketDir = testServerSocket();
  const prefix = `${historyDatabaseOf('', folder).slice(0, 'h_'.length + 11)}`;
  const cluster = { dataDir: socketDir, socketDir, port: CLUSTER_PORT, user: 'postgres', bin: '', stop: async () => await Promise.resolve() };
  const held = await clusterQuery<{ datname: string }>(cluster, 'postgres', 'SELECT datname FROM pg_database WHERE datname LIKE $1', [`${prefix.replace(/_/gu, '\\_')}%`]).catch(() => []);
  for (const row of held) await clusterQuery(cluster, 'postgres', `DROP DATABASE IF EXISTS "${row.datname.replace(/"/gu, '""')}" WITH (FORCE)`).catch(() => undefined);
}

/** The run server's socket folder, or a failure naming what starts it when the preload did not. */
function testServerSocket(): string {
  const held = process.env[TEST_SERVER_VARIABLE]?.trim();
  if (held === undefined || held === '') {
    if (serverFailure !== undefined) throw serverFailure;
    throw new Error(`test/test-database.ts:1: ${TEST_SERVER_VARIABLE} names no server: the suite's server is started by test/run-scratch.ts, which bunfig.toml declares as a preload — run the suite from the repository root (bun test test/), or start a server and name its socket folder in ${TEST_SERVER_VARIABLE}`);
  }
  return held;
}

/**
 * The run's one server, as the cluster a case's store stands on (madarch-8bdc.2.5): the store's histories are databases
 * on it, and a case pays a database (about 30 ms) instead of a cluster of its own (initdb and a start: about 1 s on the
 * pod, measured 2026-10-20, madarch-cznn). A case about a store's own cluster passes no server and pays that cluster.
 */
export async function testStoreServer(): Promise<{ readonly socketDir: string; readonly port: number; readonly user: string }> {
  // The preload starts the server; standalone drivers can also ask for it here.
  await ensureRunPostgres();
  return { socketDir: testServerSocket(), port: CLUSTER_PORT, user: 'postgres' };
}

/** What a case asks the run's server for: a fresh database, or a store folder's own cluster. */
export interface TestDatabaseOptions {
  readonly graphContract?: GraphContract;
  /** Opens `btree_gist`, which the temporal graph's no-overlap constraints need. */
  readonly btreeGist?: boolean;
  /** A store folder of the case's own: its cluster is opened and stopped with the owner. */
  readonly store?: string;
  /** The database inside that store; names it only for a store a case opens more than once. */
  readonly database?: string;
  /** The server's socket folder; the run's server unless a case names another. */
  readonly socket?: string;
}

/** A fresh database the run's server holds for one case, dropped when its owner closes. */
async function dropDatabase(socketDir: string, database: string): Promise<void> {
  const cluster = { dataDir: socketDir, socketDir, port: 5_432, user: 'postgres', bin: '', stop: async () => await Promise.resolve() };
  await clusterQuery(cluster, 'postgres', `DROP DATABASE IF EXISTS "${database.replace(/"/gu, '""')}" WITH (FORCE)`).catch(() => undefined);
}

/**
 * The owner a case's store work is given: a fresh, empty database on the run's
 * server, or the store folder the case names. Nothing a case writes outlives it.
 */
export async function createTestDatabaseOwner(options: TestDatabaseOptions = {}): Promise<DatabaseOwner> {
  // A store of the case's own opens its own cluster and needs no run server: a compiled driver (`queue-binary-driver.ts`,
  // `fill-crash-driver.ts`) is no test run at all.
  if (options.store !== undefined) {
    const owner = await createDatabaseOwner({ store: options.store, ...(options.database === undefined ? {} : { database: options.database }) });
    await prepareStore(owner, options.graphContract === undefined ? {} : { contract: options.graphContract });
    return owner;
  }
  // Also support drivers that open a database without the suite's preload.
  await ensureRunPostgres();
  const socketDir = options.socket ?? testServerSocket();
  made += 1;
  // A database the case names is the case's (a store's history database it reopens across seams); one it does not name is
  // this owner's own fresh one, dropped when the owner closes.
  const database = options.database ?? `t_${String(process.pid)}_${String(made)}`;
  const own = options.database === undefined;
  const clone = options.graphContract === undefined && options.socket === undefined && own;
  if (clone) {
    await prepareTestDatabaseTemplate();
    const cluster = { dataDir: socketDir, socketDir, port: CLUSTER_PORT, user: 'postgres', bin: '', stop: async () => await Promise.resolve() };
    await clusterQuery(cluster, 'postgres', `CREATE DATABASE ${quotedDatabase(database)} TEMPLATE ${quotedDatabase(TEST_DATABASE_TEMPLATE)}`);
  }
  const owner = await createDatabaseOwner({ cluster: { socketDir }, database, ...(clone ? { connectOnly: true } : {}), ...(options.btreeGist === true ? { btreeGist: true } : {}) });
  if (!clone) await prepareStore(owner, options.graphContract === undefined ? {} : { contract: options.graphContract });
  let closed: Promise<void> | undefined;
  return {
    location: owner.location,
    ready: owner.ready,
    allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    hasVector: owner.hasVector,
    transaction: (kind, work) => owner.transaction(kind, work),
    run: (work) => owner.run(work),
    exec: (text) => owner.exec(text),
    close: () => {
      closed ??= (async () => {
        await owner.close();
        if (own) await dropDatabase(socketDir, database);
      })();
      // A close a case provokes on purpose (from inside the owner's own
      // transaction, say) rejects; this handler keeps that rejection from
      // becoming an unhandled one, and the caller still sees it.
      closed.catch(() => { closed = undefined; });
      return closed;
    },
  };
}

/**
 * A history store on a fresh database of the run's server, dropped when it
 * closes: the shape `createHistoryStore({ clock })` had when a store was a
 * database of its own, without a cluster per case.
 */
export async function createTestHistory(options: { readonly clock: Clock; readonly store?: string }): Promise<HistoryStore> {
  if (options.store !== undefined) {
    // A history of a store of its own: it opens and closes the store, and names it in the errors it reports.
    const owner = await createTestDatabaseOwner({ store: options.store });
    const held = createHistoryStore({ owner, clock: options.clock });
    return { ...held, close: async () => { try { await held.close(); } finally { await owner.close(); } } };
  }
  const owner = await createTestDatabaseOwner();
  const history = createHistoryStore({ owner, clock: options.clock });
  return {
    ...history,
    close: async () => {
      try {
        await history.close();
      } finally {
        await owner.close();
      }
    },
  };
}

/** A store opened for raw statements: what a case that pokes at a store's own rows uses. */
export interface RawStore {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** A store of the case's own, opened for raw statements and closed (with its server) when the case is done. */
export async function openRawStore(store: string, options: { readonly btreeGist?: boolean } = {}): Promise<RawStore> {
  const owner = await createTestDatabaseOwner({ store, ...(options.btreeGist === true ? { btreeGist: true } : {}) });
  return {
    query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => await owner.run(async (tx) => await tx.query<Row>(sql, values)),
    exec: async (sql: string) => { await owner.exec(sql); },
    close: () => owner.close(),
  };
}

/** One history of a data folder's store, opened for raw statements: the rows a sidecar or a repair case writes by hand. */
export async function openRawHistory(dataFolder: string, stem: string): Promise<RawStore> {
  return await openRawStoreWith({ store: dataFolder, database: historyDatabaseOf(stem) });
}

/** A store of the case's own, opened for raw statements on the database a caller names. */
async function openRawStoreWith(options: { readonly store: string; readonly database: string }): Promise<RawStore> {
  const owner = await createTestDatabaseOwner(options);
  return {
    query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => await owner.run(async (tx) => await tx.query<Row>(sql, values)),
    exec: async (sql: string) => { await owner.exec(sql); },
    close: () => owner.close(),
  };
}

/** The pgvector version the run's server carries, or undefined when it carries none: what a vector case skips on. */
export async function serverPgVectorVersion(): Promise<string | undefined> {
  const owner = await createTestDatabaseOwner();
  try {
    const rows = await owner.run(async (tx) => await tx.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'"));
    return rows.rows[0]?.extversion;
  } finally {
    await owner.close();
  }
}
