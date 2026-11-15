/** Windows terminates processes for SIGTERM, so the stopper itself must release their stores. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { postgresInstallFolder, postgresProgram } from '../adapters/postgres-builds.js';
import { knowledgeRootOf } from './store.js';

export interface WindowsProcess { pid: number; parent: number; name: string; }

/** Running PostgreSQL receives pg_ctl stop; initdb's bootstrap children are part of preparation, not a store server. */
export function applicationProcessTree(pid: number, processes: readonly WindowsProcess[]): number[] {
  const tree = [pid];
  const bootstrap = new Set<number>();
  if (processes.find((row) => row.pid === pid)?.name.toLowerCase() === 'initdb.exe') bootstrap.add(pid);
  for (let index = 0; index < tree.length; index++) {
    for (const child of processes) {
      if (child.parent !== tree[index] || tree.includes(child.pid)) continue;
      const preparing = bootstrap.has(child.parent) || child.name.toLowerCase() === 'initdb.exe';
      if (child.name.toLowerCase() === 'postgres.exe' && !preparing) continue;
      tree.push(child.pid);
      if (preparing) bootstrap.add(child.pid);
    }
  }
  return tree;
}

function processes(): WindowsProcess[] | undefined {
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  for (const program of ['powershell', 'pwsh']) {
    const result = spawnSync(program, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) continue;
    try {
      const value = JSON.parse(result.stdout);
      const rows = Array.isArray(value) ? value : [value];
      return rows.map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, name: row.Name }));
    } catch { /* A failed process listing is not evidence that the tree is gone. */ }
  }
  return undefined;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function pause(): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); }
function waitGone(pids: readonly number[], timeoutMs: number, exists = alive): boolean {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(exists) && Date.now() < deadline) pause();
  return !pids.some(exists);
}

/**
 * Whether this process is store preparation: something initdb started, under the daemon's own root. initdb runs its
 * bootstrap `postgres --boot` through cmd.exe on Windows, so that whole subtree is preparation and never a store
 * server. The walk stops at the root: an initdb an id names above it is another program — Windows reuses ids — and it
 * must not turn the daemon's subtree, which holds a store server, into one swept whole.
 */
function inStorePreparation(pid: number, root: number, processes: readonly WindowsProcess[]): boolean {
  const seen = new Set<number>();
  for (let at = pid; at !== root && !seen.has(at);) {
    seen.add(at);
    const row = processes.find((one) => one.pid === at);
    if (row === undefined) return false;
    if (row.name.toLowerCase() === 'initdb.exe') return true;
    at = row.parent;
  }
  return false;
}

