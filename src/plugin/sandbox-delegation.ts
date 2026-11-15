/**
 * The cgroup layout a plugin sandbox needs (madarch-64o5.86): where the user's systemd manager delegates cpu, memory
 * and pids, madarch moves itself into a child cgroup and gives plugins a sibling cgroup that can hand the controllers
 * on. A cgroup that holds a process cannot hand controllers to its children, so the daemon and the plugins never share
 * one.
 *
 * Every file this module reads or writes stands inside a span: the cgroup files are the machine's own answer, and a run
 * that fails here says which read or write it failed at. The cgroup files' contents are read as the format states them —
 * one line of controller names separated by spaces — never matched as text.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSpan } from '../obs/trace.js';

const WHERE = 'src/plugin/sandbox-delegation.ts';
const HERE = fileURLToPath(import.meta.url);
const CGROUP_ROOT = '/sys/fs/cgroup';
const CONTROLLERS = ['cpu', 'memory', 'pids'] as const;

/**
 * The names a cgroup v2 file holds: its one line, split at the separator the format uses (a space), with the empty
 * pieces between repeated spaces dropped and each name taken as it stands.
 */
function controllerNames(text: string): string[] {
  const names: string[] = [];
  for (const part of text.trim().split(' ')) {
    if (part !== '') names.push(part);
  }
  return names;
}

/** The cgroup path one line of `/proc/self/cgroup` names, as the cgroup root sees it, or undefined when the line is no v2 line. */
function cgroupPathOf(line: string): string | undefined {
  // The format is `hierarchy-ID:controller-list:cgroup-path`; a cgroup v2 line has the id 0 and no controller list.
  const first = line.indexOf(':');
  if (first < 0) return undefined;
  const second = line.indexOf(':', first + 1);
  if (second < 0) return undefined;
  if (line.slice(0, first) !== '0') return undefined;
  if (line.slice(first + 1, second) !== '') return undefined;
  const path = line.slice(second + 1);
  if (path === '') return undefined;
  // The line names an absolute path; the answer is that path below the cgroup root, as path functions state it.
  return posix.relative('/', posix.normalize(path));
}

