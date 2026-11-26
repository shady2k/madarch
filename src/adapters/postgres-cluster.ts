import { sanitizedStartupEnv } from '../obs/startup-context.js';
import { startupBegin, type StartupEvidence, type StartupOutcome } from '../obs/log.js';
import { startupEnabled } from '../obs/startup-context.js';
import { processStartTicks } from '../obs/startup-platform.js';
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
import { withSpanSync, withSpan } from '../obs/trace.js';
import { constants, fstatSync, readSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { log as defaultLog } from '../obs/log.js';
import { sha256Hex } from '../graph/digest.js';
import { ensurePostgresInstalled, refuseRoot } from './postgres-install.js';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { postgresProgram, postgresInstallFolder } from './postgres-builds.js';
import { commandLineArguments } from './postgres-preparation-record.js';
import { setPriority } from 'node:os';
import { runningVersion } from '../product/version.js';
import { namesAnAttempt, newPreparationId, preparedRecordPath, preparingRecordPath, runsOnDataDir, type PreparingRecord } from './postgres-preparation-record.js';

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
function runBinary(program: string, args: readonly string[], options: { readonly allowFailure?: boolean; readonly stdio?: 'ignore' | 'pipe'; readonly observed?: (evidence: StartupEvidence) => void } = {}): { code: number; stdout: string; stderr: string } {
  const answer = withSpanSync('process.run', { 'process.command': program, 'process.args': [...args] }, (span) => {
    const answer = spawnSync(program, [...args], { encoding: 'utf8', timeout: 90_000, env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C' }), ...(options.stdio === undefined ? {} : { stdio: options.stdio }) });
    span.setAttribute('process.exit_code', answer.status ?? -1);
    span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
    span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
    return answer;
  });
  options.observed?.({ command: answer.error !== undefined ? ((answer.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'launch-error') : answer.signal !== null ? 'signal' : 'exit', ...(answer.status === null ? {} : { code: answer.status }) });
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
  try { port = Number(withSpanSync('fs.read', { 'file.path': join(socketDir, 'postmaster.pid') }, (span) => {
    const held = readFileSync(join(socketDir, 'postmaster.pid'), 'utf8');
    span.setAttribute('file.bytes', Buffer.byteLength(held));
    return held;
  }).split('\n')[3]?.trim()); } catch { /* not started */ }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${join(socketDir, 'postmaster.pid')}:4: no running PostgreSQL TCP port`);
  return { host: '127.0.0.1', port, password: withSpanSync('fs.read', { 'file.path': join(socketDir, '..', 'postgres.password') }, (span) => {
    const held = readFileSync(join(socketDir, '..', 'postgres.password'), 'utf8');
    span.setAttribute('file.bytes', Buffer.byteLength(held));
    return held;
  }).trim() };
}

/** Lets the OS choose an unused loopback port. pg_ctl reports a bind race as a failure, never another store. */
async function freeTcpPort(): Promise<number> {
  return await withSpan('net.listen', { 'net.host': '127.0.0.1', 'net.port': 0 }, async () => {
    return await new Promise((resolve, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (address === null || typeof address === 'string') { listener.close(); reject(new Error('no TCP port allocated')); return; }
        listener.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  });
}

/** Why a connection to the cluster's server did not answer: undefined when it answered, else the client's own words. */
async function answerFailure(socketDir: string, database: string = CLUSTER_ADMIN_DATABASE): Promise<string | undefined> {
  let client: Client | undefined;
  // A server that ends the connection after authentication makes the client reject the pending query and emit `error`
  // as well; an `error` event with no listener is thrown from a socket callback and would end the process serving the
  // graph instead of answering a readiness failure (madarch-64o5.81 review). The last word the client said wins.
  let said: string | undefined;
  try {
    client = new Client({ ...clusterEndpoint(socketDir), user: CLUSTER_USER, database, connectionTimeoutMillis: 2_000 });
    client.on('error', (error: Error) => { said = error.message; });
    await withSpan('db.connect', { 'db.system': 'postgres', 'net.host': socketDir }, async () => await client!.connect());
    await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('SELECT 1') }, async (span) => {
      const answer = await client!.query('SELECT 1');
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    return undefined;
  } catch (error) {
    return said ?? (error instanceof Error ? error.message : String(error));
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** Whether the cluster's server answers a connection, asked over its socket and answered by the server itself. */
async function answering(socketDir: string, database: string = CLUSTER_ADMIN_DATABASE): Promise<boolean> {
  return await answerFailure(socketDir, database) === undefined;
}

/** How long a store waits for its server to answer, and how often a wait still under way says so. */
const READINESS_BOUND_MS = 60_000;
const READINESS_SAY_EVERY_MS = 5_000;

/**
 * Waits for the server on a store to answer, saying every few seconds what it waits for and refusing with the last
 * attempt's own words: a wait that says nothing is a server a person reads as hung (madarch-64o5.81 — a clean-install
 * walk saw 60 s of silence from `madarch serve` and reported that it printed no address). The probe is a caller's to
 * name, so the wait can be shown without a server; a store's own wait probes its cluster's admin database.
 */
export async function awaitServerAnswering(options: {
  readonly dataDir: string;
  readonly socketDir: string;
  readonly boundMs?: number;
  readonly probe?: (socketDir: string) => Promise<string | undefined>;
  readonly say?: (line: string) => void;
}): Promise<void> {
  const boundMs = options.boundMs ?? READINESS_BOUND_MS;
  const probe = options.probe ?? ((socketDir: string) => answerFailure(socketDir));
  const say = options.say ?? ((line: string) => console.error(line));
  const started = Date.now();
  let nextSay = 0;
  for (;;) {
    const failing = await probe(options.socketDir);
    if (failing === undefined) return;
    const elapsed = Date.now() - started;
    if (elapsed >= boundMs) {
      throw new Error(`the PostgreSQL server on ${options.dataDir} did not answer on ${options.socketDir} within ${String(Math.round(boundMs / 1_000))} seconds; the last attempt said: ${failing}`);
    }
    if (elapsed >= nextSay) {
      say(`madarch: waiting for PostgreSQL on ${options.dataDir}, ${String(Math.round(elapsed / 1_000))} s of ${String(Math.round(boundMs / 1_000))}`);
      nextSay = elapsed + READINESS_SAY_EVERY_MS;
    }
    await Bun.sleep(100);
  }
}

/** Runs one statement on a cluster in a connection of its own, for the work that is not a store's. */
export async function clusterQuery<Row extends Record<string, unknown>>(cluster: RunningCluster, database: string, sql: string, values: readonly unknown[] = []): Promise<Row[]> {
  const client = new Client({ ...(process.platform === 'win32' ? clusterEndpoint(cluster.socketDir) : { host: cluster.socketDir, port: cluster.port }), user: cluster.user, database, connectionTimeoutMillis: 5_000 });
  client.on('error', (error: Error) => console.error(`PostgreSQL cluster client "${cluster.dataDir}/${database}": ${error.message}`));
  try {
    await withSpan('db.connect', { 'db.system': 'postgres', 'net.host': cluster.socketDir }, async () => await client.connect());
    const answer = await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength(sql) }, async (span) => {
      const answer = await client.query(sql, [...values]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    return answer.rows as Row[];
  } catch (error) {
    if (error instanceof Error) { error.message = `PostgreSQL cluster "${cluster.dataDir}/${database}": ${error.message}`; throw error; }
    throw new Error(`PostgreSQL cluster "${cluster.dataDir}/${database}": ${String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The pid a data directory's `postmaster.pid` names, or null when no line does. */
function holderOf(dataDir: string): number | null {
  try {
    const first = withSpanSync('fs.read', { 'file.path': join(dataDir, 'postmaster.pid') }, (span) => {
      const held = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    }).split('\n')[0]?.trim() ?? '';
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
  const terminal = startupBegin(path.endsWith(USERS_LOCK_FILE) ? 'cluster.lock.users' : 'cluster.lock.start', join(dirname(path), 'pgdata'));
  try {
    const fd = openLock(path);
    const deadline = Date.now() + wait.deadlineMs;
    for (;;) {
      try { if (flock(fd, mode | LOCK_NB) === 0) { terminal('acquired'); return fd; } }
      catch (error) { closeLock(fd); throw new Error(`${path}:1: ${String(error)}`); }
      if (Date.now() >= deadline) {
        closeLock(fd);
        terminal('busy');
        throw new Error(`${path}:1: ${wait.what} waited ${String(wait.deadlineMs)} ms and the lock is still held: another process of madarch is using ${dirname(path)}, and it is either still starting or still stopping that store's PostgreSQL server (src/adapters/postgres-cluster.ts)`);
      }
      await Bun.sleep(LOCK_POLL_MS);
  }
  } catch (error) { terminal('error'); throw error; }
}
/** One nonblocking lock attempt; descriptor zero is a valid hold. */
function tryClusterLock(fd: number, dataDir: string, kind: 'users' | 'start'): number {
  const terminal = startupBegin(`cluster.lock.${kind}`, dataDir);
  try {
    const result = flock(fd, LOCK_EX | LOCK_NB);
    terminal(result === 0 ? 'acquired' : 'busy');
    return result;
  } catch (error) { terminal('error'); throw error; }
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
    withSpanSync('fs.remove', { 'file.path': join(dataDir, 'postmaster.pid') }, () => rmSync(join(dataDir, 'postmaster.pid'), { force: true }));
    return;
  }
  let mine = true;
  try {
    mine = withSpanSync('fs.read', { 'file.path': `/proc/${String(pid)}/cmdline` }, (span) => {
      const held = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    }).includes(dataDir);
  } catch {
    mine = true;
  }
  if (!mine) return;
  const deadline = Date.now() + ANSWER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await answering(socketDir)) return;
    await Bun.sleep(100);
  }
  const stop = beginStop(dataDir);
  stop.sample();
  stop.probe('failed');
  try {
  log(`madarch: stopping the PostgreSQL server pid ${String(pid)} a crashed process left holding ${dataDir}`);
  stop.command('launch-error');
  const commandTerminal = startupBegin('cluster.stop.command', dataDir);
  let stopped: ReturnType<typeof runBinary>;
  try {
    stopped = runBinary(join(bin, postgresProgram('pg_ctl')), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true, observed: evidence => {
      stop.command(evidence.command!, evidence.code);
      commandTerminal(evidence.command === 'exit' && evidence.code === 0 ? 'ok' : 'error', evidence);
    } });
  } catch (error) { commandTerminal('error', { command: 'launch-error' }); throw error; }
  if (stopped.code !== 0) {
    if (process.platform === 'win32') throw new Error(`${dataDir}:1: pg_ctl could not reclaim the server: ${stopped.stderr}; refusing to kill an unverified Windows PID ${pid}`);
    stop.signal('term');
    try { process.kill(pid, 'SIGTERM'); } catch { /* it ended between the check and the signal */ }
    const killed = Date.now() + 10_000;
    while (alive(pid) && Date.now() < killed) await Bun.sleep(20);
    if (alive(pid)) {
      stop.signal('kill');
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      while (alive(pid)) await Bun.sleep(20);
    }
  }
  stop.finish();
  withSpanSync('fs.remove', { 'file.path': join(dataDir, 'postmaster.pid') }, () => rmSync(join(dataDir, 'postmaster.pid'), { force: true }));
  } finally { stop.finish(); }
}

/** The socket file a dead server left in the folder is not a server: the new one makes its own. */
function removeSocketFiles(socketDir: string): void {
  return withSpanSync('postgres.remove_sockets', { 'file.path': socketDir, 'postgres.files': 2 }, () => {
    for (const name of [`.s.PGSQL.${String(CLUSTER_PORT)}`, `.s.PGSQL.${String(CLUSTER_PORT)}.lock`]) {
      rmSync(join(socketDir, name), { force: true });
    }
  });
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

/** How long an open waits for an initdb a `madarch.preparing` record names: the same 90 s bound the initdb runs under. */
const PREPARATION_WAIT_MS = 90_000;

/** Starts one private server: Unix socket on Unix, authenticated loopback TCP on Windows. */
async function startServer(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly log: (line: string) => void; readonly preparationWaitMs?: number; readonly initdbTimeoutMs?: number }): Promise<void> {
  const { dataDir, socketDir, bin } = options;
  await createDataDir(dataDir, bin, options.log, options.preparationWaitMs ?? PREPARATION_WAIT_MS, options.initdbTimeoutMs ?? INITDB_TIMEOUT_MS);
  removeSocketFiles(socketDir);
  const logFile = join(dataDir, '..', 'postgres.log');
  withSpanSync('fs.write', { 'file.path': logFile, 'file.bytes': Buffer.byteLength('') }, () => writeFileSync(logFile, '', 'utf8'));
  const connection = process.platform === 'win32'
    ? `-h 127.0.0.1 -p ${String(await freeTcpPort())} -c unix_socket_directories=`
    : `-k "${socketDir}" -p ${String(CLUSTER_PORT)} -c listen_addresses=`;
  try {
    const invocation = clusterStartInvocation(dataDir, logFile, connection);
    runBinary(join(bin, postgresProgram('pg_ctl')), invocation.args, { stdio: invocation.stdio });
    if (process.platform === 'win32') {
      // Replace pg_ctl's existing 60-second wait with an authenticated connection, not inherited output handles. The
      // wait says what it waits for and refuses with the last attempt's words, so a store that cannot come up is never
      // 60 seconds of silence.
      await awaitServerAnswering({ dataDir, socketDir });
    }
  } catch (error) {
    throw new Error(`${logFile}:1: PostgreSQL startup failed: ${String(error)}\n${withSpanSync('fs.read', { 'file.path': logFile }, (span) => {
      const held = readFileSync(logFile, 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    })}`);
  }
  lowerPriorityOf(dataDir);
}

/** A server already running (a predecessor started it) is lowered too: it serves one store, whose pages the answers hold. */
function lowerPriorityOf(dataDir: string): void {
  const pid = holderOf(dataDir);
  if (pid === null) return;
  try { setPriority(pid, SERVER_PRIORITY); } catch { /* the platform refuses: the server keeps the priority it has */ }
}

/** The record of a preparation under way, read from beside the data directory; undefined when there is none readable. */
function preparingRecord(dataDir: string): PreparingRecord | undefined {
  try {
    const record = JSON.parse(withSpanSync('fs.read', { 'file.path': preparingRecordPath(dataDir) }, (span) => {
      const held = readFileSync(preparingRecordPath(dataDir), 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    })) as PreparingRecord;
    return typeof record?.startedAt === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** Writes one of our records beside the data directory, private to the account that runs the store. */
function writeRecord(path: string, value: object): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  withSpanSync('fs.write', { 'file.path': path, 'file.bytes': Buffer.byteLength(text) }, () => writeFileSync(path, text, { mode: 0o600 }));
}

/** Whether our record says this data directory was prepared: the only proof of ours that a cluster is whole. */
function recordPrepared(dataDir: string): boolean {
  return existsSync(preparedRecordPath(dataDir));
}

/** What initdb leaves when it ends: its version file, its control file and its template database. */
function initdbWhole(dataDir: string): boolean {
  return existsSync(join(dataDir, 'PG_VERSION')) && existsSync(join(dataDir, 'global', 'pg_control')) && existsSync(join(dataDir, 'base', '1'));
}

/**
 * Moves a folder madarch would prepare again aside, by a rename in the store's own folder: a store's files are never
 * deleted, however little they are expected to hold — a table in `postgres`, a database in a tablespace and a cluster a
 * person restored all live outside what a folder's own shape says. The name carries the UTC moment so two moves of one
 * store are told apart, and the folder stands beside the store until a person checks it and removes it by hand.
 *
 * A move never replaces anything already there. POSIX `rename` replaces an empty directory at its destination, so the
 * name is first taken exclusively with `mkdir`: the only directory a move can replace is that placeholder, made a
 * moment earlier by this call. Windows never replaces a directory on rename, so the placeholder only proves the name
 * free there. When the name is taken, the next counter is tried, never the folder found at it. A rename the
 * filesystem refuses — a name taken after the placeholder, a file inside it — is the caller's to refuse the start with.
 * A test names the moment, so it can hold a name of the very one a move would take.
 */
export function moveAside(dataDir: string, moment: Date = new Date(), steps: {
  readonly platform?: NodeJS.Platform;
  readonly mkdir?: (path: string) => void;
  readonly rmdir?: (path: string) => void;
  readonly rename?: (from: string, to: string) => void;
} = {}): string {
  const platform = steps.platform ?? process.platform;
  return withSpanSync('postgres.move_aside', { 'file.path': dataDir }, () => {
    const mkdir = steps.mkdir ?? ((path: string) => mkdirSync(path));
    const rmdir = steps.rmdir ?? ((path: string) => rmdirSync(path));
    const rename = steps.rename ?? ((from: string, to: string) => renameSync(from, to));
    const stamp = moment.toISOString().replace(/[:.]/gu, '-');
    for (let attempt = 1; attempt <= 1_000; attempt++) {
      const target = attempt === 1 ? `${dataDir}.abandoned-${stamp}` : `${dataDir}.abandoned-${stamp}-${String(attempt)}`;
      try { mkdir(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      // The placeholder is given back before the rename only where a rename never replaces a directory: from that moment
      // whatever stands at the name is another process's folder, and the error path below never removes it.
      let placeholder = true;
      try {
        if (platform === 'win32') { rmdir(target); placeholder = false; }
        rename(dataDir, target);
      } catch (error) {
        if (placeholder) { try { rmdir(target); } catch { /* the rename took it, or it is gone */ } }
        throw error;
      }
      return target;
    }
    throw new Error(`${dataDir}:1: a thousand names beside this folder are taken, so the folder is left as it stands and this store does not open: move it by hand and open the store again (src/adapters/postgres-cluster.ts)`);
  });
}


/**
 * The processes that may still be writing a preparation's data folder: initdb's tree and PostgreSQL's own programs whose
 * command line names it. A folder under one of them is never removed — the next open would prepare into files still
 * being written (measured on Windows: an orphaned bootstrap `postgres.exe` wrote into the folder the open had just
 * removed, and initdb refused the folder it made). undefined when the listing itself cannot be read.
 */
function preparationHolders(dataDir: string): { pid: number; name: string }[] | undefined {
  return withSpanSync('process.holders', { 'file.path': dataDir }, (span) => {
    if (process.platform === 'win32') {
      const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      const answer = withSpanSync('process.run', { 'process.command': 'powershell', 'process.args': ['-NoProfile', '-NonInteractive', '-Command', query] }, (span) => {
        const answer = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 30_000 });
        span.setAttribute('process.exit_code', answer.status ?? -1);
        span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
        span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
        return answer;
      });
      if (answer.error !== undefined || answer.status !== 0) return undefined;
      try {
        const value = JSON.parse(answer.stdout) as { ProcessId: number; Name: string; CommandLine?: string } | { ProcessId: number; Name: string; CommandLine?: string }[];
        const all = Array.isArray(value) ? value : [value];
        return all.filter((row) => /^(?:initdb|postgres|cmd)\.exe$/i.test(row.Name ?? '') && ((row.Name ?? '').toLowerCase().startsWith('cmd')
          ? (row.CommandLine ?? '').toLowerCase().includes(dataDir.toLowerCase())
          : runsOnDataDir(row.Name ?? '', commandLineArguments(row.CommandLine ?? '', 'win32'), dataDir, 'win32'))).map((row) => ({ pid: row.ProcessId, name: row.Name }));
      } catch { return undefined; }
    }
    const holders: { pid: number; name: string }[] = [];
    try {
      const ids = readdirSync('/proc');
      span.setAttribute('process.entries', ids.length);
      for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        try {
          const argv = readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').filter((part) => part !== '');
          const program = argv[0] ?? '';
          if (!runsOnDataDir(program, argv, dataDir, process.platform)) continue;
          holders.push({ pid: Number(id), name: program.split('/').pop() ?? '' });
        } catch { /* gone */ }
      }
    } catch { return undefined; }
    return holders;
  });
}

/** Keeps a whole cluster: writes the record that says so, and drops the record of a preparation it no longer needs. */
function keepPrepared(dataDir: string): void {
  if (!existsSync(preparedRecordPath(dataDir))) writeRecord(preparedRecordPath(dataDir), { version: runningVersion(), preparedAt: new Date().toISOString() });
  withSpanSync('fs.remove', { 'file.path': preparingRecordPath(dataDir) }, () => rmSync(preparingRecordPath(dataDir), { force: true }));
}



/** How long initdb itself is given before its tree is ended. */
const INITDB_TIMEOUT_MS = 90_000;

/** How long initdb's output is waited for once initdb itself has ended: a bootstrap descendant can hold its pipes open. */
const INITDB_OUTPUT_WAIT_MS = 2_000;

/**
 * Ends initdb and everything it started. On Windows initdb runs its bootstrap `postgres --boot` through cmd.exe, so the
 * tree is ended with `/T`; on POSIX the child was spawned as its own process group, and the whole group is signalled.
 */
export function endInitdbTree(pid: number | undefined, dataDir: string, live: boolean, reads: {
  platform?: NodeJS.Platform;
  /** The processes a Windows machine runs, by command line: what identity a pid without a start time is read by. */
  processes?: () => { pid: number; name: string; commandLine: string }[] | undefined;
  /** Ends one process, and with `tree` everything it started. */
  kill?: (pid: number, tree: boolean) => void;
  /** Ends a process group on POSIX. */
  killGroup?: (group: number) => void;
} = {}): void {
  if (pid === undefined) return;
  const platform = reads.platform ?? process.platform;
  const kill = reads.kill ?? ((target: number, tree: boolean) => { withSpanSync('process.run', { 'process.command': 'taskkill', 'process.args': ['/F', ...(tree ? ['/T'] : []), '/PID', String(target)] }, (span) => {
    const answer = spawnSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(target)], { encoding: 'utf8', timeout: 10_000 });
    span.setAttribute('process.exit_code', answer.status ?? -1);
    span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
    span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
    return answer;
  }); });
  if (platform === 'win32') {
    // While initdb itself lives its pid is its own, and its tree goes with it.
    if (live) { kill(pid, true); return; }
    // After it exits its id may belong to whatever the machine started next: no pid is signalled then. What it left is
    // found by identity instead — a program whose command line names this data folder.
    for (const holder of (reads.processes ?? windowsProcesses)() ?? []) {
      if (!runsOnDataDir(holder.name, commandLineArguments(holder.commandLine, 'win32'), dataDir, 'win32')) continue;
      kill(holder.pid, false);
    }
    return;
  }
  // A group id is not reused while a member lives, so the group is safe to end after initdb exits; a pid that is no
  // group leader is never signalled by it.
  const killGroup = reads.killGroup ?? ((group: number) => { try { process.kill(-group, 'SIGKILL'); } catch { /* no such group */ } });
  killGroup(pid);
}

/**
 * What a timeout may end: initdb with its tree while it lives, and after its exit nothing by pid — only what names the
 * data folder, by identity. A timer that fires after the exit must never signal the id.
 */
export function timeoutEndsInitdb(pid: number | undefined, dataDir: string, exited: boolean, reads: Parameters<typeof endInitdbTree>[3] = {}): void {
  endInitdbTree(pid, dataDir, !exited, reads);
}

/** The processes of a Windows machine, by command line; undefined when the listing cannot be read. */
function windowsProcesses(): { pid: number; name: string; commandLine: string }[] | undefined {
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const answer = withSpanSync('process.run', { 'process.command': 'powershell', 'process.args': ['-NoProfile', '-NonInteractive', '-Command', query] }, (span) => {
    const answer = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 30_000 });
    span.setAttribute('process.exit_code', answer.status ?? -1);
    span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
    span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
    return answer;
  });
  if (answer.error !== undefined || answer.status !== 0) return undefined;
  try {
    const value = JSON.parse(answer.stdout) as { ProcessId: number; Name: string; CommandLine?: string } | { ProcessId: number; Name: string; CommandLine?: string }[];
    const all = Array.isArray(value) ? value : [value];
    return all.map((row) => ({ pid: row.ProcessId, name: row.Name ?? '', commandLine: row.CommandLine ?? '' }));
  } catch { return undefined; }
}