/** Do not report success until every captured application process and store server has ended. */
export function stopWindowsDaemon(state: { pid: number; home: string }, reads: {
  processes?: () => WindowsProcess[] | undefined;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  /** `subtree` is set only where no store server can be under the pid; see the kill loop. */
  taskkill?: (pid: number, timeoutMs: number, subtree: boolean) => { status: number | null; error?: Error; stdout: string; stderr: string };
  pgCtl?: string;
  stopStore?: (program: string, folder: string) => boolean;
  /** A stale daemon record may still need its stores swept, but its PID must not be signaled. */
  storesOnly?: boolean;
  /** The store data folders under the home's knowledge root, or the error that stopped the listing. */
  storeFolders?: () => string[] | Error;
} = {}): boolean {
  const exists = reads.alive ?? alive;
  const snapshot = reads.storesOnly ? [] : (reads.processes ?? processes)();
  if (snapshot === undefined) {
    // The listing is the only thing that can say what the daemon started: a stop that cannot read it cannot end a
    // tree it cannot name, and must not guess.
    console.error(`Windows stop could not read the process list with powershell or pwsh, so the tree of pid ${state.pid} could not be named or ended`);
    return false;
  }
  const nameOf = (pid: number): string => snapshot.find((row) => row.pid === pid)?.name ?? 'unknown';
  const tree = reads.storesOnly ? [] : applicationProcessTree(state.pid, snapshot);
  if (!reads.processes && !reads.storesOnly) console.error(`Windows stop process tree: ${JSON.stringify(tree.map((pid) => snapshot.find((row) => row.pid === pid) ?? { pid }))}`);
  const root = knowledgeRootOf(state.home);
  const listStores = reads.storeFolders ?? ((): string[] | Error => {
    try { return readdirSync(root).map((name) => join(root, name, 'graph', 'pgdata')).filter((folder) => existsSync(folder)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return error instanceof Error ? error : new Error(String(error));
    }
  });
  /** A look says which folders failed and why; a caller decides whether that ends the stop. */
  const look = (when: string): string[] | undefined => {
    const listing = listStores();
    if (!(listing instanceof Error)) return listing;
    console.error(`Windows stop could not list the store folders under ${root} ${when}: ${listing.message}`);
    return undefined;
  };
  const capture = (folder: string): { folder: string; pid?: number } => {
    let pid: number | undefined;
    try { const value = Number(readFileSync(join(folder, 'postmaster.pid'), 'utf8').split('\n')[0]); if (Number.isInteger(value) && value > 0) pid = value; } catch { /* no server recorded */ }
    return { folder, pid };
  };
  // A store being prepared beside this home can hold the folder as it makes it, and Windows refuses the listing then
  // (a sharing violation a moment later does not see). So this look is an optimisation: a store that opens between it
  // and the termination is caught by the look after the tree is gone, and a refusal here says what failed and lets the
  // stop go on.
  const before = look('before the kill');
  const stores = (before ?? []).map((folder) => capture(folder));
  const deadline = Date.now() + 5_000; // The existing daemon TERM + KILL budget, shared by process checks.
  const taskkill = reads.taskkill ?? ((pid: number, timeoutMs: number, subtree: boolean) =>
    spawnSync('taskkill', ['/F', ...(subtree ? ['/T'] : []), '/PID', String(pid)], { encoding: 'utf8', timeout: timeoutMs }));
  // Children before parents: Windows recycles a process id as soon as its holder ends, so a tree walked from the top
  // can wait on an id that already names something else.
  for (const pid of [...tree].reverse()) {
    if (!exists(pid)) continue;
    // /T is what reaches everything a process started after the snapshot: initdb runs its bootstrap `postgres --boot`
    // through cmd.exe, and a bootstrap started between the listing and this kill is in no list. Only a preparation
    // subtree may be ended whole, since a store server is never under one; the daemon's own subtree does hold one,
    // which pg_ctl stops with a fast shutdown, so that subtree is walked, never swept.
    const subtree = inStorePreparation(pid, state.pid, snapshot);
    try {
      if (reads.kill) reads.kill(pid);
      else {
        const timeout = deadline - Date.now();
        if (timeout <= 0) throw new Error('the termination budget is exhausted');
        const result = taskkill(pid, timeout, subtree);
        if (result.error || result.status !== 0) throw new Error(`taskkill${subtree ? ' /T' : ''} exited ${String(result.status)}: ${result.error?.message ?? ''} ${result.stdout} ${result.stderr}`);
      }
    } catch (error) {
      // Windows can refuse a pid that exited since the snapshot. Still attempt the remaining captured children.
      if (exists(pid)) console.error(`Windows stop could not terminate pid ${pid} (${nameOf(pid)}${subtree ? ', store preparation' : ''}): ${String(error)}`);
    }
  }
  let applicationsGone = waitGone(tree, Math.max(0, deadline - Date.now()), exists);
  if (!applicationsGone) {
    // An id Windows recycled while the stop waited holds another process, not the one this tree captured: a listing
    // names what each id holds now, and a captured pid under another name is not a survivor.
    const listing = (reads.processes ?? processes)();
    const survivors = listing === undefined
      ? tree.filter((pid) => exists(pid))
      : listing.filter((row) => tree.includes(row.pid) && row.name === nameOf(row.pid)).map((row) => row.pid);
    applicationsGone = survivors.length === 0;
    if (!applicationsGone) console.error(`Windows stop left ${survivors.map((pid) => `pid ${String(pid)} (${nameOf(pid)})`).join(', ')} running`);
  }
  const pgCtl = reads.pgCtl ?? join(postgresInstallFolder(process.env), 'bin', postgresProgram('pg_ctl'));
  const sweep = (store: { folder: string; pid?: number }): boolean => {
    store.pid ??= capture(store.folder).pid;
    const pidFile = join(store.folder, 'postmaster.pid');
    if (!existsSync(pidFile) && (store.pid === undefined || !exists(store.pid))) return true;
    // The installed binary only: stopping must never download a PostgreSQL build.
    if (!existsSync(pgCtl)) {
      console.error(`Windows stop could not stop the store ${store.folder}: ${pgCtl} is not installed`);
      return false;
    }
    const ok = reads.stopStore ? reads.stopStore(pgCtl, store.folder) : (() => {
      const result = spawnSync(pgCtl, ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      if (result.error || result.status !== 0) console.error(`Windows stop: pg_ctl stop of ${store.folder} exited ${String(result.status)}: ${result.error?.message ?? ''} ${result.stdout} ${result.stderr}`);
      return !result.error && result.status === 0;
    })();
    if (!ok) {
      if (reads.stopStore) console.error(`Windows stop could not stop the store ${store.folder}`);
      return false;
    }
    // A store's server has its own short window: pg_ctl -w already waited for it, and the tree's budget is spent.
    if (store.pid !== undefined && !waitGone([store.pid], 2_000, exists)) {
      console.error(`Windows stop: the store server pid ${String(store.pid)} of ${store.folder} is still running after pg_ctl stop`);
      return false;
    }
    if (existsSync(pidFile)) {
      console.error(`Windows stop: ${pidFile} remains after pg_ctl stop of ${store.folder}`);
      return false;
    }
    return true;
  };
  let stopped = applicationsGone;
  // The stores the first look named are swept whatever the look after them says: a stop never leaves a server running
  // that it knows about.
  for (const store of stores) if (!sweep(store)) stopped = false;
  // A store may have finished opening between the first look and the termination, and only a look taken with the
  // writers gone can name it. Success is claimed only over that look: one that fails cannot say which servers this
  // home holds, so the stop fails with what could not be listed and why.
  const after = look('after the process tree ended');
  if (after === undefined) return false;
  for (const folder of after) {
    if (stores.some((store) => store.folder === folder)) continue;
    const store = capture(folder);
    stores.push(store);
    if (!sweep(store)) stopped = false;
  }
  return stopped;
}
