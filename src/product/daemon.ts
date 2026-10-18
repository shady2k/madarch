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
import { existsSync, openSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { connect as netConnect, createServer as netServer } from 'node:net';
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
/** How long a start waits for the child's listener to answer before it reads the start as failed. */
const READY_TIMEOUT_MS = 8000;

const processEnv = process.env as DraftEnv;
function homePath(home?: string): string { return resolve(productsHome(processEnv, home)); }
function statePath(home: string): string { return join(home, STATE_FILE); }
function logPath(home: string): string { return join(home, LOG_FILE); }

/** One port nothing on the machine holds right now, at the address the daemon binds; undefined when no port can be found. */
async function freePort(): Promise<number | undefined> {
  return await new Promise((answer) => {
    const listener = netServer();
    listener.unref();
    listener.once('error', () => answer(undefined));
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(() => answer(port > 0 ? port : undefined));
    });
  });
}

function readState(home: string): DaemonState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8')) as DaemonState;
    if (parsed.home !== home || !Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port) || typeof parsed.token !== 'string') return undefined;
    return parsed;
  } catch { return undefined; }
}

/** The command line of one process id, or undefined when it does not exist. */
function processArgs(pid: number): string | undefined {
  if (process.platform === 'win32') return windowsProcessArgs(pid);
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
}

/**
 * One Windows process's command line, through the system's own process list:
 * Windows keeps no `/proc`, this is the interface a plain program may read
 * there, and another process's environment — which carries the token — is not
 * readable at all. A process that has ended, or one this account may not look
 * at, answers nothing.
 */
function windowsProcessArgs(pid: number): string | undefined {
  const query = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
  // Windows PowerShell ships with every Windows the release supports;
  // PowerShell 7 answers where a machine carries only that, and a program that
  // cannot be started at all is not this command's answer either.
  for (const program of ['powershell', 'pwsh']) {
    const result = spawnSync(program, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 15_000 });
    if (result.error !== undefined || result.status !== 0) continue;
    const said = (result.stdout ?? '').trim();
    return said === '' ? undefined : said;
  }
  return undefined;
}

/**
 * Whether one process's command line is the daemon child of this record: the
 * daemon's own subcommand, this record's home and the port it was started on.
 * A program that merely holds the recorded process id answers none of them.
 */
export function isDaemonCommandLine(args: string, state: { home: string; port: number }): boolean {
  return args.includes('daemon-serve') && args.includes(state.home) && args.includes(`--port ${state.port}`);
}

/**
 * What one read of a started child says about the process behind its id: it
 * runs the daemon of this record (`daemon`); it exists and has not exec'd yet
 * (`starting`); it runs another program (`foreign`); or its process is gone
 * (`ended`).
 */
export type SpawnedChild = 'daemon' | 'starting' | 'foreign' | 'ended';

/**
 * The three reads one judgement of a started child is made of: the command
 * line the platform answers for a process id, whether that process exists at
 * all, and this process's own command line. `ensureDaemon` takes them so a
 * test can put the window between a spawn and the child's exec where it
 * really is — the kernel answers the parent's own command line there — and
 * not wait for a loaded machine to happen to put one under the first check.
 */
export interface ChildReadings {
  args(pid: number): string | undefined;
  ownArgs(): string | undefined;
  exists(pid: number): boolean;
}

/**
 * This process's own command line, read once and kept: a process's own argv
 * cannot change, and every wait asks for it again with every poll — asking
 * Windows for it means starting PowerShell, which is not a price a start's
 * 40 ms poll should pay. A platform that cannot answer at all keeps answering
 * nothing, which is also what it answered first.
 */
let ownCommandLineRead = false;
let ownCommandLine: string | undefined;
function ownCommandLineOfThisProcess(): string | undefined {
  if (!ownCommandLineRead) { ownCommandLineRead = true; ownCommandLine = processArgs(process.pid); }
  return ownCommandLine;
}