/** Runs `initdb`, naming the pid it spawned to `named` as soon as there is one, and throws with what initdb said when it fails. */
async function runInitdb(program: string, args: readonly string[], dataDir: string, named: (pid: number, startTime: string | undefined) => void, timeoutMs: number): Promise<void> {
  return await withSpan('process.run', { 'process.command': program, 'process.args': [...args], 'file.path': dataDir }, async (span) => {
    const child = spawn(program, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C' }),
      // Its own process group on POSIX, so a timeout ends what initdb started; Windows is ended with `taskkill /T`.
      detached: process.platform !== 'win32',
    });
    if (child.pid !== undefined) named(child.pid, processStartTime(child.pid));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part: string) => { stderr += part; });
    const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((answer) => {
      let settled = false;
      let exited = false;
      let output: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: { code: number | null; timedOut: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (output !== undefined) clearTimeout(output);
        answer(value);
      };
      // initdb's own end decides, never its pipes: its bootstrap descendants can hold them open after initdb is over, and a
      // start that waited for the pipes would hang on an initdb that has already ended.
      // initdb's own end decides, never its pipes: its bootstrap descendants can hold them open after initdb is over, and a
      // start that waited for the pipes would hang on an initdb that has already ended. Its exit also disarms the timeout:
      // after it, its pid is nobody's to signal, and a timer that fired in the pipe wait would kill a reused id.
      child.once('exit', (code) => {
        exited = true;
        clearTimeout(timer);
        output = setTimeout(() => finish({ code, timedOut: false }), INITDB_OUTPUT_WAIT_MS);
        child.once('close', () => finish({ code, timedOut: false }));
      });
      child.once('error', () => finish({ code: null, timedOut: false }));
      const timer = setTimeout(() => {
        timeoutEndsInitdb(child.pid, dataDir, exited);
        finish({ code: null, timedOut: true });
      }, timeoutMs);
    });
    span.setAttribute('process.exit_code', outcome.code ?? -1);
    span.setAttribute('process.stderr.bytes', Buffer.byteLength(stderr));
    // initdb has ended, one way or the other: what it started is ended with it, and both of its pipes are closed here.
    // A bootstrap descendant that survived initdb holds its stdout, and a pipe left open keeps this process alive after
    // the start is over (measured: Bun exited only when the descendant ended, 6 s later).
    endInitdbTree(child.pid, dataDir, false);
    child.stdout.destroy();
    child.stderr.destroy();
    if (outcome.timedOut) {
      throw new Error(`${program}:1: ${[...args].join(' ')} did not finish within ${String(timeoutMs)} ms, so initdb and everything it started were ended (src/adapters/postgres-cluster.ts)`);
    }
    if (outcome.code !== 0) {
      const said = stderr.trim();
      throw new Error(`${program}:1: ${[...args].join(' ')} ${outcome.code === null ? 'could not run' : `exited ${String(outcome.code)}`}${said === '' ? '' : `: ${said}`} (src/adapters/postgres-cluster.ts)`);
    }
  });

}

