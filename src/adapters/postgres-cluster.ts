/**
 * The PostgreSQL server a store runs on (madarch-8bdc.2.5, items 1 and 3; the roles' one owner, madarch-8bdc.9): one
 * cluster — a data directory, a private Unix socket (Unix) or authenticated loopback TCP (Windows) — started on demand and
 * stopped by the last process of the binary that used it.
 *
 * One cluster holds many databases, so a store, a product's snapshot of it and a
 * source's history are databases of one server rather than servers of their own.
 *
 * ## The rule: one owner across processes
 *
 * Two files beside the data directory hold the rule, and nothing else decides it:
 *
 * - `pgdata.lock` is held exclusively — `flock`, in the kernel, so a killed
 *   process lets go of it — by the process that decides whether to start the
 *   server, for the whole of `initdb` and `pg_ctl start`. A second process waits
 *   for that hold and then finds the server answering, and connects: it never
 *   starts a server of the same store beside the first, and never runs `initdb`
 *   on a data directory another process is writing.
 * - `pgdata.users` is held shared by every process that uses the server, for as
 *   long as it uses it — every open of the cluster, in every role. A process
 *   leaving asks for the file exclusively and only non-blocking: the kernel grants
 *   that only when no other process still holds a shared hold, which is exactly
 *   "no other process of the binary uses this server". The process that gets it
 *   stops the server; one that does not leaves it running.
 *
 * So the last user stops the server, whichever process started it and whichever
 * role it plays: a fill child leaving never stops the server an api process is
 * reading from, and a process whose predecessor was killed adopts the server it
 * left without a second start. Measured before the rule (2026-11-08, this box):
 * four processes opening one fresh store took 5.1-6.4 s, each killing the
 * server another had just started ("stopping the PostgreSQL server pid … a
 * crashed process left holding …"), and eight opens in one process took 13.1 s
 * with five of them failing. CI run 42534535257 (shard 2) had `initdb … exists
 * but is not empty` from two processes starting one store at once, and
 * `Connection terminated unexpectedly` from one process stopping a server
 * another was reading.
 *
 * The waits are polls of `flock` with `LOCK_NB` rather than a blocking call: a
 * blocking `flock` stops the event loop of a server that is only opening a
 * store for one page, which is the 300 ms answer budget a reading role lives
 * under.
 *
 * PostgreSQL refuses to run as root, so an open as root says what to do instead
 * of failing inside initdb.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { log as defaultLog } from '../obs/log.js';
import { sha256Hex } from '../graph/digest.js';
import { ensurePostgresInstalled, refuseRoot } from './postgres-install.js';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { postgresProgram, postgresInstallFolder } from './postgres-builds.js';
import { setPriority } from 'node:os';

/** The port every cluster's socket is named after: nothing listens on TCP, so two clusters never meet. */
export const CLUSTER_PORT = 5_432;

/** The superuser `initdb` makes; a store's server is private to the machine's user and trusts the socket. */
export const CLUSTER_USER = 'postgres';

/** The database a cluster is asked questions in: the one `initdb` makes. */
export const CLUSTER_ADMIN_DATABASE = 'postgres';

/** How long a cluster is given to answer after its `postmaster.pid` names a live process, before it is stopped. */
const ANSWER_WAIT_MS = 5_000;

/** The lock one process holds while it decides whether to start the server, from `initdb` to `pg_ctl start`, beside the data directory. */
const START_LOCK_FILE = 'pgdata.lock';

/** The lock every process using the server holds shared, beside the data directory: its exclusive hold is "no other process uses it". */
const USERS_LOCK_FILE = 'pgdata.users';

/** How often a lock that is held by another process is asked for again: 20 ms, so an open that waits a start costs almost nothing. */
const LOCK_POLL_MS = 20;

/** How long an open waits for a server another process is starting: `initdb` and a `pg_ctl start` with its own 60 s bound, and room on a loaded machine. */
const START_LOCK_WAIT_MS = 120_000;

/** How long an open waits for a server another process is stopping: a `pg_ctl stop -w` is bounded by 60 s. */
const USERS_LOCK_WAIT_MS = 90_000;