/** The real reads: `/proc` (or `ps` where it is absent) and, on Windows, the system's own process list. */
export const childReadings: ChildReadings = {
  args: processArgs,
  ownArgs: ownCommandLineOfThisProcess,
  exists: processExists,
};

/**
 * What one command line answers about a process id. A command line that is
 * still this process's own is the fork's copy of it: `/proc/<pid>/cmdline`
 * answers the parent's argv until the child's exec lands, so a child read
 * that way has not exec'd yet and is still starting, never a foreign program.
 * CI run 46865274's shard 2 read `bun test test/ --shard=2/5 …`, the test
 * runner's own line, out of the pid `madarch new` had just spawned, and
 * `madarch new` failed the start on it (2026-10-18). A command line nothing
 * answers for is the same window on Windows, which lists a process in its
 * process list a moment after it starts: the read waits, it does not judge.
 * A live process that runs something else stays `foreign`, and a record whose
 * pid such a process holds is a stale record, never a daemon.
 */
export function childReading(args: string | undefined, own: string | undefined, state: { home: string; port: number }): SpawnedChild {
  if (args === undefined || args === own) return 'starting';
  return isDaemonCommandLine(args, state) ? 'daemon' : 'foreign';
}

/** One read of a started child, with the platform's existence check first: a process that is not there has ended. */
function readChild(pid: number, state: { home: string; port: number }, reads: ChildReadings): { reading: SpawnedChild; args: string | undefined } {
  if (!reads.exists(pid)) return { reading: 'ended', args: undefined };
  const args = reads.args(pid);
  return { reading: childReading(args, reads.ownArgs(), state), args };
}

/**
 * Whether the recorded token stands in the environment of the process with
 * this id: the check that makes the process certain to be the child this
 * record started, on the platforms that let one process read another's
 * environment. Windows exposes no other process's environment, so there the
 * daemon's own command line is the whole check, and this answers yes.
 */
function daemonTokenMatches(state: DaemonState): boolean {
  if (process.platform === 'win32') return true;
  try {
    return readFileSync(`/proc/${state.pid}/environ`, 'utf8').split('\0').includes(`MADARCH_DAEMON_TOKEN=${state.token}`);
  } catch {
    const env = spawnSync('ps', ['eww', '-p', String(state.pid)], { encoding: 'utf8' });
    return env.status === 0 && env.stdout.includes(`MADARCH_DAEMON_TOKEN=${state.token}`);
  }
}

/**
 * Whether the recorded state names a live Madarch daemon: the recorded
 * process runs the daemon's own subcommand for this home and port, and —
 * where the platform lets one process read another's environment — carries
 * the recorded token. The token makes it certain the process is the child this
 * record started, never a recycled id; Windows exposes no other process's
 * environment, so there the daemon's own command line is the whole check.
 * A child that has not exec'd yet is deliberately not this: `readChild`
 * answers `starting` for it, and only the wait of the start that spawned it
 * may read that as a child on its way to the daemon
 * (`ensureDaemonUnderLock`).
 */
function daemonIsAlive(state: DaemonState, reads: ChildReadings = childReadings): boolean {
  return readChild(state.pid, state, reads).reading === 'daemon' && daemonTokenMatches(state);
}

