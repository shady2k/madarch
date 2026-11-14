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

/** Do not report success until every captured application process and store server has ended. */
export function stopWindowsDaemon(state: { pid: number; home: string }, reads: {
  processes?: () => WindowsProcess[] | undefined;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  taskkill?: (pid: number, timeoutMs: number) => { status: number | null; error?: Error; stdout: string; stderr: string };
  pgCtl?: string;
  stopStore?: (program: string, folder: string) => boolean;
  /** A stale daemon record may still need its stores swept, but its PID must not be signaled. */
  storesOnly?: boolean;
  /** The store data folders under the home's knowledge root, or the error that stopped the listing. */
  storeFolders?: () => string[] | Error;
} = {}): boolean {
  const exists = reads.alive ?? alive;
  const snapshot = reads.storesOnly ? [] : (reads.processes ?? processes)();
  if (snapshot === undefined) return false;
  const tree = reads.storesOnly ? [] : applicationProcessTree(state.pid, snapshot);
  if (!reads.processes && !reads.storesOnly) console.error(`Windows stop process tree: ${JSON.stringify(snapshot.filter((row) => tree.includes(row.pid) || tree.includes(row.parent)))}`);
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
  for (const pid of tree) {
    if (!exists(pid)) continue;
    try {
      if (reads.kill) reads.kill(pid);
      else {
        // No /T: the captured targets exclude running store servers, which need pg_ctl's fast shutdown.
        const timeout = deadline - Date.now();
        if (timeout <= 0) throw new Error('the termination budget is exhausted');
        const result = reads.taskkill
          ? reads.taskkill(pid, timeout)
          : spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', timeout });
        if (result.error || result.status !== 0) throw new Error(`taskkill exited ${String(result.status)}: ${result.error?.message ?? ''} ${result.stdout} ${result.stderr}`);
      }
    } catch (error) {
      // Windows can refuse a PID that exited since the snapshot. Still attempt the remaining captured children.
      if (exists(pid)) console.error(`Windows stop could not terminate pid ${pid} (${snapshot.find((row) => row.pid === pid)?.name ?? 'unknown'}): ${String(error)}`);
    }
  }
  const applicationsGone = waitGone(tree, Math.max(0, deadline - Date.now()), exists);
  const pgCtl = reads.pgCtl ?? join(postgresInstallFolder(process.env), 'bin', postgresProgram('pg_ctl'));
  const sweep = (store: { folder: string; pid?: number }): boolean => {
    store.pid ??= capture(store.folder).pid;
    const pidFile = join(store.folder, 'postmaster.pid');
    if (!existsSync(pidFile) && (store.pid === undefined || !exists(store.pid))) return true;
    // The installed binary only: stopping must never download a PostgreSQL build.
    if (!existsSync(pgCtl)) return false;
    const ok = reads.stopStore ? reads.stopStore(pgCtl, store.folder) : (() => {
      const result = spawnSync(pgCtl, ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      return !result.error && result.status === 0;
    })();
    if (!ok) return false;
    if (store.pid !== undefined && !waitGone([store.pid], Math.max(0, deadline - Date.now()), exists)) return false;
    return !existsSync(pidFile);
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