/** A cluster whose server answers, and what may be done with it. */
export interface RunningCluster {
  /** The data directory the server holds. */
  readonly dataDir: string;
  /** The socket folder on Unix; the data directory containing the TCP endpoint record on Windows. */
  readonly socketDir: string;
  readonly port: number;
  readonly user: string;
  /** The folder the server's programs are in. */
  readonly bin: string;
  /**
   * Stops using the server: the last process holding it stops it, and one that still shares it with another leaves it
   * running. Every open must be given back exactly once with this call.
   */
  stop(): Promise<void>;
}

/**
 * The data directory of a store (`<store>/pgdata`) and the socket folder its server listens in.
 *
 * A Unix socket path is limited to about a hundred bytes (measured: `pg_ctl start` failed with a 150-byte
 * `<products home>/.madarch/knowledge/<id>/graph/pgsock/.s.PGSQL.5432`), and a store's path is long. The socket folder
 * is therefore a short one: `.pgsock/<16 hex of the data directory>` in the deepest folder above the store whose path
 * still fits — inside the run's own scratch for a test's store, beside the store in a product's state.
 *
 * It is computed from the data directory and **nothing else**: not from the process's temporary folder, which a child
 * process may not have (`Bun.spawn` without `env:` starts it with the environment the run started with, where a
 * preload's `TMPDIR` is not), and not from anything a second process could compute differently. Two processes opening
 * one store must name one socket, or they start two servers of it; and a folder a run makes must be one its own sweep
 * takes away.
 */
export function clusterPaths(store: string): { readonly dataDir: string; readonly socketDir: string } {
  const dataDir = join(resolve(store), 'pgdata');
  return { dataDir, socketDir: process.platform === 'win32' ? dataDir : socketFolderFor(dataDir) };
}

/**
 * The longest folder a socket goes in, in bytes: the kernel's `sun_path` is 107 bytes for the whole path, and the
 * server's own file name adds `.s.PGSQL.5432` (14 bytes) — measured: a 95-byte folder made `pg_ctl start` fail.
 */
const SOCKET_PATH_LIMIT = 90;

/** The folder the socket of one data directory lives in, in code-point order of the stores it serves. */
const SOCKET_FOLDER = '.pgsock';

/** The socket folder of one data directory: the deepest folder above it whose `.pgsock/<hash>` path still fits. */
function socketFolderFor(dataDir: string): string {
  const hash = sha256Hex(new TextEncoder().encode(dataDir)).slice(0, 16);
  for (let folder = dataDir; ;) {
    const parent = dirname(folder);
    if (parent === '/' || parent === folder) break;
    const attempt = join(parent, SOCKET_FOLDER, hash);
    if (Buffer.byteLength(attempt) <= SOCKET_PATH_LIMIT) return attempt;
    folder = parent;
  }
  // Nothing above the store is short enough (a store under a very deep path): the system's temporary folder, whose
  // sockets the run-sweep of a test and the reclaim of a stale server remove like any other.
  return join(tmpdir(), `madarch-pg-${hash}`);
}

/** Runs one of the server's own programs, refusing by name with what it said. */
function runBinary(program: string, args: readonly string[], options: { readonly allowFailure?: boolean; readonly stdio?: 'ignore' | 'pipe' } = {}): { code: number; stdout: string; stderr: string } {
  const answer = spawnSync(program, [...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, LC_ALL: 'C' }, ...(options.stdio === undefined ? {} : { stdio: options.stdio }) });
  if (answer.error !== undefined) {
    throw new Error(`${program}:1: the server's own program could not run: ${answer.error.message} (src/adapters/postgres-cluster.ts)`);
  }
  const result = { code: answer.status ?? 1, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  if (result.code !== 0 && options.allowFailure !== true) {
    const said = result.stderr.trim();
    throw new Error(`${program}:1: ${[...args].join(' ')} exited ${String(result.code)}${said === '' ? '' : `: ${said}`} (src/adapters/postgres-cluster.ts)`);
  }
  return result;
}