function saveState(home: string, state: DaemonState): void { writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function clearState(home: string): void { try { unlinkSync(statePath(home)); } catch { /* already gone */ } }

/** Yields to other work without a busy loop; the lifecycle waits below poll with it. */
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/**
 * The bundle marker in a compiled binary's own paths: `$bunfs` on Linux and
 * macOS (measured in the release on 2026-10-18: `file:///$bunfs/root/<binary>`)
 * and `~BUN` on Windows (measured by the same day's review out of a
 * `--target=bun-windows-x64` build: `B:/~BUN/root/<binary>.exe`). The
 * separators around it are the bundle's own, whichever the platform spells.
 */
const BUNDLE_MARKER = /[/\\](?:\$bunfs|~BUN)[/\\]/;

/**
 * The program and arguments the daemon child is started with. Run from a
 * checkout, that is `bun` and this repository's `scripts/madarch.ts`. Run from
 * a compiled binary, it is the binary itself, started again with
 * `daemon-serve`: the bundle holds the command, and a `bun` has no file to
 * read — the release's own words were `error: Module not found
 * "/scripts/madarch.ts"` on Linux and macOS and `error: Module not found
 * "B:\scripts\madarch.ts"` on Windows (runs 39134773495 and 39135836826).
 *
 * Three measured facts say "this is a bundle", and any one is enough: the
 * embedded files the release carries (an empty list in every source and test
 * run, measured 2026-10-18), the bundle marker in this module's own URL, and a
 * derived script path answering no file. `Bun.main` is deliberately *not* one
 * of them: in `bun test` it is not this program's module — measured on the pod
 * as the test file, and in CI run 39137149685, where trusting it started
 * `bun daemon-serve …` inside a shard and the daemon never came up. A program
 * that is none of the three — a checkout whose script is gone — still starts
 * itself, since that is the only command line left that can answer.
 */
export function daemonCommand(
  home: string,
  port: number,
  options: { scriptPath?: string; scriptExists?: (path: string) => boolean; moduleUrl?: string; embeddedFiles?: readonly unknown[] } = {},
): { command: string; args: string[] } {
  const words = ['daemon-serve', '--home', home, '--port', String(port)];
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL('../../scripts/madarch.ts', import.meta.url));
  const scriptExists = options.scriptExists ?? existsSync;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  // What this program carries inside itself: the release binary embeds the
  // wiki app and the version, and no source or test run embeds anything.
  const embedded = options.embeddedFiles ?? (Bun as unknown as { embeddedFiles?: readonly unknown[] }).embeddedFiles ?? [];
  const bundled = embedded.length > 0 || BUNDLE_MARKER.test(moduleUrl) || !scriptExists(scriptPath);
  if (bundled) return { command: process.execPath, args: words };
  return { command: 'bun', args: [scriptPath, ...words] };
}

/** Polls `ok` until it holds or the timeout passes; answers whether it held. */
async function waitUntil(ok: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ok()) return true;
    pause(40);
  }
  return await ok();
}

/**
 * Ends one daemon process: TERM, then KILL; answers whether it is gone. Every
 * caller here holds a record of a child this process has just spawned, and
 * the TERM comes first, so a child that has not exec'd yet — whose reads say
 * `starting`, not `daemon` (see `childReading`) — is already on its way out
 * when the wait begins; the wait is what a live daemon needs, and it costs a
 * starting child nothing.
 */