/**
 * Makes the data directory with `initdb` when it holds no whole cluster. Our record of a preparation decides before
 * anything about the files: a live initdb may already have written what a whole cluster leaves, and adopting that folder
 * would start PostgreSQL inside an initialisation. Only a folder our own record prepared and whose initdb is verified
 * gone is removed; a folder madarch never recorded is left as it stands and the start refuses naming it.
 */
/**
 * Waits for a preparation recorded in this store to end, and refuses while things still name the folder. Identity is the
 * command line that names the data folder — never the record's pid alone: Windows keeps no kernel start time to compare
 * and hands a stopped process's id to whatever starts next, so a recorded pid is printed here, never trusted. A store
 * that waits never waits silently: it says what it waits for, and for how long.
 */
async function awaitRecordedInitdb(dataDir: string, record: PreparingRecord | undefined, waitMs: number): Promise<void> {
  const recorded = record?.initdb?.pid;
  const deadline = Date.now() + waitMs;
  let said = false;
  for (;;) {
    const holders = preparationHolders(dataDir);
    if (holders === undefined) {
      throw new Error(`${dataDir}:1: the process list could not be read, so this folder is left as it stands and this store does not open: open the store again, or move ${dataDir} aside (src/adapters/postgres-cluster.ts)`);
    }
    if (holders.length === 0) return;
    if (!said) {
      said = true;
      console.error(`madarch: waiting for ${holders.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} to end before preparing ${dataDir}${recorded === undefined ? '' : ` (the preparation record names initdb pid ${String(recorded)})`}, up to ${String(waitMs)} ms`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${dataDir}:1: ${holders.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} still name this folder after ${String(waitMs)} ms, so it is left as it stands and this store does not open: open the store again once they end, or move ${dataDir} aside (src/adapters/postgres-cluster.ts)`);
    }
    await Bun.sleep(200);
  }
}

async function createDataDir(dataDir: string, bin: string, log: (line: string) => void, waitMs: number, initdbTimeoutMs: number): Promise<void> {
  const empty = !existsSync(dataDir) || withSpanSync('fs.readdir', { 'file.path': dataDir }, (span) => {
    const held = readdirSync(dataDir);
    span.setAttribute('file.entries', held.length);
    return held;
  }).length === 0;
  if (recordPrepared(dataDir) && !empty) {
    keepPrepared(dataDir);
    return;
  }
  // A record beside the folder says madarch started a preparation here. It is read to tell an attempt of ours from
  // somebody else's, and one that cannot be read or names no attempt of madarch's refuses the start naming the folder:
  // madarch never erases a folder it cannot prove is its own unfinished preparation (madarch-64o5.81 review).
  const preparingPath = preparingRecordPath(dataDir);
  const preparing = preparingRecord(dataDir);
  if (preparing !== undefined || existsSync(preparingPath)) {
    if (preparing === undefined) {
      throw new Error(`${preparingPath}:1: madarch recorded a preparation beside this store and that record cannot be read, so ${dataDir} is left as it stands and this store does not open: move ${dataDir} aside to let madarch prepare the store again (src/adapters/postgres-cluster.ts)`);
    }
    if (!namesAnAttempt(preparing)) {
      throw new Error(`${preparingPath}:1: the record of a preparation beside ${dataDir} names no attempt madarch made, so the folder is left as it stands and this store does not open: move ${dataDir} aside to let madarch prepare the store again (src/adapters/postgres-cluster.ts)`);
    }
    await awaitRecordedInitdb(dataDir, preparing, waitMs);
    // Nothing names the folder now and no `madarch.prepared` record followed the attempt: the preparation was abandoned.
    // Whatever the folder holds is moved aside below, never deleted: initdb's bootstrap writes `PG_VERSION`,
    // `global/pg_control` and `base/1` long before the store's database exists, so such a folder looks whole and is not
    // (madarch-64o5.81: the next open started one, and every connection answered "database postgres does not exist"),
    // while a table in `postgres` or a database in a tablespace says nothing about the folder's shape.
  } else if (!empty && initdbWhole(dataDir)) {
    // A store prepared before these records existed: what initdb leaves when it ends is the proof, and the record follows.
    keepPrepared(dataDir);
    return;
  } else if (!empty) {
    // Nothing of madarch's says it made this folder, so nothing of madarch may touch it, however unfinished its files
    // look: an older or damaged cluster missing `base/1` is a store's data, not preparation's left-over.
    throw new Error(`${dataDir}:1: this folder holds files and no record of a preparation madarch started (${preparingRecordPath(dataDir)}), so it is left as it stands and this store does not open: move ${dataDir} aside to let madarch prepare the store again (src/adapters/postgres-cluster.ts)`);
  }
  // A folder is never deleted here: an abandoned one is moved aside and a person removes it once they have looked.
  if (existsSync(dataDir)) {
    if (withSpanSync('fs.readdir', { 'file.path': dataDir }, (span) => {
      const held = readdirSync(dataDir);
      span.setAttribute('file.entries', held.length);
      return held;
    }).length === 0) rmdirSync(dataDir);
    else {
      let target: string;
      try { target = moveAside(dataDir); }
      catch (error) {
        throw new Error(`${dataDir}:1: the folder madarch would prepare again could not be moved aside, so it is left as it stands and this store does not open: move it by hand and open the store again (${error instanceof Error ? error.message : String(error)}) (src/adapters/postgres-cluster.ts)`);
      }
      defaultLog.warn(`madarch: the store folder ${dataDir} was not a whole store, so it is kept as ${target}: remove it by hand once you have checked it`, { madarch: 'postgres' });
    }
  }
  withSpanSync('fs.mkdir', { 'file.path': dataDir }, () => mkdirSync(dataDir, { recursive: true, mode: 0o700 }));
  // Progress, not a warning: a command whose output a caller reads (a script's, a test's) stays quiet.
  defaultLog.info(`madarch: creating the PostgreSQL data directory ${dataDir}`, { madarch: 'postgres' });
  void log;
  const authentication = ['--auth=trust'];
  if (process.platform === 'win32') {
    // TCP must not trust every local account as a superuser. The store's private credential is shared by its roles.
    const passwordFile = join(dataDir, '..', 'postgres.password');
    if (!existsSync(passwordFile)) {
      const password = `${randomBytes(32).toString('hex')}\n`;
      withSpanSync('fs.write', { 'file.path': passwordFile, 'file.bytes': Buffer.byteLength(password) }, () => writeFileSync(passwordFile, password, { mode: 0o600 }));
    }
    authentication.splice(0, 1, '--auth=scram-sha-256', `--pwfile=${passwordFile}`);
  }
  const version = runningVersion();
  const startedAt = new Date().toISOString();
  // The attempt this record names, from its first line to initdb's end: a later open tells our record from one a person
  // left beside a folder, and erases a folder only on the record of an attempt of ours.
  const id = newPreparationId();
  // A record that outlived the folder it named says nothing about the one being made now: preparation is the record
  // from here until initdb ends, and a crash mid-way must not leave a store that reads as whole.
  withSpanSync('fs.remove', { 'file.path': preparedRecordPath(dataDir) }, () => rmSync(preparedRecordPath(dataDir), { force: true }));
  writeRecord(preparingRecordPath(dataDir), { id, version, startedAt });
  const terminal = startupBegin('cluster.initdb', dataDir);
  try {
    await runInitdb(join(bin, postgresProgram('initdb')), ['-D', dataDir, '-U', CLUSTER_USER, ...authentication, '-E', 'UTF8', '--locale=C'], dataDir, (pid, startTime) => {
      // The record names the initdb as soon as it has one: a madarch that a stop ends leaves a folder only a later open
      // may remove, and only once that initdb is gone.
      writeRecord(preparingRecordPath(dataDir), { id, version, startedAt, initdb: startTime === undefined ? { pid } : { pid, startTime } });
    }, initdbTimeoutMs);
    writeRecord(preparedRecordPath(dataDir), { version, preparedAt: new Date().toISOString() });
    withSpanSync('fs.remove', { 'file.path': preparingRecordPath(dataDir) }, () => rmSync(preparingRecordPath(dataDir), { force: true }));
    terminal('ok');
  } catch (error) {
    terminal('error');
    // An initdb that wrote nothing never prepared anything: the record of that attempt is not one to keep, since a
    // later open would refuse a folder holding nothing rather than prepare it.
    if (withSpanSync('fs.readdir', { 'file.path': dataDir }, (span) => {
      const held = readdirSync(dataDir);
      span.setAttribute('file.entries', held.length);
      return held;
    }).length === 0) withSpanSync('fs.remove', { 'file.path': preparingRecordPath(dataDir) }, () => rmSync(preparingRecordPath(dataDir), { force: true }));
    throw error;
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
  /** How long an open waits for an initdb a `madarch.preparing` record names; a test names its own instead of 90 s. */
  readonly preparationWaitMs?: number;
  /** How long initdb itself is given before its process tree is ended; a test names its own instead of 90 s. */
  readonly initdbTimeoutMs?: number;
}

/**
 * Opens a cluster: attaches to the server already answering on its socket,
 * adopts one a killed predecessor left, or starts one under the start lock. The server listens on its socket folder only.
 *
 * The cluster this answers is one caller's hold of it: its `stop` gives that hold back, and the server is stopped when
 * the last hold of it in this process is given back and no other process holds one.
 */
export async function openCluster(options: OpenClusterOptions): Promise<RunningCluster> {
  const terminal = startupBegin('store.open', options.dataDir);
  try {
  refuseRoot();
  const key = resolve(options.dataDir);
  let opened = openInProcess.get(key);
  const reused = opened !== undefined;
  if (opened === undefined) {
    opened = openOnce(key, options).then((cluster) => ({ cluster, users: 0 }));
    openInProcess.set(key, opened);
    // An open that failed is not kept: the next caller tries again instead of being handed the same failure for ever.
    void opened.catch(() => { if (openInProcess.get(key) === opened) openInProcess.delete(key); });
  }
  const held = await opened;
  held.users += 1;
  const { cluster } = held;
  terminal(reused ? 'reused' : 'ok', reused ? startIdentity(cluster.dataDir) : undefined);
  return {
    dataDir: cluster.dataDir, socketDir: cluster.socketDir, port: cluster.port, user: cluster.user, bin: cluster.bin,
    stop: async () => await releaseCluster(key),
  };
  } catch (error) { terminal('error'); throw error; }
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
  withSpanSync('fs.mkdir', { 'file.path': socketDir }, () => mkdirSync(socketDir, { recursive: true, mode: 0o700 }));
  chmodSync(socketDir, 0o700);
  withSpanSync('fs.mkdir', { 'file.path': dataDir }, () => mkdirSync(dataDir, { recursive: true, mode: 0o700 }));
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
      const terminal = startupBegin('cluster.start', dataDir);
      try {
      if (await answering(socketDir)) {
        // A server another process started, or a predecessor left: it serves this store, so it is lowered too.
        lowerPriorityOf(dataDir);
        terminal('reused', startIdentity(dataDir));
      } else {
        if (startsRefused) throw new Error(`${dataDir}:1: this process is stopping, so the store's PostgreSQL server is not started for it (src/adapters/postgres-cluster.ts)`);
        await reclaimStaleServer(dataDir, bin, socketDir, log);
        await startServer({
          dataDir, socketDir, bin, log,
          ...(options.preparationWaitMs === undefined ? {} : { preparationWaitMs: options.preparationWaitMs }),
          ...(options.initdbTimeoutMs === undefined ? {} : { initdbTimeoutMs: options.initdbTimeoutMs }),
        });
        const failing = await answerFailure(socketDir);
        if (failing !== undefined) {
          throw new Error(`${join(dataDir, '..', 'postgres.log')}:1: the PostgreSQL server started on ${dataDir} does not answer on ${socketDir}, and the last attempt said: ${failing} (src/adapters/postgres-cluster.ts)`);
        }
        terminal('ok', startIdentity(dataDir));
      }
      } catch (error) { terminal('error'); throw error; }
    } finally {
      releaseLock(start);
    }
  } catch (error) {
    releaseLock(users);
    // The hold is given back, so the process no longer holds it: a stop that walks the holds must not close its
    // descriptor again (a store whose open was refused would then fail its own stop with EBADF).
    holds.delete(users);
    throw error;
  }
  return {
    dataDir, socketDir, port: clusterEndpoint(socketDir).port, user: CLUSTER_USER, bin,
    stop: async () => await stopCluster({ dataDir, socketDir, bin, users }),
  };
}