/** The cgroup path this process stands in, from `/proc/self/cgroup`, without a leading slash. */
export async function ownCgroupPath(procFile = '/proc/self/cgroup'): Promise<string | undefined> {
  const read = (): string | undefined => {
    try {
      const text = readFileSync(procFile, 'utf8');
      for (const line of text.split('\n')) {
        const path = cgroupPathOf(line);
        if (path !== undefined && path !== '') return path;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  return await withSpan('sandbox.cgroup.own', { 'madarch.cgroup.file': procFile }, async () => read());
}

/** The controllers a cgroup offers its children, read from its own `cgroup.controllers`. */
async function controllersOf(folder: string): Promise<string[]> {
  const read = (): string[] => {
    try {
      const text = readFileSync(join(folder, 'cgroup.controllers'), 'utf8');
      return controllerNames(text);
    } catch {
      return [];
    }
  };
  return await withSpan('sandbox.cgroup.controllers', { 'madarch.cgroup.folder': folder }, async () => read());
}

/** The controllers a cgroup hands its children, read from its own `cgroup.subtree_control`. */
async function handedOf(folder: string): Promise<string[]> {
  const read = (): string[] => {
    try {
      const text = readFileSync(join(folder, 'cgroup.subtree_control'), 'utf8');
      return controllerNames(text);
    } catch {
      return [];
    }
  };
  return await withSpan('sandbox.cgroup.handed', { 'madarch.cgroup.folder': folder }, async () => read());
}

/** Whether this machine's user manager already delegates the three controllers somewhere below the session. */
export async function userManagerDelegates(root = CGROUP_ROOT, uid = typeof process.getuid === 'function' ? process.getuid() : undefined): Promise<boolean> {
  if (uid === undefined) return false;
  const userService = join(root, 'user.slice', `user-${String(uid)}.slice`, `user@${String(uid)}.service`);
  const offered = await controllersOf(userService);
  const handed = await handedOf(userService);
  return CONTROLLERS.every((name) => offered.includes(name) && handed.includes(name));
}

/** Whether a start may put the daemon in a transient delegated user scope: the user manager delegates, and systemd-run stands. */
export async function canStartDelegatedScope(root = CGROUP_ROOT): Promise<boolean> {
  return await userManagerDelegates(root) && existsSync(join(root, 'user.slice'));
}

/** The command that starts a daemon in a transient delegated user scope, with its real pid written for the caller. */
export function delegatedScopeCommand(command: string, args: readonly string[], pidFile: string, unit: string): { command: string; args: string[] } {
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--unit', unit, '-p', 'Delegate=yes', '--', '/bin/sh', '-c', 'echo $$ > "$1"; shift; exec "$@"', 'sh', pidFile, command, ...args],
  };
}

export interface DelegationResult {
  readonly ok: true;
  readonly parent: string;
  /** Whether this call made the layout; false when it was already there. */
  readonly made: boolean;
}

/**
 * Gives this process plugins' cgroup: a child `daemon` holds this process, a sibling `plugins` hands cpu, memory and
 * pids to each plugin's cgroup. Called once at start; a second call answers the layout it finds.
 */
export async function prepareSandboxCgroup(env: NodeJS.ProcessEnv = process.env, root = CGROUP_ROOT): Promise<DelegationResult | { ok: false; message: string }> {
  const named = env['MADARCH_PLUGIN_CGROUP'];
  if (named !== undefined && named !== '') {
    return existsSync(join(named, 'cgroup.controllers'))
      ? { ok: true, parent: named, made: false }
      : { ok: false, message: `${WHERE}:1: ${HERE}: MADARCH_PLUGIN_CGROUP names ${named}, and it is not a cgroup v2 folder on this machine` };
  }
  const own = await ownCgroupPath();
  if (own === undefined) return { ok: false, message: `${WHERE}:1: ${HERE}: /proc/self/cgroup names no cgroup v2 folder for this process` };
  const ownFolder = join(root, own);
  const offered = await controllersOf(ownFolder);
  const missing = CONTROLLERS.filter((name) => !offered.includes(name));
  if (missing.length > 0) return { ok: false, message: `${WHERE}:1: ${HERE}: ${ownFolder} does not offer the ${missing.join(', ')} controller${missing.length === 1 ? '' : 's'}` };
  // A daemon already placed in its child keeps that layout.
  if (own.endsWith('/daemon')) {
    const parent = join(ownFolder, '..', 'plugins');
    const handed = await handedOf(parent);
    if (existsSync(join(parent, 'cgroup.controllers')) && CONTROLLERS.every((name) => handed.includes(name))) return { ok: true, parent, made: false };
  }
  const daemon = join(ownFolder, 'daemon');
  const plugins = join(ownFolder, 'plugins');
  // The three steps of the layout each reach the cgroup filesystem, and each runs inside the span of its own step: the
  // span opens in this function and encloses the call that writes.
  const makeFolders = (): void => {
    mkdirSync(daemon, { recursive: true });
    mkdirSync(plugins, { recursive: true });
  };
  const moveIntoDaemon = (): void => {
    writeFileSync(join(daemon, 'cgroup.procs'), String(process.pid));
  };
  const hand = (plus: string): void => {
    writeFileSync(join(ownFolder, 'cgroup.subtree_control'), plus);
    writeFileSync(join(plugins, 'cgroup.subtree_control'), plus);
  };
  try {
    await withSpan('sandbox.cgroup.mkdir', { 'madarch.cgroup.folder': plugins }, async () => makeFolders());
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: the cgroups ${daemon} and ${plugins} cannot be made: ${(error as Error).message}` };
  }
  try {
    await withSpan('sandbox.cgroup.move', { 'madarch.cgroup.folder': daemon }, async () => moveIntoDaemon());
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: this process cannot move into ${daemon}: ${(error as Error).message}` };
  }
  const plus = CONTROLLERS.map((name) => `+${name}`).join(' ');
  try {
    await withSpan('sandbox.cgroup.hand', { 'madarch.cgroup.folder': ownFolder }, async () => hand(plus));
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: ${ownFolder} cannot hand ${plus} to its children: ${(error as Error).message}` };
  }
  const taken = await handedOf(plugins);
  if (!CONTROLLERS.every((name) => taken.includes(name))) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: ${plugins} did not take ${plus} after the write` };
  }
  env['MADARCH_PLUGIN_CGROUP'] = plugins;
  return { ok: true, parent: plugins, made: true };
}