async function stopProcess(state: DaemonState, reads: ChildReadings = childReadings): Promise<boolean> {
  try { process.kill(state.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; return true; }
  if (!(await waitUntil(() => !daemonIsAlive(state, reads), 3000))) {
    try { process.kill(state.pid, 'SIGKILL'); } catch { /* gone between the check and the kill */ }
    await waitUntil(() => !daemonIsAlive(state, reads), 2000);
  }
  return !daemonIsAlive(state, reads);
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
  | { ok: true; url: string; pid: number; port: number; reused: boolean; requestedPort?: number; note?: string }
  | { ok: false; message: string };

/**
 * Starts the home's shared server, or answers the running one: the one
 * operation both `madarch start` and the non-blocking `new`/`init` call.
 * The app the wikis read is built first, as the foreground serve builds it.
 *
 * `port` is the port the caller asked for: undefined when it asked for none
 * (the default, 4180), 0 for a free one. The port belongs to the home's
 * server, not to one command: it is fixed when the server starts, and a
 * caller that names another while the server runs is told so (see
 * `ensureDaemonUnderLock`), never served on a port it did not ask for
 * silently.
 */
export async function ensureDaemon(options: { home?: string; port?: number; appFolder?: string; buildCommand?: string; env?: ServeEnv; print?: (line: string) => void; readings?: ChildReadings }): Promise<DaemonStart> {
  const print = options.print ?? ((line: string) => console.log(line));
  // Port 0 names a free port the way the foreground serve reads it: the
  // daemon's state and readiness probe need the real port, so it is found
  // before the child is spawned.
  const asked = options.port;
  let port = asked ?? 4180;
  if (port === 0) {
    const found = await freePort();
    if (found === undefined) return { ok: false, message: 'the daemon could not find a free port on 127.0.0.1; name another --port' };
    port = found;
  }
  const built = ensureBuilt({ appFolder: options.appFolder, buildCommand: options.buildCommand, env: options.env }, print);
  if (!built.ok) return { ok: false, message: built.message };
  const home = homePath(options.home);
  let lock: string | undefined;
  try { mkdirSync(home, { recursive: true }); }
  catch (error) { return { ok: false, message: `the products home ${home} cannot be used for the daemon state: ${(error as Error).message}` }; }
  try { lock = acquireLock(home); }
  catch (error) { return { ok: false, message: `the daemon state under ${home} cannot be locked: ${(error as Error).message}` }; }
  if (lock === undefined) return { ok: false, message: `another madarch lifecycle operation is active or left a lock at ${join(home, LOCK_FILE)}; inspect and remove a stale lock before retrying` };
  try { return await ensureDaemonUnderLock(home, port, asked, built.dist, options.readings ?? childReadings); }
  finally { releaseLock(home, lock); }
}

/**
 * Starts the server under the lifecycle lock, or reuses the running one. The
 * home has one server, so the port it was started on is the home's port: a
 * caller that named another gets the running address and a line saying
 * plainly that its port does not apply and how to move the server there. A
 * caller that named no port (or 0, a free one) is told nothing, since it asked
 * for no particular port.
 */
async function ensureDaemonUnderLock(home: string, port: number, asked: number | undefined, appDist: string, reads: ChildReadings): Promise<DaemonStart> {
  const existing = readState(home);
  if (existing !== undefined && daemonIsAlive(existing, reads)) {
    const elsewhere = asked !== undefined && asked !== 0 && existing.port !== asked;
    return {
      ok: true,
      url: `http://127.0.0.1:${existing.port}`,
      pid: existing.pid,
      port: existing.port,
      reused: true,
      ...(asked === undefined ? {} : { requestedPort: asked }),
      ...(elsewhere
        ? { note: `the running server keeps port ${existing.port}, so --port ${asked} does not apply: stop it (madarch stop --home ${home}) and start it again (madarch start --home ${home} --port ${asked})` }
        : {}),
    };
  }
  if (existsSync(statePath(home))) clearState(home);
  if (await portOccupied(port)) {
    return { ok: false, message: `the daemon did not start: port ${port} on 127.0.0.1 is already held by another process — name another --port, or stop what holds this one` };
  }
  let log: number;
  try { log = openSync(logPath(home), 'a'); }
  catch (error) { return { ok: false, message: `the daemon log at ${logPath(home)} cannot be written: ${(error as Error).message}` }; }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const child = daemonCommand(home, port);
  const proc = spawn(child.command, child.args, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, MADARCH_DAEMON_TOKEN: token, MADARCH_APP_DIST: appDist } });
  proc.unref();
  // A spawn that cannot even happen (a PATH without bun) is a failed start,
  // not an uncaught error on a process the state file already names.
  const childFault: { message?: string } = {};
  proc.once('error', (error) => { childFault.message = (error as Error).message; });
  const state: DaemonState = { pid: proc.pid!, port, startedAt: Date.now(), home, token };
  try { saveState(home, state); } catch (error) {
    await stopProcess(state, reads);
    clearState(home);
    return { ok: false, message: `could not save the daemon state at ${statePath(home)}: ${(error as Error).message}` };
  }
  // The child is ready when its listener answers, not merely when the
  // process exists: the answer waits for the port, and a child that dies or
  // execs into another program ends the wait early. A child that has not
  // exec'd yet is still starting — the kernel answers this process's own
  // command line for it (see `childReading`) — so the wait goes on for it,
  // and a start never fails on the read of a child the kernel has not let
  // exec yet.
  let failed: string | undefined;    // the child ended, or exec'd into another program
  let answered = false;              // its listener answered
  let ours = false;                  // it carried this record's token
  const ready = await waitUntil(async () => {
    const read = readChild(state.pid, state, reads);
    if (read.reading === 'ended') { failed = `the process it started (pid ${state.pid}) had already ended`; return true; }
    if (read.reading === 'foreign') { failed = `the process it started (pid ${state.pid}) was not the daemon of this record; its command line read ${JSON.stringify(read.args)}`; return true; }
    // A child that runs the daemon's own command line is ours only with this
    // record's token; one that is merely `starting` has nothing to check yet.
    if (read.reading !== 'daemon' || !daemonTokenMatches(state)) return false;
    ours = true;
    try { const response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) { answered = true; return true; } } catch { /* the listener is still binding */ }
    return false;
  }, READY_TIMEOUT_MS);
  if (answered && daemonIsAlive(state, reads)) {
    // The facts name the port the caller asked for (0 meaning a free one)
    // beside the one the server took, the way the reused path does.
    return { ok: true, url: `http://127.0.0.1:${port}`, pid: state.pid, port, reused: false, ...(asked === undefined ? {} : { requestedPort: asked }) };
  }
  await stopProcess(state, reads);
  const current = readState(home);
  const survived = daemonIsAlive(state, reads);
  // A record for a daemon that is really gone goes; a record whose process
  // could not be stopped stays, so `stop` can still find and end it.
  if (!survived && current !== undefined && current.pid === state.pid && current.token === state.token) clearState(home);
  if (childFault.message !== undefined) return { ok: false, message: `the daemon did not start on port ${port}: ${childFault.message}` };
  // What the check saw, read before the process is ended: a start whose child
  // ended, one whose process was never the daemon this record names, and one
  // whose daemon never answered all read differently, and the message says
  // which of them happened.
  const why = failed ?? (answered
    ? `the process it started (pid ${state.pid}) answered on port ${port} and then ended`
    : ours
      ? `the process it started (pid ${state.pid}) is the daemon of this record but did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s`
      : `the process it started (pid ${state.pid}) does not carry this record's token and did not answer on port ${port} within ${READY_TIMEOUT_MS / 1000}s`);
  return survived
    ? { ok: false, message: `the daemon did not start on port ${port} and could not be stopped (pid ${state.pid}): ${why}; check ${logPath(home)} before retrying` }
    : { ok: false, message: `the daemon did not start on port ${port}: ${why}; read ${logPath(home)} for its cause` };
}

