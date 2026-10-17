/** The detached products-home server lifecycle behind `madarch start`, `stop` and `status` (change madarch-zcti, requirement product-repository/daemon).
 *
 * One detached `bun` child serves every valid product in the products home on
 * a fixed port (4180 unless `--port` names another). Its process id, port,
 * start time, home and a one-off token are recorded in a state file in that
 * home. The token is checked in the child's own environment before the state
 * is trusted: a recycled process id that happens to run some other program is
 * a stale record, never a daemon, and is replaced without signaling it. A
 * start while one is already running reports its address instead of starting
 * a second server; a port held by anything else is refused with the address
 * and cause. The child's output goes to a log file beside the state file, so
 * a failed start can be read up.
 */
import { existsSync, openSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { productsHome, type DraftEnv } from './draft.js';
import { listProducts } from './list.js';
import { startFill } from './fill.js';
import { ensureBuilt } from '../product-wiki/app.js';
import type { ServeEnv } from '../product-wiki/serve.js';
import { startServer } from '../server/http.js';

interface DaemonState { pid: number; port: number; startedAt: number; home: string; token: string; }
const STATE_FILE = '.madarch-daemon.json';
const LOG_FILE = '.madarch-daemon.log';
const LOCK_FILE = '.madarch-daemon.lock';

const processEnv = process.env as DraftEnv;
function homePath(home?: string): string { return resolve(productsHome(processEnv, home)); }
function statePath(home: string): string { return join(home, STATE_FILE); }
function logPath(home: string): string { return join(home, LOG_FILE); }

function readState(home: string): DaemonState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8')) as DaemonState;
    if (parsed.home !== home || !Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port) || typeof parsed.token !== 'string') return undefined;
    return parsed;
  } catch { return undefined; }
}

/** The command line of one process id, or undefined when it does not exist. */
function processArgs(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
}

/**
 * Whether the recorded state names a live Madarch daemon: the command line
 * must be the daemon child's, and the recorded token must be in that
 * process's environment. Both checks pass only for a process this command
 * spawned with this record, never for a recycled id running another program.
 */
function daemonIsAlive(state: DaemonState): boolean {
  if (!processArgs(state.pid)?.includes('daemon-serve')) return false;
  try {
    return readFileSync(`/proc/${state.pid}/environ`, 'utf8').split('\0').includes(`MADARCH_DAEMON_TOKEN=${state.token}`);
  } catch {
    const env = spawnSync('ps', ['eww', '-p', String(state.pid)], { encoding: 'utf8' });
    return env.status === 0 && env.stdout.includes(`MADARCH_DAEMON_TOKEN=${state.token}`);
  }
}

function saveState(home: string, state: DaemonState): void { writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function clearState(home: string): void { try { unlinkSync(statePath(home)); } catch { /* already gone */ } }

/** Yields to other work without a busy loop; the lifecycle waits below poll with it. */
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** Polls `ok` until it holds or the timeout passes; answers whether it held. */
async function waitUntil(ok: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ok()) return true;
    pause(40);
  }
  return await ok();
}

/** Ends one daemon process: TERM, then KILL; answers whether it is gone. */
async function stopProcess(state: DaemonState): Promise<boolean> {
  try { process.kill(state.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; return true; }
  if (!(await waitUntil(() => !daemonIsAlive(state), 3000))) {
    try { process.kill(state.pid, 'SIGKILL'); } catch { /* gone between the check and the kill */ }
    await waitUntil(() => !daemonIsAlive(state), 2000);
  }
  return !daemonIsAlive(state);
}

/** Whether something already listens on the port: a TCP connect is answered, or refused. */
function portOccupied(port: number): Promise<boolean> {
  return new Promise((answer) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    const done = (occupied: boolean) => { socket.destroy(); answer(occupied); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    const giveUp = setTimeout(() => done(false), 500);
    giveUp.unref();
  });
}

/**
 * Takes the lifecycle lock, whole or not at all. The holder's process id is
 * recorded in it, so a lock a killed command left behind is read as stale
 * and cleared when no such process exists; a live holder's lock is never
 * taken, and the attempt answers undefined instead.
 */
function acquireLock(home: string): string | undefined {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); return token; }
    catch {
      try {
        const holder = JSON.parse(readFileSync(join(home, LOCK_FILE), 'utf8')) as { pid?: number };
        if (Number.isInteger(holder.pid) && !processExists(holder.pid!)) { unlinkSync(join(home, LOCK_FILE)); continue; }
      } catch { /* a lock that cannot be read is not ours to remove */ }
      return undefined;
    }
  }
  return undefined;
}
function releaseLock(home: string, token: string): void {
  try {
    const holder = JSON.parse(readFileSync(join(home, LOCK_FILE), 'utf8')) as { token?: string };
    if (holder.token === token) unlinkSync(join(home, LOCK_FILE));
  } catch { /* lock already removed */ }
}
/** Whether a process id exists right now (a permission-denied one does). */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export type DaemonStart =
  | { ok: true; url: string; pid: number; port: number; reused: boolean; note?: string }
  | { ok: false; message: string };

