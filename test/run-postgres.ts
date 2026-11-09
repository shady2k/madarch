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
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseStoreCluster, type ClusterLease } from '../src/adapters/database-owner.js';
import { noteTestServerFailure, TEST_SERVER_VARIABLE } from './test-database.js';

let lease: ClusterLease | undefined;
let failure: Error | undefined;

/**
 * Stops the run's server, waited for, before the scratch folder that holds it is swept: a run that ends must leave no
 * PostgreSQL server behind, and a sweep that only signals the process it found would leave one finishing its shutdown
 * (measured: one `postgres -D <scratch>/tmp/postgres/pgdata` alive right after every shard run, gone a moment later).
 */
export async function stopRunPostgres(): Promise<void> {
  const held = lease;
  lease = undefined;
  await held?.close().catch(() => undefined);
  // A server the close could not stop — another process of this run still held it, or a child still connected — is
  // signalled here and waited for: this run's server may not outlive the run, and the sweep that removes its folder follows.
  await stopServerIn(join(tmpdir(), 'postgres', 'pgdata'));
}

/**
 * Stops every PostgreSQL server whose data directory stands inside `folder` — a run's scratch — and waits for each: a
 * run leaves no server behind, whichever test file started it and whether or not that file closed it (madarch-8bdc.12:
 * shard 5 left two, one of a product's store and one of a served product's query graph).
 */
export async function stopServersUnder(folder: string): Promise<void> {
  const dataDirs: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (name === 'postmaster.pid') { dataDirs.push(dir); continue; }
      // A folder's children are followed, never a link out of the run's own scratch.
      try { if (statSync(path).isDirectory() && lstatSync(path).isSymbolicLink() === false) walk(path, depth + 1); } catch { /* gone or unreadable */ }
    }
  };
  walk(folder, 0);
  for (const dataDir of dataDirs) await stopServerIn(dataDir);
}

/** One server, signalled and waited for: only the one whose own command line names this data directory. */
async function stopServerIn(dataDir: string): Promise<void> {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  let mine = true;
  try { mine = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes(dataDir); } catch { mine = true; }
  if (!mine) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(pid, signal); } catch { return; }
    const until = Date.now() + 5_000;
    while (Date.now() < until && alive(pid)) await Bun.sleep(20);
    if (!alive(pid)) return;
  }
}

/** Whether a process is still there: one this process may not signal counts as there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
  // The run's scratch is the temporary folder the preload points TMPDIR into (`run-scratch.ts`), and the server's store
  // stands in it — not read from `run-scratch.ts`, whose load imports `bun:test` and so hangs a compiled driver.
  const store = join(tmpdir(), 'postgres');
  try {
    lease = await leaseStoreCluster(store);
    process.env[TEST_SERVER_VARIABLE] = lease.ref.socketDir;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    noteTestServerFailure(failure);
    process.stderr.write(`madarch test run: the run's PostgreSQL server could not start, so every case that opens a database will fail: ${failure.message}\n`);
  }
}
