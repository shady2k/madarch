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
const schemaOwners = new WeakMap<DatabaseOwner,DatabaseOwner>();
/** Prepare schema before fixture source operations, through the unbound owner. */
export async function prepareTestStore(owner:DatabaseOwner,options:Parameters<typeof prepareStore>[1]={}) {
  const result = await prepareStore(schemaOwners.get(owner)??owner,options);
  if (options.contract !== undefined) Object.assign(owner, { graphContract: withAssertionContract(options.contract) });
  return result;
}

import { EMPTY_CONTRACT, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import type { FillStateDatabase } from '../src/graph/fill-state.js';
export type TestDatabaseOwner = DatabaseOwner & FillStateDatabase;
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { clusterEndpoint, clusterQuery, CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';
import { graphSchemaStamp } from '../src/adapters/schemas/graph-definition.js';
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

/** The run's template of one graph contract, never opened by a case. */
const CONTRACT_TEMPLATE_PREFIX = 'template_madarch_';

/** One prepared template per contract of the run, by the server's socket folder and the template's name. */
const contractTemplates = new Map<string, Promise<void>>();

/**
 * A failure a case injects into the next preparation of a contract template,
 * once, after the template's database is made and before its schema is
 * installed (`test-database-template-readiness.test.ts`): the shape of a
 * transient SQL failure halfway through a preparation. Never set outside a test.
 */
let templateFailure: Error | undefined;

/** Makes the next contract template preparation fail after its database exists, once. */
export function failNextContractTemplatePreparation(error: Error): void {
  templateFailure = error;
}

/** Throws the case's injected failure, if it stands, at the point of preparation after the database is made. */
function throwInjectedTemplateFailure(): void {
  const held = templateFailure;
  templateFailure = undefined;
  if (held !== undefined) throw held;
}
let templateReady: Promise<void> | undefined;

/** How many databases this process has made, so two cases of one file never share a name. */
let made = 0;

/** A database identifier, including names a caller supplies, as SQL spells it. */
function quotedDatabase(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/**
 * How the run names the template of one contract (ALX-105 variant 4): the
 * contract's own schema stamp, twelve hex characters of it, so a schema change
 * names a new template and a case of a changed contract never clones the old
 * schema. PostgreSQL truncates identifiers past 63 bytes; this name stays short.
 */
function contractTemplateName(stamp: string): string {
  return `${CONTRACT_TEMPLATE_PREFIX}${stamp.slice(0, 12)}`;
}

/** The schema stamp the store of a case would write for the contract the case declares. */
function contractStamp(declared: GraphContract | undefined): string {
  return graphSchemaStamp(withAssertionContract(declared ?? EMPTY_CONTRACT));
}

/** The run server's cluster, for the statements no transaction may hold: `CREATE DATABASE` and a session lock. */
function runCluster(socketDir: string): { socketDir: string; dataDir: string; port: number; user: string; bin: string; stop: () => Promise<void> } {
  return { socketDir, dataDir: socketDir, port: CLUSTER_PORT, user: 'postgres', bin: '', stop: async () => await Promise.resolve() };
}

/** The key of one template's creation lock, derived from the template's name so every process of a run agrees. */
function templateLockKey(name: string): string {
  return BigInt(`0x${sha256Hex(new TextEncoder().encode(`madarch:test-template:${name}`)).slice(0, 15)}`).toString();
}

/**
 * Runs `work` under a session advisory lock of the run's server. `CREATE DATABASE`
 * may not run inside a transaction, so the transaction-scoped lock the store's
 * own schema uses cannot hold it: the lock is taken by a connection of its own
 * and given back when the work is done, whichever way it ended. A process killed
 * holding it releases it with its connection, so a crashed run never leaves a
 * template locked.
 */
async function withServerLock(socketDir: string, key: string, work: () => Promise<void>): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ ...clusterEndpoint(socketDir), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/**
 * Makes the run's template of one contract once, under the server's advisory lock
 * for that template, and answers whether it was there already. A case with an
 * explicit contract clones this template instead of installing the schema: the
 * installation is thousands of statements and a checkpoint-free copy is one
 * (ALX-105, C and H). Closing the owner's pool is part of the preparation —
 * PostgreSQL cannot clone a database another session is connected to.
 */
async function prepareContractTemplate(declared: GraphContract | undefined, socketDir: string, timing?: TestDatabaseOptions['timing']): Promise<{ name: string; reused: boolean }> {
  const name = contractTemplateName(contractStamp(declared));
  const key = `${socketDir}\n${name}`;
  const existing = contractTemplates.get(key);
  if (existing !== undefined) {
    timing?.('contract-template-reused', 0);
    await existing;
    return { name, reused: true };
  }
  let reused = false;
  const work = (async () => {
    await withServerLock(socketDir, templateLockKey(name), async () => {
      const held = await clusterQuery(runCluster(socketDir), 'postgres', 'SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (held.length !== 0) {
        reused = true;
        timing?.('template-already-exists', 0);
        return;
      }
      const preparationStart = performance.now();
      timing?.('contract-template-preparation-start', 0);
      const owner = await createDatabaseOwner({ cluster: { socketDir }, database: name });
      try {
        throwInjectedTemplateFailure();
        await prepareStore(owner, declared === undefined ? {} : { contract: declared });
      } finally {
        await owner.close();
        timing?.('contract-template-preparation', performance.now() - preparationStart);
      }
    });
  })();
  contractTemplates.set(key, work);
  // A preparation that failed is not kept: the next case of the contract tries again instead of inheriting the failure.
  void work.catch(() => { if (contractTemplates.get(key) === work) contractTemplates.delete(key); });
  await work;
  return { name, reused };
}

/**
 * Prepares the run's empty-contract template before test cases load. Children on
 * this server reuse the prepared template instead of preparing it again.
 */
export async function prepareTestDatabaseTemplate(timing?: TestDatabaseOptions['timing']): Promise<void> {
  templateReady ??= (async () => {
    await ensureRunPostgres();
    await prepareContractTemplate(undefined, testServerSocket(), timing);
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
  /** Optional diagnostics for a case investigating setup cost. Times are wall-clock milliseconds. */
  readonly timing?: (phase: string, elapsedMs: number) => void;
  readonly graphContract?: GraphContract;
  /** Disable fixture authentication when testing the untrusted write boundary. */
  readonly authenticated?: boolean;
  /** Opens `btree_gist`, which the temporal graph's no-overlap constraints need. */
  readonly btreeGist?: boolean;
  /** A store folder of the case's own: its cluster is opened and stopped with the owner. */
  readonly store?: string;
  /** The database inside that store; names it only for a store a case opens more than once. */
  readonly database?: string;
  /** The server's socket folder; the run's server unless a case names another. */
  readonly socket?: string;
}

/**
 * The drops the run owes, one lane for all of them (ALX-119). `DROP DATABASE` is
 * not free: PostgreSQL checkpoints the whole cluster and flushes every dirty
 * buffer before it removes the database, so the drop of one case's database
 * writes the pages of every other database and waits for their `fsync` —
 * measured on this box with `log_checkpoints = on`: 1.2 s on a quiet cluster
 * (1 464 buffers, sync 1.12 s) and 8.4 s with 240 MB of them (16 246 buffers,
 * sync 7.74 s), each naming an `immediate force wait` checkpoint. A case's
 * teardown therefore enqueues its drop and returns, and the run waits for the
 * lane once, before it stops the server (`test/run-scratch.ts`).
 */
let dropLane: Promise<void> = Promise.resolve();
let dropsOwed = 0;

/** Enqueues one database's drop behind every drop the run already owes. */
function queueTestDatabaseDrop(socketDir: string, database: string, timing?: TestDatabaseOptions['timing']): void {
  dropsOwed += 1;
  dropLane = dropLane.then(async () => {
    const start = performance.now();
    timing?.('database-drop-start', 0);
    try {
      await dropDatabase(socketDir, database);
    } finally {
      timing?.('database-drop', performance.now() - start);
      dropsOwed -= 1;
    }
  }).catch(() => undefined);
}

/** Waits for every drop the run owes: the preload does this before it stops the run's server. */
export async function waitForTestDatabaseDrops(): Promise<void> {
  await dropLane;
}

/** How many drops the run still owes: a case that closed its owner leaves one until the lane reaches it. */
export function pendingTestDatabaseDrops(): number {
  return dropsOwed;
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
export async function createTestDatabaseOwner(options: TestDatabaseOptions = {}): Promise<TestDatabaseOwner> {
  const graphContract = withAssertionContract(options.graphContract ?? EMPTY_CONTRACT);
  // A store of the case's own opens its own cluster and needs no run server: a compiled driver (`queue-binary-driver.ts`,
  // `fill-crash-driver.ts`) is no test run at all.
  if (options.store !== undefined) {
    const owner = await createDatabaseOwner({ store: options.store, ...(options.database === undefined ? {} : { database: options.database }) });
    await prepareStore(owner, options.graphContract === undefined ? {} : { contract: options.graphContract });
    return Object.assign(owner, { graphContract });
  }
  // Also support drivers that open a database without the suite's preload.
  const serverStart = performance.now();
  options.timing?.('server-ready-start', 0);
  await ensureRunPostgres();
  options.timing?.('server-ready', performance.now() - serverStart);
  const socketDir = options.socket ?? testServerSocket();
  made += 1;
  // A database the case names is the case's (a store's history database it reopens across seams); one it does not name is
  // this owner's own fresh one, dropped when the owner closes.
  const database = options.database ?? `t_${String(process.pid)}_${String(made)}`;
  const own = options.database === undefined;
  // A fresh database of the case's own on the run's server clones the run's template of the contract the case
  // declares (ALX-105 variant 4): the schema is installed once per contract and a case pays a copy of it. A
  // database the case names, and a server it names, are not the run's to template.
  const clone = own && options.socket === undefined;
  if (clone) {
    const templateStart = performance.now();
    options.timing?.('template-ready-start', 0);
    const template = await prepareContractTemplate(options.graphContract, socketDir, options.timing);
    options.timing?.(template.reused ? 'template-ready' : 'template-first-request', performance.now() - templateStart);
    const cloneStart = performance.now();
    options.timing?.('database-clone-start', 0);
    try {
      await clusterQuery(runCluster(socketDir), 'postgres', `CREATE DATABASE ${quotedDatabase(database)} TEMPLATE ${quotedDatabase(template.name)}`);
    } finally {
      options.timing?.('database-clone', performance.now() - cloneStart);
    }
  }
  const ownerStart = performance.now();
  options.timing?.('database-owner-open-start', 0);
  const owner = await createDatabaseOwner({ cluster: { socketDir }, database, ...(clone ? { connectOnly: true } : {}), ...(options.btreeGist === true ? { btreeGist: true } : {}) });
  options.timing?.('database-owner-open', performance.now() - ownerStart);
  if (!clone) await prepareStore(owner, options.graphContract === undefined ? {} : { contract: options.graphContract });
  let closed: Promise<void> | undefined;
  const fixtureOwner:TestDatabaseOwner = {
    graphContract,
    location: owner.location,
    ready: owner.ready,
    allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
    hasVector: owner.hasVector,
    transaction: (kind, work) => owner.transaction(kind, async tx => {
      if (kind === 'write' && options.authenticated !== false) await bindTestWriteCapability(tx, options.graphContract ?? EMPTY_CONTRACT);
      return await work(tx);
    }),
    run: (work) => owner.run(work),
    exec: (text) => owner.exec(text),
    close: () => {
      closed ??= (async () => {
        const closeStart = performance.now();
        await owner.close();
        options.timing?.('database-owner-close', performance.now() - closeStart);
        // The drop is the run's, not the case's: it leaves the teardown at once and the lane pays it.
        if (own) queueTestDatabaseDrop(socketDir, database, options.timing);
      })();
      // A close a case provokes on purpose (from inside the owner's own
      // transaction, say) rejects; this handler keeps that rejection from
      // becoming an unhandled one, and the caller still sees it.
      closed.catch(() => { closed = undefined; });
      return closed;
    },
  };
  schemaOwners.set(fixtureOwner,owner);
  return fixtureOwner;
}

/**
 * A history store on a fresh database of the run's server, dropped when it
 * closes: the shape `createHistoryStore({ clock })` had when a store was a
 * database of its own, without a cluster per case. Plain SQL temporal history
 * needs no graph write capability (0039 item 26); graph fixtures use
 * createTestDatabaseOwner and keep its authenticated write path.
 */
export async function createTestHistory(options: { readonly clock: Clock; readonly store?: string; readonly timing?: TestDatabaseOptions['timing'] }): Promise<HistoryStore> {
  if (options.store !== undefined) {
    // A history of a store of its own: it opens and closes the store, and names it in the errors it reports.
    const owner = await createTestDatabaseOwner({ store: options.store, authenticated: false });
    const held = createHistoryStore({ owner, clock: options.clock });
    return { ...held, close: async () => { try { await held.close(); } finally { await owner.close(); } } };
  }
  const owner = await createTestDatabaseOwner({ authenticated: false, ...(options.timing === undefined ? {} : { timing: options.timing }) });
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
