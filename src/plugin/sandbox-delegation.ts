/**
 * The cgroup layout a plugin sandbox needs (madarch-64o5.86): where the user's systemd manager delegates cpu, memory
 * and pids, madarch moves itself into a child cgroup and gives plugins a sibling cgroup that can hand the controllers
 * on. A cgroup that holds a process cannot hand controllers to its children, so the daemon and the plugins never share
 * one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WHERE = 'src/plugin/sandbox-delegation.ts';
const HERE = fileURLToPath(import.meta.url);
const CGROUP_ROOT = '/sys/fs/cgroup';
const CONTROLLERS = ['cpu', 'memory', 'pids'] as const;

/** The cgroup path this process stands in, from `/proc/self/cgroup`, without a leading slash. */
export function ownCgroupPath(procFile = '/proc/self/cgroup'): string | undefined {
  try {
    const line = readFileSync(procFile, 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    const path = line?.slice(3).trim();
    return path === undefined || path === '' ? undefined : path.replace(/^\/+/, '');
  } catch { return undefined; }
}

/** The controllers a cgroup offers its children. */
function controllersOf(folder: string): string[] {
  try { return readFileSync(join(folder, 'cgroup.controllers'), 'utf8').trim().split(/\s+/u).filter((name) => name !== ''); }
  catch { return []; }
}

/** The controllers a cgroup hands its children. */
function handedOf(folder: string): string[] {
  try { return readFileSync(join(folder, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/u).filter((name) => name !== ''); }
  catch { return []; }
}

/** Whether this machine's user manager already delegates the three controllers somewhere below the session. */
export function userManagerDelegates(root = CGROUP_ROOT, uid = typeof process.getuid === 'function' ? process.getuid() : undefined): boolean {
  if (uid === undefined) return false;
  const userService = join(root, 'user.slice', `user-${String(uid)}.slice`, `user@${String(uid)}.service`);
  const offered = controllersOf(userService);
  const handed = handedOf(userService);
  return CONTROLLERS.every((name) => offered.includes(name) && handed.includes(name));
}

/** Whether a start may put the daemon in a transient delegated user scope: the user manager delegates, and systemd-run stands. */
export function canStartDelegatedScope(root = CGROUP_ROOT): boolean {
  return userManagerDelegates(root) && existsSync(join(root, 'user.slice'));
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
export function prepareSandboxCgroup(env: NodeJS.ProcessEnv = process.env, root = CGROUP_ROOT): DelegationResult | { ok: false; message: string } {
  const named = env['MADARCH_PLUGIN_CGROUP'];
  if (named !== undefined && named !== '') {
    return existsSync(join(named, 'cgroup.controllers'))
      ? { ok: true, parent: named, made: false }
      : { ok: false, message: `${WHERE}:1: ${HERE}: MADARCH_PLUGIN_CGROUP names ${named}, and it is not a cgroup v2 folder on this machine` };
  }
  const own = ownCgroupPath();
  if (own === undefined) return { ok: false, message: `${WHERE}:1: ${HERE}: /proc/self/cgroup names no cgroup v2 folder for this process` };
  const ownFolder = join(root, own);
  const offered = controllersOf(ownFolder);
  const missing = CONTROLLERS.filter((name) => !offered.includes(name));
  if (missing.length > 0) return { ok: false, message: `${WHERE}:1: ${HERE}: ${ownFolder} does not offer the ${missing.join(', ')} controller${missing.length === 1 ? '' : 's'}` };
  // A daemon already placed in its child keeps that layout.
  if (own.endsWith('/daemon')) {
    const parent = join(ownFolder, '..', 'plugins');
    if (existsSync(join(parent, 'cgroup.controllers')) && CONTROLLERS.every((name) => handedOf(parent).includes(name))) return { ok: true, parent, made: false };
  }
  const daemon = join(ownFolder, 'daemon');
  const plugins = join(ownFolder, 'plugins');
  try {
    mkdirSync(daemon, { recursive: true });
    mkdirSync(plugins, { recursive: true });
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: the cgroups ${daemon} and ${plugins} cannot be made: ${(error as Error).message}` };
  }
  try {
    writeFileSync(join(daemon, 'cgroup.procs'), String(process.pid));
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: this process cannot move into ${daemon}: ${(error as Error).message}` };
  }
  const plus = CONTROLLERS.map((name) => `+${name}`).join(' ');
  try {
    writeFileSync(join(ownFolder, 'cgroup.subtree_control'), plus);
    writeFileSync(join(plugins, 'cgroup.subtree_control'), plus);
  } catch (error) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: ${ownFolder} cannot hand ${plus} to its children: ${(error as Error).message}` };
  }
  if (!CONTROLLERS.every((name) => handedOf(plugins).includes(name))) {
    return { ok: false, message: `${WHERE}:1: ${HERE}: ${plugins} did not take ${plus} after the write` };
  }
  env['MADARCH_PLUGIN_CGROUP'] = plugins;
  return { ok: true, parent: plugins, made: true };
}
