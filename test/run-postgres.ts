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
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseStoreCluster, type ClusterLease } from '../src/adapters/database-owner.js';
import { clusterQuery, CLUSTER_PORT, CLUSTER_USER } from '../src/adapters/postgres-cluster.js';
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

/**
 * Stops every fill role whose command line names `folder` — a run's scratch — and waits for each: a run leaves no
 * process behind, and a role a test started directly (or a server's child a signal reached too late) is one.
 */
export async function stopRolesUnder(folder: string): Promise<void> {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (listed.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (!command.includes('--role') || !command.includes(' fill') || !command.includes(folder)) continue;
    if (!Number.isInteger(pid) || pid <= 1) continue;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try { process.kill(pid, signal); } catch { break; }
      const until = Date.now() + 3_000;
      while (Date.now() < until && alive(pid)) await Bun.sleep(20);
      if (!alive(pid)) break;
    }
  }
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
 * Starts the run's server once. The preload awaits it before test files load,
 * so no case pays for cluster startup. The socket folder is inherited by child
 * processes that use the test database helper. A server that
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

/** The settings that make a database's DROP cheap on a server a run throws away (ALX-186, C1). */
const NON_DURABLE_SETTINGS = ['fsync', 'full_page_writes', 'synchronous_commit'] as const;

/**
 * Makes the run's server non-durable, after it is leased and before any case opens a database on it: `DROP DATABASE`
 * forces a checkpoint of the whole cluster, and on a durable server that checkpoint `fsync`s every dirty page — 1.2 s on
 * a quiet cluster and 8.4 s with 240 MB of them (ALX-119). This server stands in the run's scratch folder and is
 * deleted with it, so none of it is worth syncing to disk. A store folder a case opens for itself keeps the defaults:
 * its data outlives the run.
 *
 * Only this server takes the settings. A reload applies them to the running postmaster, so the wait below reads them
 * back from `pg_settings` instead of assuming the signal was served before the next statement.
 */
async function makeRunServerNonDurable(ref: ClusterLease['ref']): Promise<void> {
  const cluster = { dataDir: ref.socketDir, socketDir: ref.socketDir, port: ref.port ?? CLUSTER_PORT, user: ref.user ?? CLUSTER_USER, bin: '', stop: async () => await Promise.resolve() };
  for (const name of NON_DURABLE_SETTINGS) await clusterQuery(cluster, 'postgres', `ALTER SYSTEM SET ${name} = 'off'`);
  await clusterQuery(cluster, 'postgres', 'SELECT pg_reload_conf()');
  const until = Date.now() + 5_000;
  for (;;) {
    const rows = await clusterQuery<{ name: string; setting: string }>(cluster, 'postgres', 'SELECT name, setting FROM pg_settings WHERE name = ANY($1)', [NON_DURABLE_SETTINGS]);
    if (rows.length === NON_DURABLE_SETTINGS.length && rows.every((row) => row.setting === 'off')) return;
    if (Date.now() > until) {
      const held = rows.map((row) => `${row.name}=${row.setting}`).join(', ');
      throw new Error(`${join(tmpdir(), 'postgres', 'postgres.log')}:1: the run's PostgreSQL server did not take the non-durable settings within 5 s of pg_reload_conf(): ${held}`);
    }
    await Bun.sleep(20);
  }
}

/** Starts the server now: what `ensureRunPostgres` runs once. */
async function startRunPostgres(): Promise<void> {
  // The run's scratch is the temporary folder the preload points TMPDIR into (`run-scratch.ts`), and the server's store
  // stands in it — not read from `run-scratch.ts`, whose load imports `bun:test` and so hangs a compiled driver.
  const store = join(tmpdir(), 'postgres');
  try {
    lease = await leaseStoreCluster(store);
    process.env[TEST_SERVER_VARIABLE] = lease.ref.socketDir;
    await makeRunServerNonDurable(lease.ref);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    noteTestServerFailure(failure);
    process.stderr.write(`madarch test run: the run's PostgreSQL server could not start, so every case that opens a database will fail: ${failure.message}\n`);
  }
}