export async function startDaemon(options: { home?: string; port?: number }): Promise<number> {
  const started = await ensureDaemon({ home: options.home, port: options.port });
  if (!started.ok) { console.error(started.message); return 1; }
  console.log(started.reused ? `already running: ${started.url} (pid ${started.pid})` : `started: ${started.url} (pid ${started.pid})`);
  if (started.note !== undefined) console.log(started.note);
  return 0;
}

export function stopDaemon(options: { home?: string }): number {
  const home = homePath(options.home);
  // Nothing to stop stands where the home does not stand yet, and a stop
  // never creates one; the empty answer matches what status answers there.
  try { if (!statSync(home).isDirectory()) { console.log('not running'); return 0; } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { console.log('not running'); return 0; }
    console.error(`the products home ${home} cannot be read to stop the daemon: ${(error as Error).message}`);
    return 1;
  }
  const lock = acquireLock(home);
  if (lock === undefined) { console.error(`another daemon lifecycle operation is active or left a lock at ${join(home, LOCK_FILE)}; inspect and remove a stale lock before retrying`); return 1; }
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
    // A record no process holds, or one that cannot be read at all, goes; a
    // record whose process exists stays. That process may be a daemon that has
    // not exec'd yet — its command line still reads its starter's, which is
    // what `childReading` answers `starting` for — and a status must never
    // take a starting server's record away, since nothing would then find the
    // server it started. `stop` and the next `start` replace what is stale.
    if (state === undefined || !processExists(state.pid)) clearState(home);
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
