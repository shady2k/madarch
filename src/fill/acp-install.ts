/**
 * Installing an agent's ACP adapter into madarch's own folder, on a person's
 * yes (the owner's decision of 2026-10-19 recorded on madarch-tzte.6): the
 * adapter is fetched from npm on that registry's terms, pinned to the version
 * madarch expects, and unpacked under `<madarch home>/agents/<agent>` — never
 * into a global prefix, never as root. madarch fetches a package and nothing
 * else: the agent's own sign-in stays the agent's, and no credential of the
 * person's is asked for, read or kept.
 *
 * Why a prefix of madarch's own rather than the machine's PATH: a version that
 * moves with madarch cannot move under a person's other tools, and a second
 * madarch on the same machine can pin another version without a fight. The
 * probe searches that folder before PATH (`src/fill/acp-probe.ts`), so what
 * madarch installed is what madarch then starts.
 *
 * Every failure names the folder, the package and its version, and the end of
 * what npm said: a person reading a refusal needs to know what to run by hand.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { constants as fsConstants, accessSync } from 'node:fs';
import { join } from 'node:path';
import { acpAdapterBinFolder, acpAgentFolder, adapterInstallCommand, type AcpAdapterCatalogueEntry } from './acp-probe.js';
import { resolveExecutable } from './acp.js';
import { homeFromEnv, type DraftEnv } from '../product/home.js';

/** How an install ended: done, refused before anything ran, or failed while it ran. */
export type AcpInstallResult =
  | { outcome: 'installed'; folder: string; executable: string; command: string; output: string }
  | { outcome: 'refused'; message: string }
  | { outcome: 'failed'; message: string };

export interface AcpInstallOptions {
  /** The environment the homes and PATH are read from; the process's unless given. */
  env?: DraftEnv;
  /** The person's home; the environment's `HOME` unless given. */
  home?: string;
  /** How long npm may run before it is stopped, in milliseconds. */
  timeoutMs?: number;
  /** The user the install runs as: the process's own, unless a test names one. */
  uid?: number;
  /** The program that installs; `npm` on PATH unless a test names one. */
  npm?: string;
  /** The registry the install reads; npm's own unless a test names one. */
  registry?: string;
}

/** How much of npm's own output a report keeps. */
const OUTPUT_LIMIT = 4_096;
/** A real install of the two adapters took 1 min 21 s (madarch-tzte.22.4), so this is generous. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** How long npm has to end after SIGTERM before SIGKILL, in milliseconds. */
const KILL_GRACE_MS = 2_000;