/**
 * Starts the home's shared server, or answers the running one: the one
 * operation both `madarch start` and the non-blocking `new`/`init` call.
 * The app the wikis read is built first, as the foreground serve builds it.
 */
export async function ensureDaemon(options: { home?: string; port?: number; appFolder?: string; buildCommand?: string; env?: ServeEnv; print?: (line: string) => void }): Promise<DaemonStart> {
  const print = options.print ?? ((line: string) => console.log(line));
  const port = options.port ?? 4180;
  const built = ensureBuilt({ appFolder: options.appFolder, buildCommand: options.buildCommand, env: options.env }, print);
  if (!built.ok) return { ok: false, message: built.message };
  const home = homePath(options.home);
  let lock: string | undefined;
  try { mkdirSync(home, { recursive: true }); }
  catch (error) { return { ok: false, message: `the products home ${home} cannot be used for the daemon state: ${(error as Error).message}` }; }
  try { lock = acquireLock(home); }
  catch (error) { return { ok: false, message: `the daemon state under ${home} cannot be locked: ${(error as Error).message}` }; }
  if (lock === undefined) return { ok: false, message: `another madarch lifecycle operation is active or left a lock at ${join(home, LOCK_FILE)}; inspect and remove a stale lock before retrying` };
  try { return await ensureDaemonUnderLock(home, port, built.dist); }
  finally { releaseLock(home, lock); }
}

async function ensureDaemonUnderLock(home: string, port: number, appDist: string): Promise<DaemonStart> {
  const existing = readState(home);
  if (existing !== undefined && daemonIsAlive(existing)) {
    return { ok: true, url: `http://127.0.0.1:${existing.port}`, pid: existing.pid, port: existing.port, reused: true, note: existing.port !== port ? `the running daemon keeps port ${existing.port}; --port ${port} was ignored` : undefined };
  }
  if (existsSync(statePath(home))) clearState(home);
  if (await portOccupied(port)) {
    return { ok: false, message: `the daemon did not start: port ${port} on 127.0.0.1 is already held by another process — name another --port, or stop what holds this one` };
  }
  let log: number;
  try { log = openSync(logPath(home), 'a'); }
  catch (error) { return { ok: false, message: `the daemon log at ${logPath(home)} cannot be written: ${(error as Error).message}` }; }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const script = fileURLToPath(new URL('../../scripts/madarch.ts', import.meta.url));
  const proc = spawn('bun', [script, 'daemon-serve', '--home', home, '--port', String(port)], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, MADARCH_DAEMON_TOKEN: token, MADARCH_APP_DIST: appDist } });
  proc.unref();
  // A spawn that cannot even happen (a PATH without bun) is a failed start,
  // not an uncaught error on a process the state file already names.
  const childFault: { message?: string } = {};
  proc.once('error', (error) => { childFault.message = (error as Error).message; });
  const state: DaemonState = { pid: proc.pid!, port, startedAt: Date.now(), home, token };
  try { saveState(home, state); } catch (error) {
    await stopProcess(state);
    clearState(home);
    return { ok: false, message: `could not save the daemon state at ${statePath(home)}: ${(error as Error).message}` };
  }
  // The child is ready when its listener answers, not merely when the
  // process exists: the answer waits for the port, and a child that dies
  // while starting ends the wait early.
  let died = false;
  const ready = await waitUntil(async () => {
    if (!daemonIsAlive(state)) { died = true; return true; }
    try { const response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) return true; } catch { /* the listener is still binding */ }
    return false;
  }, 8000);
  if (ready && !died && daemonIsAlive(state)) return { ok: true, url: `http://127.0.0.1:${port}`, pid: state.pid, port, reused: false };
  await stopProcess(state);
  const current = readState(home);
  const survived = daemonIsAlive(state);
  // A record for a daemon that is really gone goes; a record whose process
  // could not be stopped stays, so `stop` can still find and end it.
  if (!survived && current !== undefined && current.pid === state.pid && current.token === state.token) clearState(home);
  if (childFault.message !== undefined) return { ok: false, message: `the daemon did not start on port ${port}: ${childFault.message}` };
  return survived
    ? { ok: false, message: `the daemon did not start on port ${port} and could not be stopped (pid ${state.pid}); check ${logPath(home)} before retrying` }
    : { ok: false, message: `the daemon did not start on port ${port}; read ${logPath(home)} for its cause` };
}