/** A nonblocking capped read; proc pseudo-files report size zero. */
function holderText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error('unreadable holder');
    const buffer = Buffer.alloc(4097);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) throw new Error('oversized holder');
    return buffer.toString('utf8', 0, bytes);
  } finally { closeSync(fd); }
}
/** One bounded sample under the caller's existing locks; never a database probe. */
type HolderSample = { pid?: number; ticks?: string; state?: string; readable: boolean };
function sampleHolder(dataDir: string, oldPid?: number): HolderSample {
  return withSpanSync('startup.holder.sample', {}, () => {
  try {
    const readPid = (): number | undefined => {
      try {
        const text = holderText(join(dataDir, 'postmaster.pid'));
        const pid = Number(text.split('\n')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid holder');
        return pid;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const pid = readPid();
    const subject = oldPid ?? pid;
    let ticks: string | undefined;
    let state: string | undefined;
    if (subject !== undefined) {
      if (process.platform !== 'linux') return { ...(pid === undefined ? {} : { pid }), readable: false };
      try {
        const stat = holderText(`/proc/${subject}/stat`);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        ticks = fields[19]; state = fields[0];
        if (ticks === undefined || !/^\d+$/.test(ticks)) return { ...(pid === undefined ? {} : { pid }), readable: false };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (readPid() !== pid) return { ...(pid === undefined ? {} : { pid }), readable: false };
    return { ...(pid === undefined ? {} : { pid }), ...(ticks === undefined ? {} : { ticks }), ...(state === undefined ? {} : { state }), readable: true };
  } catch { return { readable: false }; }
  });
}
function holderIdentity(sample: HolderSample, verified = false): StartupEvidence {
  if (sample.readable && sample.pid === undefined) return {};
  if (!sample.readable || sample.ticks === undefined) return { identity: 'unknown' };
  return { identity: verified ? 'verified' : 'observed', postmasterPid: sample.pid!, postmasterTicks: sample.ticks };
}
function startIdentity(dataDir: string): StartupEvidence | undefined {
  return startupEnabled() ? holderIdentity(sampleHolder(dataDir)) : undefined;
}
/** The ordered stop table is observation, not permission to signal or remove files. */
function beginStop(dataDir: string) {
  const terminal = startupBegin('cluster.stop', dataDir);
  let before: HolderSample | undefined;
  let verified = false;
  let probe: StartupEvidence['probe'] = 'skipped';
  let command: StartupEvidence['command'] = 'none';
  let code: number | undefined;
  let signal: StartupEvidence['signal'] = 'none';
  let ended = false;
  return {
    sample: () => { if (startupEnabled()) before = sampleHolder(dataDir); },
    probe: (result: NonNullable<StartupEvidence['probe']>, confirmed = false) => {
      probe = result;
      if (confirmed && before?.pid !== undefined && before.ticks !== undefined) {
        const after = sampleHolder(dataDir);
        verified = after.readable && after.pid === before.pid && after.ticks === before.ticks;
      }
    },
    command: (result: NonNullable<StartupEvidence['command']>, status?: number) => { command = result; code = status; },
    signal: (value: NonNullable<StartupEvidence['signal']>) => { signal = value; },
    finish: (skipped = false) => {
      if (ended) return;
      ended = true;
      if (!startupEnabled()) { terminal('unknown'); return; }
      if (skipped) { terminal('skipped', { identity: 'unknown', command, signal, probe }); return; }
      const after = sampleHolder(dataDir, before?.pid);
      let holder: StartupEvidence['holder'] = 'unreadable';
      if (after.readable && before?.readable !== false) {
        if (before?.pid === undefined) holder = after.pid === undefined ? 'absent' : undefined;
        else if (after.ticks === undefined || after.ticks !== before.ticks || after.state === 'Z' || after.state === 'X') holder = 'gone';
        else holder = after.pid === before.pid ? 'held' : 'released';
      }
      let outcome: StartupOutcome;
      if (before === undefined || !before.readable || (before.pid !== undefined && before.ticks === undefined)) outcome = 'unknown';
      else if (before.pid === undefined) outcome = holder === 'absent' ? 'absent' : 'unknown';
      else if (holder === 'unreadable' || holder === 'released') outcome = 'unknown';
      else if (holder === 'held') outcome = command === 'none' && signal === 'none' ? (probe === 'failed' ? 'unresponsive' : probe === 'other' || probe === 'skipped' ? 'unknown' : 'error') : 'error';
      else outcome = command === 'exit' && code === 0 ? 'stopped' : 'unknown';
      terminal(outcome, { ...holderIdentity(before ?? { readable: false }, verified), holder, probe, command, ...(code === undefined ? {} : { code }), signal });
    },
  };
}

/** The store folders of one knowledge root: `<root>/<id>/graph`, each holding a cluster's `pgdata`. */
export function databaseFoldersUnder(knowledgeRoot: string): string[] {
  return withSpanSync('postgres.folders', { 'file.path': knowledgeRoot }, (span) => {
    let ids: string[] = [];
    try { ids = readdirSync(knowledgeRoot); } catch { return []; }
    span.setAttribute('file.entries', ids.length);
    return ids.map((id) => join(knowledgeRoot, id, 'graph')).filter((folder) => existsSync(join(folder, 'pgdata')) && readdirSync(folder).includes('pgdata'));
  });
}

/** The PostgreSQL servers a knowledge root still records: each data folder whose `postmaster.pid` names a live process. */
export function runningServersUnder(knowledgeRoot: string): { readonly dataDir: string; readonly pid: number }[] {
  const found: { dataDir: string; pid: number }[] = [];
  for (const folder of databaseFoldersUnder(knowledgeRoot)) {
    const pid = holderOf(join(folder, 'pgdata'));
    if (pid !== null && alive(pid) && postmasterOfDataDir(join(folder, 'pgdata'), pid)) found.push({ dataDir: join(folder, 'pgdata'), pid });
  }
  return found;
}

/** The real path of a folder, with a path that does not exist yet read as written. */
function realPathOf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The kernel's start time of a process (Linux `/proc/<pid>/stat` field 22), or undefined where it is not read. */
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'linux' ? processStartTicks(pid) : undefined;
}

/**
 * Whether a pid is still the exact process verification saw, for the fallback escalation: the pid file still names it, it
 * is alive, and on Linux its captured kernel start time still matches. On macOS and Windows, and when the start time was
 * not captured, no stable identity exists, so the escalation never runs.
 */
export function postmasterStill(dataDir: string, pid: number, startTime: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || startTime === undefined) return false;
  if (holderOf(dataDir) !== pid || !alive(pid)) return false;
  return processStartTime(pid, platform) === startTime;
}

/**
 * Whether the kernel reports this process stopped (`T` for a signal, `t` for a tracer). A stopped postmaster answers
 * nothing and only a signal would end it, so it is never one the file identity may verify.
 */
export function processStopped(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  try {
    const stat = withSpanSync('fs.read', { 'file.path': `/proc/${String(pid)}/stat` }, (span) => {
      const held = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    });
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'T' || state === 't';
  } catch { return false; }
}

/** The installed Linux postmaster's kernel identity when its socket cannot answer (startup, authentication or shutdown). */
function postmasterFileIdentity(dataDir: string, pid: number, bin: string, platform: NodeJS.Platform): boolean {
  return withSpanSync('postgres.postmasterFileIdentity', {}, () => {
    if (platform !== 'linux') return false;
    const start = processStartTime(pid);
    if (start === undefined) return false;
    // A stopped server is unresponsive rather than unanswerable: only a signal would end it, and the files say nothing
    // about whether it may be signaled.
    if (processStopped(pid, platform)) return false;
    try {
      // A command line alone is not identity: a shell script named postgres may carry exactly these arguments.
      const executable = statSync(`/proc/${String(pid)}/exe`);
      const installed = statSync(join(bin, postgresProgram('postgres', platform)));
      if (executable.dev !== installed.dev || executable.ino !== installed.ino) return false;
      const argv = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter((part) => part !== '');
      if (!runsOnDataDir(argv[0] ?? '', argv, dataDir, platform)) return false;
      if (argv.some((argument) => argument === '--single' || argument === '--boot' || argument === '--describe-config' || argument === '-C')) return false;
      if (realPathOf(`/proc/${String(pid)}/cwd`) !== realPathOf(dataDir)) return false;
      const record = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
      if (Number(record[0]) !== pid || realPathOf(record[1] ?? '') !== realPathOf(dataDir)) return false;
      return postmasterStill(dataDir, pid, start, platform);
    } catch { return false; }
  });
}
/**
 * Whether the pid in `postmaster.pid` is the postmaster of exactly this data folder: the server is asked over its own
 * socket (or loopback TCP on Windows) for `SHOW data_directory`; it is ours only when it answers, the answer's real path is
 * this data folder's real path, and `postmaster.pid` still names the same pid after the answer. A server that answers only
 * that it cannot answer is checked against the installed executable, exact data folder and kernel identity on Linux.
 * A process that is not confirmed is never signaled and `pg_ctl` is never run for it.
 */
export function postmasterOfDataDir(dataDir: string, pid: number, platform: NodeJS.Platform = process.platform, observed?: (probe: 'answered' | 'failed' | 'other' | 'skipped') => void): boolean {
  observed?.('skipped');
  if (holderOf(dataDir) !== pid) return false;
  const bin = join(postgresInstallFolder(process.env), 'bin');
  const psql = join(bin, postgresProgram('psql', platform));
  if (!existsSync(psql)) return false;
  const pidFile = join(dataDir, 'postmaster.pid');
  let port = CLUSTER_PORT;
  let host = clusterPaths(dirname(dataDir)).socketDir;
  let password: string | undefined;
  if (platform === 'win32') {
    try { port = Number(withSpanSync('fs.read', { 'file.path': pidFile }, (span) => {
      const held = readFileSync(pidFile, 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    }).split('\n')[3]?.trim()); } catch { return false; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    host = '127.0.0.1';
    try { password = withSpanSync('fs.read', { 'file.path': join(dataDir, '..', 'postgres.password') }, (span) => {
      const held = readFileSync(join(dataDir, '..', 'postgres.password'), 'utf8');
      span.setAttribute('file.bytes', Buffer.byteLength(held));
      return held;
    }).trim(); } catch { return false; }
  }
  // `-X` keeps a reader's ~/.psqlrc out of the answer; a fixed environment keeps PGOPTIONS and a locale's words out.
  const answer = withSpanSync('process.run', { 'process.command': psql, 'process.args': ['-X', '-h', host, '-p', String(port), '-U', CLUSTER_USER, '-d', CLUSTER_ADMIN_DATABASE, '-A', '-t', '-q', '-c', 'SHOW data_directory'] }, (span) => {
    const answer = spawnSync(psql, ['-X', '-h', host, '-p', String(port), '-U', CLUSTER_USER, '-d', CLUSTER_ADMIN_DATABASE, '-A', '-t', '-q', '-c', 'SHOW data_directory'], {
    encoding: 'utf8', timeout: 5_000,
    env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C', PGOPTIONS: '', ...(password === undefined ? {} : { PGPASSWORD: password }) }),
  });
    span.setAttribute('process.exit_code', answer.status ?? -1);
    span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
    span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
    return answer;
  });
  if (answer.status !== 0) {
    // A server that answered no `SHOW data_directory` is still the postmaster the pid file names (madarch-64o5.74).
    const identified = postmasterFileIdentity(dataDir, pid, bin, platform);
    observed?.(identified ? 'answered' : 'failed');
    return identified;
  }
  if (realPathOf((answer.stdout ?? '').trim()) !== realPathOf(dataDir)) { observed?.('other'); return false; }
  if (holderOf(dataDir) !== pid) { observed?.('failed'); return false; }
  observed?.('answered');
  return true;
}

/** The decision a failed `pg_ctl` leaves: the fallback signals only where the platform can verify the pid. */
export function syncStopSignalPlan(platform: NodeJS.Platform, verified: boolean): { readonly signal: boolean } {
  return { signal: platform !== 'win32' && verified };
}

/** Whether the fallback may signal now: the platform allows it and the verified process is still exactly that process. */
export function fallbackSignalAllowed(dataDir: string, pid: number, startTime: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return syncStopSignalPlan(platform, true).signal && postmasterStill(dataDir, pid, startTime, platform);
}

/** Waits synchronously for one pid to end, without blocking the kernel's own timers forever. */
function waitGoneSync(pid: number, timeoutMs: number): boolean {
  for (let waited = 0; waited < timeoutMs && alive(pid); waited += 20) Bun.sleepSync(20);
  return !alive(pid);
}

/**
 * Stops every recorded server of a knowledge root without awaiting: `madarch stop`, whose call is a command's answer.
 * A server another live process of the binary holds (a standalone serve, an independent fill) is left alone by the same
 * users lock the asynchronous stop follows. `pg_ctl` runs on every platform, because it reads `postmaster.pid` itself;
 * only the fallback signal is limited to a pid verified to be this data folder's postmaster, and the pid file is removed
 * only once the server is confirmed gone, under the cluster's start lock.
 */
export function stopDatabasesUnderSync(knowledgeRoot: string): void {
  return withSpanSync('postgres.stop_all', { 'file.path': knowledgeRoot }, (span) => {
    const bin = join(postgresInstallFolder(process.env), 'bin');
    if (!existsSync(join(bin, postgresProgram('pg_ctl')))) return;
    const folders = databaseFoldersUnder(knowledgeRoot);
    span.setAttribute('postgres.stores', folders.length);
    for (const folder of folders) {
      const dataDir = join(folder, 'pgdata');
      const stop = beginStop(dataDir);
      try {
      const key = resolve(dataDir);
      mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
      const users = openLock(usersLockPath(key));
      try {
        if (tryClusterLock(users, dataDir, 'users') !== 0) {
          // A live process still uses this server: its own stop is the one that may end it.
          stop.finish(true);
          continue;
        }
        const start = openLock(startLockPath(key));
        try {
          if (tryClusterLock(start, dataDir, 'start') !== 0) { stop.finish(true); continue; }
          stop.sample();
          const pidFile = join(dataDir, 'postmaster.pid');
          const pid = holderOf(dataDir);
          if (pid === null) continue;
          if (!alive(pid)) { stop.finish(); rmSync(pidFile, { force: true }); continue; }
          // Verified before anything signals: pg_ctl itself signals the pid `postmaster.pid` names, and a reused pid
          // must not be touched by it either.
          const confirmed = postmasterOfDataDir(dataDir, pid, process.platform, result => stop.probe(result));
          if (confirmed) stop.probe('answered', true);
          if (!confirmed) {
            console.error(`${dataDir}:1: the database (pid ${String(pid)}) could not be verified and is left running; its record stays`);
            continue;
          }
          const verifiedStart = processStartTime(pid);
          const commandTerminal = startupBegin('cluster.stop.command', dataDir);
          stop.command('launch-error');
          const stopped = spawnSync(join(bin, postgresProgram('pg_ctl')), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'], { stdio: 'ignore', timeout: 65_000, env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C' }) });
          stop.command(stopped.error !== undefined ? ((stopped.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'launch-error') : stopped.signal !== null ? 'signal' : 'exit', stopped.status ?? undefined);
          commandTerminal(stopped.status === 0 ? 'ok' : 'error', { command: stopped.error !== undefined ? ((stopped.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'launch-error') : stopped.signal !== null ? 'signal' : 'exit', ...(stopped.status === null ? {} : { code: stopped.status }) });
          if (stopped.status !== 0) {
            if (!alive(pid)) { stop.finish(); rmSync(pidFile, { force: true }); removeSocketFiles(clusterPaths(folder).socketDir); continue; }
            if (!fallbackSignalAllowed(dataDir, pid, verifiedStart)) {
              console.error(`${dataDir}:1: the PostgreSQL server pid ${String(pid)} is no longer the verified process, or the platform cannot verify it; no signal is sent and its record stays`);
              continue;
            }
            stop.signal('term');
            try { process.kill(pid, 'SIGTERM'); } catch { /* it ended between the check and the signal */ }
            waitGoneSync(pid, 10_000);
            // The escalation follows the verified process itself, never a second socket answer: a server shutting down
            // refuses connections, and asking again would block the SIGKILL a hung shutdown needs.
            if (postmasterStill(dataDir, pid, verifiedStart)) {
              stop.signal('kill');
              try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
            }
          }
          if (!waitGoneSync(pid, 10_000)) {
            console.error(`${pidFile}:1: the PostgreSQL server pid ${String(pid)} is still running; its record stays`);
            continue;
          }
          stop.finish();
          if (existsSync(pidFile)) {
            if (alive(pid)) { console.error(`${pidFile}:1: the PostgreSQL server pid ${String(pid)} is still running; its record stays`); continue; }
            rmSync(pidFile, { force: true });
          }
          removeSocketFiles(clusterPaths(folder).socketDir);
        } finally {
          stop.finish();
          releaseLock(start);
        }
      } finally {
        stop.finish();
        releaseLock(users);
      }
      } finally { stop.finish(); }
    }
  });
}

/**
 * Stops every PostgreSQL server a knowledge root records, for a madarch process that is ending or a home that is
 * starting: a server another process still uses is left alone by the users lock. A start calls this before it serves, so
 * a server a crash left is stopped before a new one is started for its store.
 */
export async function stopDatabasesUnder(knowledgeRoot: string, options: { readonly force?: boolean } = {}): Promise<void> {
  for (const folder of databaseFoldersUnder(knowledgeRoot)) await stopStoreForExit(folder, { force: options.force === true });
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
  const stop = beginStop(dataDir);
  try {
  const key = resolve(dataDir);
  // A process that is ending (`force`) drops the holds it still has, its own owners included, and stops the server: nothing
  // in it reads the store again. A role giving its stores up inside a process that goes on living leaves a store another
  // owner of this process still uses alone — that owner's `stop` decides, and it stops the server when it is the last.
  if (options.force !== true) {
    const opening = openInProcess.get(key);
    const heldByProcess = opening === undefined ? undefined : await opening.catch(() => undefined);
    if (heldByProcess !== undefined && heldByProcess.users > 0) { stop.finish(true); return; }
  }
  for (const descriptor of userLocks.get(key) ?? []) releaseLock(descriptor);
  userLocks.delete(key);
  openInProcess.delete(key);
  withSpanSync('fs.mkdir', { 'file.path': dirname(key) }, () => mkdirSync(dirname(key), { recursive: true, mode: 0o700 }));
  const users = openLock(usersLockPath(key));
  try {
    if (tryClusterLock(users, dataDir, 'users') !== 0) { stop.finish(true); return; }
    stop.sample();
    // The programs of the install that is here, and never an install: `ensurePostgresInstalled` downloads one when the
    // caller's home holds none, and a role ending in a home that never ran a server would wait for that download before it
    // stopped anything (measured: a daemon's role held a server's stop for its whole two-second wait this way). No
    // `pg_ctl` means no server of this install runs, so there is nothing to stop.
    const bin = join(postgresInstallFolder(process.env), 'bin');
    if (!existsSync(join(bin, postgresProgram('pg_ctl')))) {
      stop.probe('unavailable');
      if (process.platform === 'win32' && holderOf(key) !== null) throw new Error(`${key}:1: PostgreSQL is still recorded but pg_ctl is missing`);
      return;
    }
    // No question is asked of the server first either: `pg_ctl stop` answers "not running" for a server that is gone, and a
    // connection this process tried to open before it (up to its own two-second bound) is time the store's death may not
    // spend (madarch-8bdc.12).
    // A shutdown checkpoint can wait on disk I/O. Keep the event loop free so the ending role's deadline can fire.
    const postmaster = process.platform === 'win32' ? holderOf(key) : null;
    stop.command('launch-error');
    const commandTerminal = startupBegin('cluster.stop.command', dataDir);
    const code = await withSpan('process.run', { 'process.command': join(bin, postgresProgram('pg_ctl')), 'process.args': ['-D', key, '-m', 'fast', '-w', 'stop'] }, async (span) => {
      const stopping = Bun.spawn([join(bin, postgresProgram('pg_ctl')), '-D', key, '-m', 'fast', '-w', 'stop'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 90_000,
        env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C' }),
      });
      const code = await stopping.exited;
      stop.command(stopping.signalCode === null ? 'exit' : 'signal', stopping.signalCode === null ? code : undefined);
      commandTerminal(code === 0 ? 'ok' : 'error', { command: stopping.signalCode === null ? 'exit' : 'signal', ...(stopping.signalCode === null ? { code } : {}) });
      span.setAttribute('process.exit_code', code);
      return code;
    }).catch((error: unknown) => { commandTerminal('error', { command: 'launch-error' }); throw error; });
    if (process.platform === 'win32') {
      // Windows shutdown must finish before its caller can exit; pg_ctl failure is not a stopped store.
      if (code !== 0 && holderOf(key) !== null) throw new Error(`${key}:1: pg_ctl failed to stop the PostgreSQL server (exit ${code})`);
      if (holderOf(key) !== null || (postmaster !== null && alive(postmaster))) throw new Error(`${key}:1: PostgreSQL still holds postmaster.pid after pg_ctl stop`);
    }
    // The socket files go only once the server stopped: a stop that failed leaves a server that still answers, and taking
    // its socket away would make it look gone.
    stop.finish();
    if (code === 0) removeSocketFiles(socketDir);
  } finally {
    stop.finish();
    releaseLock(users);
  }
  } finally { stop.finish(); }
}

/**
 * Gives up this process's use of a server. It is stopped only when no other process of the binary still holds it, which
 * the kernel answers through the users lock: the exclusive hold is granted only when no shared hold is left. A server
 * another process still uses is left running — the api role's server is never stopped by a fill child that finished
 * between two of its runs — and the next process to open the cluster finds it answering and holds it.
 */
async function stopCluster(options: { readonly dataDir: string; readonly socketDir: string; readonly bin: string; readonly users: number }): Promise<void> {
  const { dataDir, socketDir, bin, users } = options;
  const stop = beginStop(dataDir);
  try {
  userLocks.get(dataDir)?.delete(users);
  if (tryClusterLock(users, dataDir, 'users') !== 0) {
    // The kernel took this process's shared hold away to try, and gave the exclusive one to nobody: another process
    // holds the server (or is asking for it), so it keeps answering and this hold is simply given back. This is the
    // ordinary case of a fill child leaving between two of an api process's reads, so it is not a warning.
    stop.finish(true);
    releaseLock(users);
    return;
  }
  try {
    stop.sample();
    const answered = await answering(socketDir);
    stop.probe(answered ? 'answered' : 'failed');
    if (answered) {
      // Independent stores may stop together; a checkpoint must not block their owners' event loop.
      const postmaster = process.platform === 'win32' ? holderOf(dataDir) : null;
      stop.command('launch-error');
      const commandTerminal = startupBegin('cluster.stop.command', dataDir);
      const code = await withSpan('process.run', { 'process.command': join(bin, postgresProgram('pg_ctl')), 'process.args': ['-D', dataDir, '-m', 'fast', '-w', 'stop'] }, async (span) => {
        const stopping = Bun.spawn([join(bin, postgresProgram('pg_ctl')), '-D', dataDir, '-m', 'fast', '-w', 'stop'], {
          stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 90_000,
          env: sanitizedStartupEnv({ ...process.env, LC_ALL: 'C' }),
        });
      const code = await stopping.exited;
        stop.command(stopping.signalCode === null ? 'exit' : 'signal', stopping.signalCode === null ? code : undefined);
        commandTerminal(code === 0 ? 'ok' : 'error', { command: stopping.signalCode === null ? 'exit' : 'signal', ...(stopping.signalCode === null ? { code } : {}) });
        span.setAttribute('process.exit_code', code);
        return code;
      }).catch((error: unknown) => { commandTerminal('error', { command: 'launch-error' }); throw error; });
      if (process.platform === 'win32') {
        if (code !== 0 && holderOf(dataDir) !== null) throw new Error(`${dataDir}:1: pg_ctl failed to stop the PostgreSQL server (exit ${code})`);
        if (holderOf(dataDir) !== null || (postmaster !== null && alive(postmaster))) throw new Error(`${dataDir}:1: PostgreSQL still holds postmaster.pid after pg_ctl stop`);
      }
      if (code !== 0) return;
    }
    stop.finish();
    removeSocketFiles(socketDir);
  } finally {
    stop.finish();
    releaseLock(users);
  }
  } finally { stop.finish(); }
}