/** Whether a path is a program this machine can run. */
function isProgram(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The version a manifest in `folder` names, or `undefined` when there is none to read. */
function manifestVersion(folder: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * npm writes the registry credentials of a person's own `.npmrc` into its
 * errors — `//registry/:_authToken=…`, a password in a URL, a bearer token —
 * and madarch shows npm's own words to the person and keeps them in the log
 * line. Every one of those is masked here first: an install's failure is
 * diagnosed from the package, the folder and the version, never from a
 * credential that happened to be in the output.
 */
export function redactInstallerOutput(text: string): string {
  return text
    // A password inside a registry URL: //user:secret@host.
    .replace(/(\/\/[^\s:@/]+:)[^\s@]+@/g, '$1***@')
    // A credential in .npmrc form, plain or as JSON: _authToken=…, "_auth": "…".
    .replace(/(_(?:authToken|auth|password)"?\s*[=:]\s*"?)\S+/gi, '$1***')
    // A token in a query string or an authorization header.
    .replace(/([?&](?:access_token|token)=)[^\s&"']+/gi, '$1***')
    .replace(/\b(Bearer|token)\s+"?[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, 'npm_***');
}

/**
 * Install `entry`'s adapter into madarch's own folder for that agent. Nothing
 * is installed unless the entry names an npm package, the machine has npm,
 * and this process is not root; each of those is a refusal that names what to
 * do instead. The package is installed at the version the catalogue pins, and
 * the version on disk is read back and compared: an install that unpacked
 * another version is a failure, not a success.
 *
 * A failed install leaves no tree behind: a folder that did not hold the
 * pinned adapter before this attempt is removed when the attempt fails, so the
 * probe can never report an adapter that madarch just said it could not
 * install. A folder that already held the pinned version is left as it was.
 */
export async function installAcpAdapter(entry: AcpAdapterCatalogueEntry, options: AcpInstallOptions = {}): Promise<AcpInstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? homeFromEnv(env);
  const folder = acpAgentFolder(entry, env, home);
  const where = 'src/fill/acp-install.ts:installAcpAdapter';
  if (entry.install.kind !== 'npm') {
    return { outcome: 'refused', message: `${where}: madarch has no package to install for ${entry.label}: ${entry.install.note}. ${adapterInstallCommand(entry, folder)}` };
  }
  const name = entry.install.package;
  const version = entry.install.version;
  const command = adapterInstallCommand(entry, folder);
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === 0) {
    return { outcome: 'refused', message: `${where}: madarch does not install an agent adapter as root: it installs ${name} ${version} into ${folder} as the person who runs madarch, never with sudo. Run madarch as that person, or install it by hand with: ${command}` };
  }
  const npmName = options.npm ?? 'npm';
  const pathValue = env.PATH ?? process.env.PATH ?? '';
  const npm = resolveExecutable(npmName, pathValue);
  if (npm === undefined) {
    return { outcome: 'refused', message: `${where}: madarch cannot install ${name} ${version} into ${folder}: no program named ${JSON.stringify(npmName)} is executable on PATH (${JSON.stringify(pathValue)}). Install Node.js and npm, or install the adapter by hand with: ${command}` };
  }
  /**
   * What the folder held before this attempt. Only a folder this attempt made
   * from nothing is removed on failure: a folder that already holds some
   * version of the package is a person's adapter, and losing it to a failed
   * install would be worse than the failure.
   */
  const before = manifestVersion(folder, name);
  const kept = before === undefined ? '' : ` The tree in ${folder} was left as it was: it holds ${name} ${before}, not the pinned ${version}.`;
  const cleanUp = (): void => {
    if (before !== undefined) return;
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* the failure below names the folder anyway */ }
  };
  try {
    mkdirSync(folder, { recursive: true });
  } catch (error) {
    return { outcome: 'failed', message: `${where}: madarch could not make its own folder ${folder} for ${name} ${version}: ${redactInstallerOutput((error as Error).message)}` };
  }
  const args = ['install', '--prefix', folder, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...(options.registry === undefined ? [] : ['--registry', options.registry]), `${name}@${version}`];
  const run = await runInstaller(npm, args, { env, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (run.outcome === 'timed-out') {
    cleanUp();
    return { outcome: 'failed', message: `${where}: ${npm} did not finish installing ${name} ${version} into ${folder} within ${run.timeoutMs} ms and was stopped: ${redactInstallerOutput(run.output)}${kept}` };
  }
  if (run.code !== 0) {
    const how = run.signal === undefined ? `exited with ${String(run.code)}` : `was ended by ${run.signal}`;
    cleanUp();
    return { outcome: 'failed', message: `${where}: ${npm} install of ${name} ${version} into ${folder} ${how}: ${redactInstallerOutput(run.output)}${kept}` };
  }
  const installed = manifestVersion(folder, name);
  if (installed !== version) {
    cleanUp();
    return { outcome: 'failed', message: `${where}: ${npm} exited 0 but ${join(folder, 'node_modules', ...name.split('/'), 'package.json')} names ${installed === undefined ? 'no version' : `version ${installed}`}, not the pinned ${version}: ${redactInstallerOutput(run.output)}${kept}` };
  }
  const binFolder = acpAdapterBinFolder(folder);
  const executable = entry.launches.map((launch) => join(binFolder, launch.binary)).find(isProgram);
  if (executable === undefined) {
    cleanUp();
    return { outcome: 'failed', message: `${where}: ${npm} installed ${name} ${version} into ${folder}, but no program named ${entry.launches.map((launch) => launch.binary).join(' or ')} is executable in ${binFolder}: ${redactInstallerOutput(run.output)}${kept}` };
  }
  return { outcome: 'installed', folder, executable, command, output: redactInstallerOutput(run.output) };
}

type RunOutcome =
  | { outcome: 'done'; code: number | null; signal: NodeJS.Signals | undefined; output: string }
  | { outcome: 'timed-out'; timeoutMs: number; output: string };

/**
 * Run the installer, keep the end of what it said, and stop it past its bound.
 *
 * The install runs in this process's own environment with the caller's over
 * it, so npm inherits the person's `HOME`, their `.npmrc` and whatever registry
 * settings madarch itself was started with; only a variable the caller names is
 * overridden. A run past its bound is signalled as a process group — SIGTERM,
 * then SIGKILL after the grace — and the promise settles only once the group
 * has ended and its output is closed, so a tree the installer was still writing
 * is never removed underneath it and its last words reach the failure message.
 */
function runInstaller(program: string, args: readonly string[], options: { env: DraftEnv; timeoutMs: number }): Promise<RunOutcome> {
  return new Promise((settle) => {
    const child = spawn(program, [...args], { env: { ...process.env, ...options.env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    const keep = (chunk: Buffer | string): void => { output = (output + String(chunk)).slice(-OUTPUT_LIMIT); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    let settled = false;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    timer.unref?.();
    const settleOnce = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) settle({ outcome: 'timed-out', timeoutMs: options.timeoutMs, output: output.trim() });
      else settle({ outcome: 'done', code, signal: signal ?? undefined, output: output.trim() });
    };
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // `close` is the end of the run: the program has ended *and* the pipes are
    // shut, so the output is whole. `exit` alone may come first, and a helper
    // holding the pipes may keep `close` from ever firing.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => { settleOnce(code, signal); });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      setTimeout(() => settleOnce(exitCode, exitSignal), 100).unref?.();
    });
    child.once('error', (error: Error) => {
      output = `${output}${output === '' ? '' : '\n'}${error.message}`.slice(-OUTPUT_LIMIT);
      settleOnce(null, null);
    });
  });
}