export async function startDaemon(options: { home?: string; port: number }): Promise<number> {
  const started = await ensureDaemon({ home: options.home, port: options.port });
  if (!started.ok) { console.error(started.message); return 1; }
  console.log(started.reused ? `already running: ${started.url} (pid ${started.pid})` : `started: ${started.url} (pid ${started.pid})`);
  if (started.note !== undefined) console.log(started.note);
  return 0;
}

export function stopDaemon(options: { home?: string }): number {
  const home = homePath(options.home);
  const lock = acquireLock(home);
  if (lock === undefined) { console.error('another daemon lifecycle operation is in progress; retry'); return 1; }
  try {
    const state = readState(home);
    if (state === undefined || !daemonIsAlive(state)) {
      if (existsSync(statePath(home))) clearState(home);
      console.log('not running');
      return 0;
    }
    try { process.kill(state.pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return stopFailure(state);
      // Gone between the liveness check and the kill: nothing to wait for.
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && daemonIsAlive(state)) pause(40);
    if (daemonIsAlive(state)) {
      try { process.kill(state.pid, 'SIGKILL'); } catch { /* gone between the check and the kill */ }
      const killDeadline = Date.now() + 2000;
      while (Date.now() < killDeadline && daemonIsAlive(state)) pause(40);
    }
    if (daemonIsAlive(state)) return stopFailure(state);
    const current = readState(home);
    if (current !== undefined && current.pid === state.pid && current.token === state.token) clearState(home);
    console.log(`stopped: http://127.0.0.1:${state.port} (pid ${state.pid})`);
    return 0;
  } finally { releaseLock(home, lock); }
}

function stopFailure(state: DaemonState): number {
  console.error(`could not stop the daemon pid ${state.pid} at http://127.0.0.1:${state.port}; it may need to be ended by hand`);
  return 1;
}

export function daemonStatus(options: { home?: string }): number {
  const home = homePath(options.home);
  // Read-only, so it takes no exclusive lock: a status during a slow start
  // answers what the state file held, and the start's own record decides.
  const state = readState(home);
  if (state === undefined || !daemonIsAlive(state)) {
    if (existsSync(statePath(home))) clearState(home);
    console.log('not running');
    return 0;
  }
  const listed = listProducts({ home });
  const names = listed.outcome === 'listed' ? listed.products.map((product) => product.name) : [];
  console.log(`running: http://127.0.0.1:${state.port}`);
  console.log(`pid: ${state.pid}`);
  console.log(`uptime: ${Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))}s`);
  console.log(`products: ${names.join(', ') || '(none)'}`);
  return 0;
}

/** The daemon child's own entry (`madarch daemon-serve`): serves every valid product in the home until stopped. */
export async function serveDaemon(options: { home?: string; port: number }): Promise<number> {
  const home = homePath(options.home);
  try {
    const server = await startServer({ productHome: home, appFolder: process.env.MADARCH_APP_DIST, port: options.port, host: '127.0.0.1', startFill });
    await new Promise<void>((resolveDone) => { process.once('SIGTERM', resolveDone); process.once('SIGINT', resolveDone); });
    await server.stop();
    return 0;
  } catch (error) { console.error(`the products server could not start: ${(error as Error).message}`); return 1; }
}
