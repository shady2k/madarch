/** Windows terminates processes for SIGTERM, so the stopper itself must release their stores. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { postgresInstallFolder, postgresProgram } from '../adapters/postgres-builds.js';
import { knowledgeRootOf } from './store.js';

export interface WindowsProcess { pid: number; parent: number; name: string; }

/** Capture the application tree, but never terminate PostgreSQL: it receives a fast pg_ctl stop. */
export function applicationProcessTree(pid: number, processes: readonly WindowsProcess[]): number[] {
  const tree = [pid];
  for (let index = 0; index < tree.length; index++) {
    for (const child of processes) {
      if (child.parent === tree[index] && !tree.includes(child.pid) && child.name.toLowerCase() !== 'postgres.exe') tree.push(child.pid);
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
  pgCtl?: string;
  stopStore?: (program: string, folder: string) => boolean;
  /** A stale daemon record may still need its stores swept, but its PID must not be signaled. */
  storesOnly?: boolean;
} = {}): boolean {
  const exists = reads.alive ?? alive;
  const snapshot = reads.storesOnly ? [] : (reads.processes ?? processes)();
  if (snapshot === undefined) return false;
  const tree = reads.storesOnly ? [] : applicationProcessTree(state.pid, snapshot);
  const root = knowledgeRootOf(state.home);
  let folders: string[] = [];
  try { folders = readdirSync(root).map((name) => join(root, name, 'graph', 'pgdata')).filter((folder) => existsSync(folder)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  const capture = (folder: string): { folder: string; pid?: number } => {
    let pid: number | undefined;
    try { const value = Number(readFileSync(join(folder, 'postmaster.pid'), 'utf8').split('\n')[0]); if (Number.isInteger(value) && value > 0) pid = value; } catch { /* no server recorded */ }
    return { folder, pid };
  };
  const stores = folders.map(capture);
  const deadline = Date.now() + 5_000; // The existing daemon TERM + KILL budget, shared by process checks.
  for (const pid of tree) {
    try { if (reads.kill) reads.kill(pid); else process.kill(pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  }
  if (!waitGone(tree, Math.max(0, deadline - Date.now()), exists)) return false;
  // A store may have finished opening between the first capture and termination.
  try {
    for (const name of readdirSync(root)) {
      const folder = join(root, name, 'graph', 'pgdata');
      if (existsSync(folder) && !stores.some((store) => store.folder === folder)) stores.push(capture(folder));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  for (const store of stores) store.pid ??= capture(store.folder).pid;
  const pgCtl = reads.pgCtl ?? join(postgresInstallFolder(process.env), 'bin', postgresProgram('pg_ctl'));
  let stopped = true;
  for (const store of stores) {
    const pidFile = join(store.folder, 'postmaster.pid');
    if (!existsSync(pidFile) && (store.pid === undefined || !exists(store.pid))) continue;
    // The installed binary only: stopping must never download a PostgreSQL build.
    if (!existsSync(pgCtl)) { stopped = false; continue; }
    const ok = reads.stopStore ? reads.stopStore(pgCtl, store.folder) : (() => {
      const result = spawnSync(pgCtl, ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      return !result.error && result.status === 0;
    })();
    if (!ok) { stopped = false; continue; }
    if (store.pid !== undefined && !waitGone([store.pid], Math.max(0, deadline - Date.now()), exists)) stopped = false;
    if (existsSync(pidFile)) stopped = false;
  }
  return stopped;
}
