/**
 * The one server a `bun test` run's cases open (madarch-8bdc.2.5, item 2): the
 * preload starts it in the run's scratch folder before any test file loads, and
 * stops it when the run ends, pass or fail. Each case then opens a database on
 * it (`test-database.ts`), so the per-case cost is a database, not a server.
 *
 * The binaries are madarch's own install — `<madarch home>/tools/postgresql/<version>`,
 * which `run-scratch.ts` points at the account's install so a run does not
 * download twice — and the cluster's data and socket folders stand inside the
 * run's scratch, which is what makes a finished run leave nothing behind and a
 * killed run's server the next run's to sweep.
 */
import { join } from 'node:path';
import { leaseStoreCluster, type ClusterLease } from '../src/adapters/database-owner.js';
import { runScratch } from './run-scratch.js';
import { noteTestServerFailure, TEST_SERVER_VARIABLE } from './test-database.js';

let lease: ClusterLease | undefined;
let failure: Error | undefined;

/**
 * Starts the run's server, once, and puts its socket folder where every test file
 * and every child process it starts reads it: the first case that opens a
 * database asks, and a run with no such case never starts a server (a child run
 * of the scratch fixture is 10 s slower when every run boots one). A server that
 * cannot start (root, a platform with no pinned build, a machine that cannot
 * download) is kept as the failure every case that opens a database reports.
 */
export async function ensureRunPostgres(): Promise<void> {
  if (lease !== undefined || failure !== undefined) return;
  start ??= startRunPostgres();
  await start;
}

/** The one start, shared by every case that asks while it runs. */
let start: Promise<void> | undefined;

/** Starts the server now: what `ensureRunPostgres` runs once. */
async function startRunPostgres(): Promise<void> {
  const scratch = runScratch();
  const store = join(scratch.folder, 'postgres');
  try {
    lease = await leaseStoreCluster(store);
    process.env[TEST_SERVER_VARIABLE] = lease.ref.socketDir;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    noteTestServerFailure(failure);
    process.stderr.write(`madarch test run: the run's PostgreSQL server could not start, so every case that opens a database will fail: ${failure.message}\n`);
  }
}