/** Windows uses loopback TCP; postmaster.pid is the server's own record of its port (line 4). */
export function clusterEndpoint(socketDir: string): { host: string; port: number; password?: string } {
  if (process.platform !== 'win32') return { host: socketDir, port: CLUSTER_PORT };
  let port = 0;
  try { port = Number(readFileSync(join(socketDir, 'postmaster.pid'), 'utf8').split('\n')[3]?.trim()); } catch { /* not started */ }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${join(socketDir, 'postmaster.pid')}:4: no running PostgreSQL TCP port`);
  return { host: '127.0.0.1', port, password: readFileSync(join(socketDir, '..', 'postgres.password'), 'utf8').trim() };
}

/** Lets the OS choose an unused loopback port. pg_ctl reports a bind race as a failure, never another store. */
async function freeTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (address === null || typeof address === 'string') { listener.close(); reject(new Error('no TCP port allocated')); return; }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/** Whether the cluster's server answers a connection, asked over its socket and answered by the server itself. */
async function answering(socketDir: string, database: string = CLUSTER_ADMIN_DATABASE): Promise<boolean> {
  let client: Client | undefined;
  try {
    client = new Client({ ...clusterEndpoint(socketDir), user: CLUSTER_USER, database, connectionTimeoutMillis: 2_000 });
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** Runs one statement on a cluster in a connection of its own, for the work that is not a store's. */
export async function clusterQuery<Row extends Record<string, unknown>>(cluster: RunningCluster, database: string, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
  const client = new Client({ ...(process.platform === 'win32' ? clusterEndpoint(cluster.socketDir) : { host: cluster.socketDir, port: cluster.port }), user: cluster.user, database, connectionTimeoutMillis: 5_000 });
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

/** The lock a cluster's start is serialized by, beside its data directory. */
function startLockPath(dataDir: string): string {
  return join(dirname(dataDir), START_LOCK_FILE);
}

/** The lock every process using a cluster's server holds shared, beside its data directory. */
function usersLockPath(dataDir: string): string {
  return join(dirname(dataDir), USERS_LOCK_FILE);
}

/** The kernel's shared, exclusive and non-blocking `flock` modes. */
const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/**
 * `flock` from the system's C library: Bun's file API has no lock, and a lock the kernel holds is released when a
 * process is killed, which is what makes "no process uses this server" true even after a crash. Linux and macOS
 * spell the library differently; Windows uses native byte-range locks below. A platform with no pinned build refuses
 * in `ensurePostgresInstalled` before a lock is asked for.
 *
 * The library is loaded when the first lock is asked for, never at the module's import: `scripts/build-binary.ts`
 * imports this module to build the binary, and Bun resolves a `dlopen` at import time for the target it builds —
 * `bun scripts/build-binary.ts --os windows` failed there with `Failed to open library "libc.so.6": error code 126,
 * ERR_DLOPEN_FAILED` (CI run for ddaefd9b, clean install walks / windows-x64). The platform's name is computed rather
 * than written beside `dlopen`, for the same reason.
 */
let flockSymbol: ((descriptor: number, operation: number) => number) | undefined;

/** Native handles are opened directly: Bun descriptors are not CRT descriptors or Win32 HANDLEs. */
const windowsHandles = new Map<number, Pointer>();
let windowsApi: ReturnType<typeof loadWindowsLocks> | undefined;
function loadWindowsLocks() {
  return dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    LockFileEx: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UnlockFileEx: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

/** Every lock file has a normal descriptor on Unix and its own non-inherited HANDLE on Windows. */
function openLock(path: string): number {
  const fd = openSync(path, 'a+');
  if (process.platform !== 'win32') return fd;
  windowsApi ??= loadWindowsLocks();
  const name = Buffer.from(`${path}\0`, 'utf16le');
  // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | WRITE | DELETE, OPEN_ALWAYS.
  const handle = windowsApi.CreateFileW(ptr(name), 0xc0000000, 7, null, 4, 0, null);
  if (handle === null || Number(handle) === -1 || Number(handle) === 0xffffffffffffffff) {
    closeSync(fd);
    throw new Error(`${path}:1: CreateFileW failed: Win32 error ${windowsApi.GetLastError()}`);
  }
  windowsHandles.set(fd, handle as Pointer);
  return fd;
}

function closeLock(fd: number): void {
  const handle = windowsHandles.get(fd);
  if (handle !== undefined) { windowsApi!.CloseHandle(handle); windowsHandles.delete(fd); }
  windowsHeld.delete(fd);
  closeSync(fd);
}

const windowsHeld = new Map<number, { mode: number; overlapped: Buffer }>();
function windowsFlock(descriptor: number, operation: number): number {
  const handle = windowsHandles.get(descriptor);
  if (handle === undefined || windowsApi === undefined) throw new Error(`src/adapters/postgres-cluster.ts:1: no Windows lock handle for ${descriptor}`);
  const held = windowsHeld.get(descriptor);
  const mode = operation & ~LOCK_NB;
  if (held?.mode === mode) return 0;
  // A conversion gives up the shared hold before asking exclusively, just as flock does.
  if (held !== undefined) {
    if (windowsApi.UnlockFileEx(handle, 0, 1, 0, ptr(held.overlapped)) === 0) throw new Error(`src/adapters/postgres-cluster.ts:1: UnlockFileEx failed: Win32 error ${windowsApi.GetLastError()}`);
    windowsHeld.delete(descriptor);
  }
  if (mode === LOCK_UN) return 0;
  const overlapped = Buffer.alloc(32);
  if (windowsApi.LockFileEx(handle, 1 | (mode === LOCK_EX ? 2 : 0), 0, 1, 0, ptr(overlapped)) !== 0) {
    windowsHeld.set(descriptor, { mode, overlapped });
    return 0;
  }
  const error = windowsApi.GetLastError();
  if (error === 33) return -1; // ERROR_LOCK_VIOLATION: another process holds the range.
  throw new Error(`src/adapters/postgres-cluster.ts:1: LockFileEx failed for descriptor ${descriptor}: Win32 error ${error}`);
}

/** `flock(2)` for this platform, loaded once: the descriptor-and-mode call every hold and release goes through. */
function flock(descriptor: number, operation: number): number {
  if (process.platform === 'win32') return windowsFlock(descriptor, operation);
  if (flockSymbol === undefined) {
    const library = process.platform === 'darwin' ? 'libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : undefined;
    if (library === undefined) {
      throw new Error(`${String(process.platform)}:1: a store's PostgreSQL cluster is guarded by flock(2), which this platform's C library is not asked for: this platform has neither Unix flock nor the Windows byte-range lock adapter, so a store never opens here (src/adapters/postgres-cluster.ts)`);
    }
    flockSymbol = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
  }
  return flockSymbol(descriptor, operation);
}

/**
 * Holds one of the two locks a cluster has, waiting for another process to let go of it: asked for every 20 ms without
 * blocking the event loop, because the process waiting may be a server answering pages. A lock file that cannot be
 * opened answers at once; a lock another process still holds at the deadline is an error naming the file, so a stuck
 * start or stop is never a silent wait. The descriptor it answers is the hold.
 */
async function holdLock(path: string, mode: number, wait: { readonly what: string; readonly deadlineMs: number }): Promise<number> {
  const fd = openLock(path);
  const deadline = Date.now() + wait.deadlineMs;
  for (;;) {
    try { if (flock(fd, mode | LOCK_NB) === 0) return fd; }
    catch (error) { closeLock(fd); throw new Error(`${path}:1: ${String(error)}`); }
    if (Date.now() >= deadline) {
      closeLock(fd);
      throw new Error(`${path}:1: ${wait.what} waited ${String(wait.deadlineMs)} ms and the lock is still held: another process of madarch is using ${dirname(path)}, and it is either still starting or still stopping that store's PostgreSQL server (src/adapters/postgres-cluster.ts)`);
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

/** Gives a lock back: the kernel releases it here or when the process ends, whichever comes first. */
function releaseLock(fd: number): void {
  try {
    flock(fd, LOCK_UN);
  } catch {
    // A descriptor the system already closed holds no lock: nothing is left to give back.
  }
  closeLock(fd);
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
  const stopped = runBinary(join(bin, postgresProgram('pg_ctl')), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  if (stopped.code !== 0) {
    if (process.platform === 'win32') throw new Error(`${dataDir}:1: pg_ctl could not reclaim the server: ${stopped.stderr}; refusing to kill an unverified Windows PID ${pid}`);
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

/**
 * The niceness a store's server runs at (madarch-8bdc.2.5): a store's server is background work, and the process that
 * answers pages must never lose a core to it. Measured on a runner with one of two cores busy, the answers of a
 * publication waited 266-338 ms across unrelated endpoints (CI run 42505805264) while the fill's writes ran on the same
 * cores as the server.
 */
const SERVER_PRIORITY = 10;

/** Windows postmasters inherit pg_ctl's handles: a parent pipe would remain open for the server's lifetime. */
export function clusterStartInvocation(dataDir: string, logFile: string, connection: string, platform: NodeJS.Platform = process.platform): { args: string[]; stdio: 'ignore' | 'pipe' } {
  return {
    args: ['-D', dataDir, platform === 'win32' ? '-W' : '-w', '-l', logFile, '-t', '60', '-o', connection, 'start'],
    stdio: platform === 'win32' ? 'ignore' : 'pipe',
  };
}

/** Starts one private server: Unix socket on Unix, authenticated loopback TCP on Windows. */
async function startServer(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly log: (line: string) => void }): Promise<void> {
  const { dataDir, socketDir, bin } = options;
  createDataDir(dataDir, bin, options.log);
  removeSocketFiles(socketDir);
  const logFile = join(dataDir, '..', 'postgres.log');
  writeFileSync(logFile, '', 'utf8');
  const connection = process.platform === 'win32'
    ? `-h 127.0.0.1 -p ${String(await freeTcpPort())} -c unix_socket_directories=`
    : `-k "${socketDir}" -p ${String(CLUSTER_PORT)} -c listen_addresses=`;
  const started = performance.now();
  try {
    const invocation = clusterStartInvocation(dataDir, logFile, connection);
    runBinary(join(bin, postgresProgram('pg_ctl')), invocation.args, { stdio: invocation.stdio });
    if (process.platform === 'win32') {
      // Replace pg_ctl's existing 60-second wait with an authenticated connection, not inherited output handles.
      const deadline = Date.now() + 60_000;
      while (!(await answering(socketDir))) {
        if (Date.now() >= deadline) throw new Error(`the PostgreSQL server did not answer on ${socketDir} within 60 seconds`);
        await Bun.sleep(100);
      }
    }
  } catch (error) {
    throw new Error(`${logFile}:1: PostgreSQL startup failed: ${String(error)}\n${readFileSync(logFile, 'utf8')}`);
  } finally {
    if (process.env.MADARCH_STARTUP_TIMING === '1') console.error(`postgres.start ${(performance.now() - started).toFixed(1)} ms`);
  }
  lowerPriorityOf(dataDir);
}

/** A server already running (a predecessor started it) is lowered too: it serves one store, whose pages the answers hold. */
function lowerPriorityOf(dataDir: string): void {
  const pid = holderOf(dataDir);
  if (pid === null) return;
  try { setPriority(pid, SERVER_PRIORITY); } catch { /* the platform refuses: the server keeps the priority it has */ }
}

/** Makes the data directory with `initdb` when it holds no cluster yet. */
function createDataDir(dataDir: string, bin: string, log: (line: string) => void): void {
  if (existsSync(join(dataDir, 'PG_VERSION'))) return;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Progress, not a warning: a command whose output a caller reads (a script's, a test's) stays quiet.
  defaultLog.info(`madarch: creating the PostgreSQL data directory ${dataDir}`, { madarch: 'postgres' });
  void log;
  const authentication = ['--auth=trust'];
  if (process.platform === 'win32') {
    // TCP must not trust every local account as a superuser. The store's private credential is shared by its roles.
    const passwordFile = join(dataDir, '..', 'postgres.password');
    if (!existsSync(passwordFile)) writeFileSync(passwordFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    authentication.splice(0, 1, '--auth=scram-sha-256', `--pwfile=${passwordFile}`);
  }
  const started = performance.now();
  try {
    runBinary(join(bin, postgresProgram('initdb')), ['-D', dataDir, '-U', CLUSTER_USER, ...authentication, '-E', 'UTF8', '--locale=C']);
  } finally {
    if (process.env.MADARCH_STARTUP_TIMING === '1') console.error(`postgres.initdb ${(performance.now() - started).toFixed(1)} ms`);
  }
}

/**
 * One open, by data directory: callers that arrive while it runs wait for it, and callers that arrive while the cluster
 * is open share it, so this process runs one server of a store and one start of it, however many owners of it ask at
 * once (measured before: eight opens of one store at once started eight servers, five of them failed, and it took 13.1 s).
 */
const openInProcess = new Map<string, Promise<HeldCluster>>();

/**
 * The user locks this process holds, by data directory: the descriptor each open keeps, so a process that is ending can
 * give its holds back without waiting for the owners that hold them (`stopStoreForExit`).
 */
const userLocks = new Map<string, Set<number>>();

/** The cluster one open made, and how many callers in this process hold it. */
interface HeldCluster {
  readonly cluster: RunningCluster;
  users: number;
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
 * adopts one a killed predecessor left, or starts one under the start lock. The server listens on its socket folder only.
 *
 * The cluster this answers is one caller's hold of it: its `stop` gives that hold back, and the server is stopped when
 * the last hold of it in this process is given back and no other process holds one.
 */
export async function openCluster(options: OpenClusterOptions): Promise<RunningCluster> {
  refuseRoot();
  const key = resolve(options.dataDir);
  let opened = openInProcess.get(key);
  if (opened === undefined) {
    opened = openOnce(key, options).then((cluster) => ({ cluster, users: 0 }));
    openInProcess.set(key, opened);
    // An open that failed is not kept: the next caller tries again instead of being handed the same failure for ever.
    void opened.catch(() => { if (openInProcess.get(key) === opened) openInProcess.delete(key); });
  }
  const held = await opened;
  held.users += 1;
  const { cluster } = held;
  return {
    dataDir: cluster.dataDir, socketDir: cluster.socketDir, port: cluster.port, user: cluster.user, bin: cluster.bin,
    stop: async () => await releaseCluster(key),
  };
}

/** One caller's stop: the server is given up when the last caller holding it in this process stops. */
async function releaseCluster(key: string): Promise<void> {
  const opened = openInProcess.get(key);
  if (opened === undefined) return;
  const held = await opened.catch(() => undefined);
  if (held === undefined) return;
  held.users -= 1;
  if (held.users > 0) return;
  openInProcess.delete(key);
  await held.cluster.stop();
}

/**
 * Whether this process has said it is stopping: a process that is ending starts no server, so a role whose server was
 * killed does not spend the wait for its exit on an `initdb` — the start is synchronous, and the stop cannot run until it
 * returns (madarch-8bdc.12: a daemon's stop waited its whole two seconds on a role doing one).
 */
let startsRefused = false;

/** Refuses every server start from now on, for a process that is ending. */
export function refuseStarts(): void {
  startsRefused = true;
}

/** The open itself, under the two locks that two processes share a store's server by. */
async function openOnce(dataDir: string, options: OpenClusterOptions): Promise<RunningCluster> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => defaultLog.warn(line, { madarch: 'postgres' }));
  const bin = join(options.bin ?? (await ensurePostgresInstalled({ env, progress: (line) => defaultLog.info(line, { madarch: 'postgres' }) })).bin);
  const socketDir = resolve(options.socketDir);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // The use of the server is held before anything else: a stop another process is making ends first, so the server this
  // open finds or starts is never one a leaving process is about to stop.
  const users = await holdLock(usersLockPath(dataDir), LOCK_SH, { what: `the use of the PostgreSQL server on ${dataDir}`, deadlineMs: USERS_LOCK_WAIT_MS });
  const holds = userLocks.get(dataDir) ?? new Set<number>();
  holds.add(users);
  userLocks.set(dataDir, holds);
  try {
    // The start's own hold: one process decides whether a server is needed, runs `initdb` and starts it, and the next
    // process finds it answering and connects to it instead of starting a second server of the same store.
    const start = await holdLock(startLockPath(dataDir), LOCK_EX, { what: `the start of the PostgreSQL server on ${dataDir}`, deadlineMs: START_LOCK_WAIT_MS });
    try {
      if (await answering(socketDir)) {
        // A server another process started, or a predecessor left: it serves this store, so it is lowered too.
        lowerPriorityOf(dataDir);
      } else {
        if (startsRefused) throw new Error(`${dataDir}:1: this process is stopping, so the store's PostgreSQL server is not started for it (src/adapters/postgres-cluster.ts)`);
        await reclaimStaleServer(dataDir, bin, socketDir, log);
        await startServer({ dataDir, socketDir, bin, log });
        if (!(await answering(socketDir))) {
          throw new Error(`${join(dataDir, '..', 'postgres.log')}:1: the PostgreSQL server started on ${dataDir} does not answer on ${socketDir}: read that log for what it said (src/adapters/postgres-cluster.ts)`);
        }
      }
    } finally {
      releaseLock(start);
    }
  } catch (error) {
    releaseLock(users);
    throw error;
  }
  return {
    dataDir, socketDir, port: clusterEndpoint(socketDir).port, user: CLUSTER_USER, bin,
    stop: async () => await stopCluster({ dataDir, socketDir, bin, users }),
  };
}

/**
 * Stops a store's server for a process that is ending (madarch-8bdc.12): every hold this process still has on the store is
 * given back first — a pool whose close is still waiting for a client inside a transaction must not keep the server up
 * behind the process — then the exclusive hold is asked for, which the kernel grants only when no other process of the
 * binary uses the server, and the server is stopped under it. A store another process still uses is left alone.
 *
 * This is the last resort of a process nothing waits for any more: the ordinary stop is every owner's `stop`, which walks
 * the holds one at a time. The store's own programs are found as an ordinary open finds them, and a server that does not
 * answer is no server to stop.
 */
export async function stopStoreForExit(store: string, options: { readonly force?: boolean } = {}): Promise<void> {
  const { dataDir, socketDir } = clusterPaths(store);
  const key = resolve(dataDir);
  // A process that is ending (`force`) drops the holds it still has, its own owners included, and stops the server: nothing
  // in it reads the store again. A role giving its stores up inside a process that goes on living leaves a store another
  // owner of this process still uses alone — that owner's `stop` decides, and it stops the server when it is the last.
  if (options.force !== true) {
    const opening = openInProcess.get(key);
    const heldByProcess = opening === undefined ? undefined : await opening.catch(() => undefined);
    if (heldByProcess !== undefined && heldByProcess.users > 0) return;
  }
  for (const descriptor of userLocks.get(key) ?? []) releaseLock(descriptor);
  userLocks.delete(key);
  openInProcess.delete(key);
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  const users = openLock(usersLockPath(key));
  try {
    if (flock(users, LOCK_EX | LOCK_NB) !== 0) return;
    // The programs of the install that is here, and never an install: `ensurePostgresInstalled` downloads one when the
    // caller's home holds none, and a role ending in a home that never ran a server would wait for that download before it
    // stopped anything (measured: a daemon's role held a server's stop for its whole two-second wait this way). No
    // `pg_ctl` means no server of this install runs, so there is nothing to stop.
    const bin = join(postgresInstallFolder(process.env), 'bin');
    if (!existsSync(join(bin, postgresProgram('pg_ctl')))) return;
    // No question is asked of the server first either: `pg_ctl stop` answers "not running" for a server that is gone, and a
    // connection this process tried to open before it (up to its own two-second bound) is time the store's death may not
    // spend (madarch-8bdc.12).
    // A shutdown checkpoint can wait on disk I/O. Keep the event loop free so the ending role's deadline can fire.
    const stopping = Bun.spawn([join(bin, postgresProgram('pg_ctl')), '-D', key, '-m', 'fast', '-w', 'stop'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 90_000,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const code = await stopping.exited;
    // The socket files go only once the server stopped: a stop that failed leaves a server that still answers, and taking
    // its socket away would make it look gone.
    if (code === 0) removeSocketFiles(socketDir);
  } finally {
    releaseLock(users);
  }
}

/**
 * Gives up this process's use of a server. It is stopped only when no other process of the binary still holds it, which
 * the kernel answers through the users lock: the exclusive hold is granted only when no shared hold is left. A server
 * another process still uses is left running — the api role's server is never stopped by a fill child that finished
 * between two of its runs — and the next process to open the cluster finds it answering and holds it.
 */
async function stopCluster(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly users: number }): Promise<void> {
  const { dataDir, socketDir, bin, users } = options;
  userLocks.get(dataDir)?.delete(users);
  if (flock(users, LOCK_EX | LOCK_NB) !== 0) {
    // The kernel took this process's shared hold away to try, and gave the exclusive one to nobody: another process
    // holds the server (or is asking for it), so it keeps answering and this hold is simply given back. This is the
    // ordinary case of a fill child leaving between two of an api process's reads, so it is not a warning.
    releaseLock(users);
    return;
  }
  try {
    if (await answering(socketDir)) {
      runBinary(join(bin, postgresProgram('pg_ctl')), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
    }
    removeSocketFiles(socketDir);
  } finally {
    releaseLock(users);
  }
}
