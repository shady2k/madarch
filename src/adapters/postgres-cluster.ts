/**
 * The PostgreSQL server a store runs on (madarch-8bdc.2.5, items 1 and 3): one
 * cluster — a data directory, and a Unix socket folder the server listens in and
 * nowhere else — started on demand and stopped when the process that started it
 * closes it.
 *
 * One cluster holds many databases, so a store, a product's snapshot of it and a
 * source's history are databases of one server rather than servers of their own.
 * Two processes share a cluster by attaching: a process that finds the server
 * answering uses it and never stops it, and a process whose predecessor was
 * killed adopts the server it left (the `owner.pid` file names the process that
 * started it) and stops it when it is done. A server nobody adopted is stopped by
 * the process that started it, unless another process is still connected — then
 * it is left running and its ownership file is removed, so the next process to
 * open the cluster adopts it.
 *
 * PostgreSQL refuses to run as root, so an open as root says what to do instead
 * of failing inside initdb.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { log as defaultLog } from '../obs/log.js';
import { sha256Hex } from '../graph/digest.js';
import { ensurePostgresInstalled, refuseRoot } from './postgres-install.js';

/** The port every cluster's socket is named after: nothing listens on TCP, so two clusters never meet. */
export const CLUSTER_PORT = 5_432;

/** The superuser `initdb` makes; a store's server is private to the machine's user and trusts the socket. */
export const CLUSTER_USER = 'postgres';

/** The database a cluster is asked questions in: the one `initdb` makes. */
export const CLUSTER_ADMIN_DATABASE = 'postgres';

/** How long a cluster is given to answer after its `postmaster.pid` names a live process, before it is stopped. */
const ANSWER_WAIT_MS = 5_000;

/** The prefix of the socket folder a store's server listens in, in the system temporary folder. */
const SOCKET_FOLDER_PREFIX = 'madarch-pg-';

/** The ownership file's name inside a cluster's data directory. */
const OWNER_FILE = 'madarch-owner.pid';

/** A cluster whose server answers, and what may be done with it. */
export interface RunningCluster {
  /** The data directory the server holds. */
  readonly dataDir: string;
  /** The socket folder, which is the host every client connects to. */
  readonly socketDir: string;
  readonly port: number;
  readonly user: string;
  /** True when this process started or adopted the server, which is what lets it stop the server. */
  readonly startedIt: boolean;
  /** The folder the server's programs are in. */
  readonly bin: string;
  /** Stops the server when this process owns it and no other process is connected, then removes the socket folder. */
  stop(): Promise<void>;
}

/**
 * The data directory of a store (`<store>/pgdata`) and its socket folder.
 *
 * The socket folder stands in the system temporary folder under a hash of the data directory, because a Unix socket
 * path is limited to about a hundred bytes and a store's path is not: `<products home>/.madarch/knowledge/<id>/graph/pgsock`
 * is longer than that on this machine (measured: 150 bytes, and PostgreSQL refuses to start). The folder is private to
 * the user, named after the store it serves, and removed when the server stops.
 */
export function clusterPaths(store: string): { readonly dataDir: string; readonly socketDir: string } {
  const root = resolve(store);
  const dataDir = join(root, 'pgdata');
  return { dataDir, socketDir: join(tmpdir(), `${SOCKET_FOLDER_PREFIX}${sha256Hex(new TextEncoder().encode(dataDir)).slice(0, 16)}`) };
}

