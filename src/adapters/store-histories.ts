/**
 * The histories one store folder holds (madarch-8bdc.2.5, item 3): the server's
 * data folder keeps one database per source's history, all on the folder's one
 * cluster, and this is the storage-layer seam that opens them, renames one and
 * closes the server when its user is done.
 *
 * A database's name is the prefix and a hash of the source's encoded file-name
 * stem: opaque on purpose — a stem may be 200 bytes and a database name 63 — and
 * the sidecar beside it, not the name, is what the server reads a source's
 * identity from.
 */
import { byCodePoint } from '../model/order.js';
import { clusterDatabases, leaseStoreCluster, renameClusterDatabase, type ClusterLease } from './database-owner.js';
import { createHistoryStore } from './sql-history.js';
import type { Clock, HistoryStore } from '../history/types.js';
import { sha256Hex } from '../graph/digest.js';

/** The prefix every history database of a store carries, so the store's other databases are left alone. */
const HISTORY_DATABASE_PREFIX = 'h_';

/**
 * The database one source's history lives in: the prefix and a hash of its encoded file-name stem. A store that shares a
 * server with others (a test run's one server holds every case's store) names its databases by its own folder as well, so
 * two stores' "shop" never meet; a store with a server of its own keeps the plain name it always had.
 */
export function historyDatabaseOf(stem: string, namespace?: string): string {
  if (namespace === undefined) return `${HISTORY_DATABASE_PREFIX}${sha256Hex(new TextEncoder().encode(stem)).slice(0, 40)}`;
  const store = sha256Hex(new TextEncoder().encode(namespace)).slice(0, 10);
  return `${HISTORY_DATABASE_PREFIX}${store}_${sha256Hex(new TextEncoder().encode(stem)).slice(0, 28)}`;
}

export interface StoreHistoriesOptions {
  /** The store folder: its cluster is `<store>/pgdata`, its socket folder a private one under the system temporary folder. */
  readonly store: string;
  readonly clock: Clock;
  readonly log?: (line: string) => void;
  /**
   * A server the caller already runs, which the store's histories are databases on instead of a cluster of its own
   * (madarch-8bdc.2.5): a test run's one server holds every case's store, and a case then pays a database, not a server.
   * The store's folder is the namespace its databases are named by; the server is not stopped when the seam closes.
   */
  readonly server?: { readonly socketDir: string; readonly port?: number; readonly user?: string };
}

/** The histories of one store: the databases it held when it was read, and the server under them. */
export interface StoreHistories {
  /** The names of the store's history databases as the store held them, in code-point order. */
  readonly databases: readonly string[];
  /** Opens one history database; the store's server answers it, started on the first open. */
  historyOf(database: string): HistoryStore;
  /** The database name one source's history stands under in this store (two stores on one server never share one). */
  databaseOf(stem: string): string;
  /** Renames one history database; no session may hold it open, so close its history first. */
  rename(from: string, to: string): Promise<void>;
  /** Closes every history this seam opened and stops the server when this process started it. */
  close(): Promise<void>;
}

export async function openStoreHistories(options: StoreHistoriesOptions): Promise<StoreHistories> {
  // The store's own cluster, started on the first open — or the server a caller already runs, on which this store's
  // databases are the ones its folder names.
  const lease: ClusterLease | undefined = options.server === undefined ? await leaseStoreCluster(options.store, { ...(options.log === undefined ? {} : { log: options.log }) }) : undefined;
  const ref = lease?.ref ?? options.server!;
  const namespace = options.server === undefined ? undefined : options.store;
  const databaseOf = (stem: string): string => historyDatabaseOf(stem, namespace);
  // A store on a shared server names its databases by its folder's hash before the source's; a store of its own holds no
  // others, so the prefix alone answers.
  const prefix = namespace === undefined ? HISTORY_DATABASE_PREFIX : historyDatabaseOf('', namespace).slice(0, HISTORY_DATABASE_PREFIX.length + 11);
  const databases = (await clusterDatabases(ref)).filter((name) => name.startsWith(prefix)).sort(byCodePoint);
  const opened = new Map<string, HistoryStore>();
  return {
    databases,
    databaseOf,
    historyOf(database: string): HistoryStore {
      let history = opened.get(database);
      if (history === undefined) {
        history = createHistoryStore({ store: options.store, cluster: ref, database, clock: options.clock });
        opened.set(database, history);
      }
      return history;
    },
    async rename(from: string, to: string): Promise<void> {
      const held = opened.get(from);
      if (held !== undefined) {
        await held.close();
        opened.delete(from);
      }
      await renameClusterDatabase(ref, from, to);
    },
    async close(): Promise<void> {
      await Promise.all([...opened.values()].map(async (history) => await history.close()));
      opened.clear();
      // A server the caller runs is theirs to stop; only a cluster this seam started is stopped with it.
      if (lease !== undefined) await lease.close();
    },
  };
}