/** Runs one of the server's own programs, refusing by name with what it said. */
function runBinary(program: string, args: readonly string[], options: { readonly allowFailure?: boolean } = {}): { code: number; stdout: string; stderr: string } {
  const answer = spawnSync(program, [...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (answer.error !== undefined) {
    throw new Error(`${program}:1: the server's own program could not run: ${answer.error.message} (src/adapters/postgres-cluster.ts)`);
  }
  const result = { code: answer.status ?? 1, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  if (result.code !== 0 && options.allowFailure !== true) {
    const said = result.stderr.trim().slice(0, 2_000);
    throw new Error(`${program}:1: ${[...args].join(' ')} exited ${String(result.code)}${said === '' ? '' : `: ${said}`} (src/adapters/postgres-cluster.ts)`);
  }
  return result;
}

/** Whether the cluster's server answers a connection, asked over its socket and answered by the server itself. */
async function answering(socketDir: string, database: string = CLUSTER_ADMIN_DATABASE): Promise<boolean> {
  const client = new Client({ host: socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, database, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Runs one statement on a cluster in a connection of its own, for the work that is not a store's. */
export async function clusterQuery<Row extends Record<string, unknown>>(cluster: RunningCluster, database: string, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
  const client = new Client({ host: cluster.socketDir, port: cluster.port, user: cluster.user, database, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const answer = await client.query(sql, [...values]);
    return answer.rows as Row[];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The pid a data directory's `postmaster.pid` names, or null when no line does. */
function holderOf(dataDir: string): number | null {
  try {
    const first = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim() ?? '';
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process that started or adopted this cluster's server, or null when no file says. */
function ownerOf(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dataDir, OWNER_FILE), 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/** How many client backends the server answers besides the one asking: other processes' work. */
async function otherClients(cluster: { socketDir: string }): Promise<number> {
  const rows = await clusterQuery<{ held: string }>(
    { dataDir: cluster.socketDir, socketDir: cluster.socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: false, bin: '', stop: async () => undefined },
    CLUSTER_ADMIN_DATABASE,
    "SELECT count(*)::text AS held FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
  );
  return Number(rows[0]?.held ?? '0');
}

/**
 * A server a killed process left behind: its `postmaster.pid` names a live
 * process that still holds this data directory, so it is waited for and, when
 * it never answers, stopped before this cluster starts its own. A pid that is
 * gone is a line a crash left and is removed; a pid another program took is not
 * touched.
 */
async function reclaimStaleServer(dataDir: string, bin: string, socketDir: string, log: (line: string) => void): Promise<void> {
  const pid = holderOf(dataDir);
  if (pid === null) return;
  if (!alive(pid)) {
    rmSync(join(dataDir, 'postmaster.pid'), { force: true });
    return;
  }
  let mine = true;
  try {
    mine = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes(dataDir);
  } catch {
    mine = true;
  }
  if (!mine) return;
  const deadline = Date.now() + ANSWER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await answering(socketDir)) return;
    await Bun.sleep(100);
  }
  log(`madarch: stopping the PostgreSQL server pid ${String(pid)} a crashed process left holding ${dataDir}`);
  const stopped = runBinary(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  if (stopped.code !== 0) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* it ended between the check and the signal */ }
    const killed = Date.now() + 10_000;
    while (alive(pid) && Date.now() < killed) await Bun.sleep(20);
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      while (alive(pid)) await Bun.sleep(20);
    }
  }
  rmSync(join(dataDir, 'postmaster.pid'), { force: true });
}

/** The socket file a dead server left in the folder is not a server: the new one makes its own. */
function removeSocketFiles(socketDir: string): void {
  for (const name of [`.s.PGSQL.${String(CLUSTER_PORT)}`, `.s.PGSQL.${String(CLUSTER_PORT)}.lock`]) {
    rmSync(join(socketDir, name), { force: true });
  }
}

/** Starts one server on `dataDir`, listening on the socket folder and on no TCP address. */
function startServer(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly log: (line: string) => void }): void {
  const { dataDir, socketDir, bin } = options;
  createDataDir(dataDir, bin, options.log);
  removeSocketFiles(socketDir);
  const logFile = join(dataDir, '..', 'postgres.log');
  writeFileSync(logFile, '', 'utf8');
  runBinary(join(bin, 'pg_ctl'), ['-D', dataDir, '-w', '-l', logFile, '-t', '60', '-o', `-k ${socketDir} -p ${String(CLUSTER_PORT)} -c listen_addresses=`, 'start']);
}

/** Makes the data directory with `initdb` when it holds no cluster yet. */
function createDataDir(dataDir: string, bin: string, log: (line: string) => void): void {
  if (existsSync(join(dataDir, 'PG_VERSION'))) return;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Progress, not a warning: a command whose output a caller reads (a script's, a test's) stays quiet.
  defaultLog.info(`madarch: creating the PostgreSQL data directory ${dataDir}`, { madarch: 'postgres' });
  void log;
  runBinary(join(bin, 'initdb'), ['-D', dataDir, '-U', CLUSTER_USER, '--auth=trust', '-E', 'UTF8', '--locale=C']);
}

/**
 * The clusters this process has open, by data directory: two owners of one store
 * in one process share one server, and the server is stopped when the last of
 * them stops. Without this, the second owner would read the ownership file
 * naming this process, take the server for its own, and stop it under the first
 * owner's pool.
 */
const openInProcess = new Map<string, { cluster: RunningCluster; users: number }>();

/**
 * The stops under way, by data directory: a server being stopped still answers
 * for a moment, so an open that arrives mid-stop must wait for it and then start
 * its own, rather than attaching to a server that is already going away (which
 * answers `57P01`, "terminating connection due to administrator command", on the
 * first statement).
 */
const stoppingInProcess = new Map<string, Promise<void>>();

/** The cluster one caller is given: its stop leaves the server running while another caller still holds it. */
function share(cluster: RunningCluster): RunningCluster {
  const key = cluster.dataDir;
  const held = openInProcess.get(key);
  if (held !== undefined) {
    held.users += 1;
    return { ...cluster, startedIt: cluster.startedIt, stop: async () => await release(key) };
  }
  openInProcess.set(key, { cluster, users: 1 });
  return { ...cluster, startedIt: cluster.startedIt, stop: async () => await release(key) };
}

/** One caller's stop: the server stops when the last caller of it in this process stops. */
async function release(key: string): Promise<void> {
  const held = openInProcess.get(key);
  if (held === undefined) return;
  held.users -= 1;
  if (held.users > 0) return;
  openInProcess.delete(key);
  if (!held.cluster.startedIt) return;
  const stopping = held.cluster.stop().catch(() => undefined);
  stoppingInProcess.set(key, stopping);
  try {
    await stopping;
  } finally {
    stoppingInProcess.delete(key);
  }
}

export interface OpenClusterOptions {
  readonly dataDir: string;
  readonly socketDir: string;
  /** The folder the server's programs are in; the installed pinned build unless a caller names one. */
  readonly bin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

/**
 * Opens a cluster: attaches to the server already answering on its socket,
 * adopts one a killed process left, or starts one. The server listens on its
 * socket folder only.
 */
export async function openCluster(options: OpenClusterOptions): Promise<RunningCluster> {
  refuseRoot();
  // A server this process is stopping still answers for a moment: waiting for
  // the stop to end and then deciding is what keeps a re-opened store from
  // adopting a server that is already going away.
  const stopping = stoppingInProcess.get(resolve(options.dataDir));
  if (stopping !== undefined) await stopping;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => defaultLog.warn(line, { madarch: 'postgres' }));
  const bin = join(options.bin ?? (await ensurePostgresInstalled({ env, progress: (line) => defaultLog.info(line, { madarch: 'postgres' }) })).bin);
  const { dataDir, socketDir } = { dataDir: resolve(options.dataDir), socketDir: resolve(options.socketDir) };
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const noStop = async (): Promise<void> => await Promise.resolve();
  if (await answering(socketDir)) {
    const owner = ownerOf(dataDir);
    if (owner !== null && owner !== process.pid && alive(owner)) {
      return share({ dataDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: false, bin, stop: noStop });
    }
    writeFileSync(join(dataDir, OWNER_FILE), `${String(process.pid)}\n`);
    return share({ dataDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: true, bin, stop: () => stopCluster({ dataDir, socketDir, bin, log }) });
  }
  // A server of this store may be starting, running or stopping in another process at this instant: a store is opened by
  // the fill's worker and by a reader at once, and each of them may be the first. So the decision is taken up to three
  // times — attach if the server answers, wait for a predecessor to let go, start if nothing holds it — and a start that
  // loses the race is retried rather than reported.
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await Bun.sleep(200 * attempt);
    await reclaimStaleServer(dataDir, bin, socketDir, log);
    if (await answering(socketDir)) {
      writeFileSync(join(dataDir, OWNER_FILE), `${String(process.pid)}\n`);
      return share({ dataDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: true, bin, stop: () => stopCluster({ dataDir, socketDir, bin, log }) });
    }
    try {
      startServer({ dataDir, socketDir, bin, log });
    } catch (error) {
      // A predecessor that is still letting go: the next attempt waits for it, then answers or starts.
      failure = error;
      continue;
    }
    if (!(await answering(socketDir))) {
      failure = new Error(`${join(dataDir, '..', 'postgres.log')}:1: the PostgreSQL server started on ${dataDir} but does not answer on ${socketDir}: read that log for what it said (src/adapters/postgres-cluster.ts)`);
      continue;
    }
    writeFileSync(join(dataDir, OWNER_FILE), `${String(process.pid)}\n`);
    return share({ dataDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: true, bin, stop: () => stopCluster({ dataDir, socketDir, bin, log }) });
  }
  if (await answering(socketDir)) {
    writeFileSync(join(dataDir, OWNER_FILE), `${String(process.pid)}\n`);
    return share({ dataDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, startedIt: true, bin, stop: () => stopCluster({ dataDir, socketDir, bin, log }) });
  }
  throw failure;
}

/**
 * Stops a server this process started, unless another process is still
 * connected: then the server keeps answering for that process, and its
 * ownership file is removed so the next process to open the cluster adopts it.
 */
async function stopCluster(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly log: (line: string) => void }): Promise<void> {
  const { dataDir, socketDir, bin } = options;
  if (!(await answering(socketDir))) {
    removeSocketFiles(socketDir);
    rmSync(join(dataDir, OWNER_FILE), { force: true });
    return;
  }
  let others = 0;
  try {
    others = await otherClients({ socketDir });
  } catch {
    others = 0;
  }
  if (others > 0) {
    options.log(`madarch: the PostgreSQL server on ${dataDir} is still answering ${String(others)} connection(s) of another process, so it is left running`);
    rmSync(join(dataDir, OWNER_FILE), { force: true });
    return;
  }
  runBinary(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  removeSocketFiles(socketDir);
  rmSync(join(dataDir, OWNER_FILE), { force: true });
}
