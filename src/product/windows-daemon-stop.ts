import { startupBegin, type StartupEvidence } from '../obs/log.js';
/** Windows terminates processes for SIGTERM, so the stopper itself must release their stores. */
import { withSpanSync } from '../obs/trace.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { postgresInstallFolder, postgresProgram } from '../adapters/postgres-builds.js';
import { commandLineArguments, preparationInProgress, runsOnDataDir } from '../adapters/postgres-preparation-record.js';
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
    const result = withSpanSync('process.run', { 'process.command': program, 'process.args': ['-NoProfile', '-NonInteractive', '-Command', query] }, (span) => { const answer = spawnSync(program, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 15_000 }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; });
    if (result.error || result.status !== 0) continue;
    try {
      const value = JSON.parse(result.stdout);
      const rows = Array.isArray(value) ? value : [value];
      return rows.map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, name: row.Name }));
    } catch { /* A failed process listing is not evidence that the tree is gone. */ }
  }
  return undefined;
}

/** The processes of a Windows machine, by command line; undefined when the listing cannot be read. */
function windowsProcesses(): { pid: number; name: string; commandLine: string }[] | undefined {
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const answer = withSpanSync('process.run', { 'process.command': 'powershell', 'process.args': ['-NoProfile', '-NonInteractive', '-Command', query] }, (span) => { const answer = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 15_000 }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; });
  if (answer.error !== undefined || answer.status !== 0) return undefined;
  try {
    const value = JSON.parse(answer.stdout) as { ProcessId: number; Name: string; CommandLine?: string } | { ProcessId: number; Name: string; CommandLine?: string }[];
    const all = Array.isArray(value) ? value : [value];
    return all.map((row) => ({ pid: row.ProcessId, name: row.Name ?? '', commandLine: row.CommandLine ?? '' }));
  } catch { return undefined; }
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
  /** A Windows machine's processes by command line, for a store a preparation is still making. */
  preparationProcesses?: () => { pid: number; name: string; commandLine: string }[] | undefined;
  /** Ends one process, by the identity its command line gives it. */
  endProcess?: (pid: number) => void;
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
    try { return withSpanSync('fs.readdir', { 'file.path': root }, (span) => { const held = readdirSync(root); span.setAttribute('file.entries', held.length); return held; }).map((name) => join(root, name, 'graph', 'pgdata')).filter((folder) => existsSync(folder)); }
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
  const capture = (folder: string): { folder: string; pid?: number; holder: 'absent' | 'unreadable' } => {
    let pid: number | undefined;
    let holder: 'absent' | 'unreadable' = 'unreadable';
    try {
      const value = Number(readFileSync(join(folder, 'postmaster.pid'), 'utf8').split('\n')[0]);
      if (Number.isInteger(value) && value > 0) pid = value;
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') holder = 'absent';
    }
    // A PID record supplies no Windows start ticks: neither the holder's identity nor its exit is established.
    return { folder, pid, holder };
  };
  // A store being prepared beside this home can hold the folder as it makes it, and Windows refuses the listing then
  // (a sharing violation a moment later does not see). So this look is an optimisation: a store that opens between it
  // and the termination is caught by the look after the tree is gone, and a refusal here says what failed and lets the
  // stop go on.
  const before = look('before the kill');
  const stores = withSpanSync('stores.capture', { 'file.path': root, 'stores.count': before?.length ?? 0 }, () => (before ?? []).map((folder) => capture(folder)));
  const deadline = Date.now() + 5_000; // The existing daemon TERM + KILL budget, shared by process checks.
  const taskkill = reads.taskkill ?? ((pid: number, timeoutMs: number, subtree: boolean) =>
    withSpanSync('process.run', { 'process.command': 'taskkill', 'process.args': ['/F', ...(subtree ? ['/T'] : []), '/PID', String(pid)] }, (span) => { const answer = spawnSync('taskkill', ['/F', ...(subtree ? ['/T'] : []), '/PID', String(pid)], { encoding: 'utf8', timeout: timeoutMs }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; }));
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
  const sweep = (store: { folder: string; pid?: number; holder: 'absent' | 'unreadable' }): boolean => {
    // A store initdb is still making is not a store server: initdb's bootstrap writes the `postmaster.pid` pg_ctl reads,
    // and pg_ctl refuses it ("cannot stop server; single-user server is running"). What a stopped madarch left of that
    // preparation may still write the folder, so it is ended here — by identity, a program whose command line names the
    // folder, since a pid without a start time may be another process's — and success is claimed only when none remains.
    if (preparationInProgress(store.folder)) {
      const listing = reads.preparationProcesses ?? windowsProcesses;
      // By the argument, never by a substring: a server of `pgdata-other` is another store's.
      const holders = (): { pid: number; name: string }[] | undefined => listing()?.filter((row) => runsOnDataDir(row.name, commandLineArguments(row.commandLine, 'win32'), store.folder, 'win32')).map((row) => ({ pid: row.pid, name: row.name }));
      const found = holders();
      if (found === undefined) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and the process list could not be read, so it is left as it stands and this stop fails`);
        return false;
      }
      for (const holder of found) (reads.endProcess ?? ((pid: number) => { withSpanSync('process.run', { 'process.command': 'taskkill', 'process.args': ['/F', '/PID', String(pid)] }, (span) => { const answer = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 10_000 }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; }); }))(holder.pid);
      const remaining = holders() ?? found;
      if (remaining.length > 0) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and ${remaining.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} still name it, so this stop fails and the folder is left as it stands`);
        return false;
      }
      if (found.length > 0) console.error(`Windows stop: the store ${store.folder} was still being prepared; its left-over ${found.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} were ended, and the next open prepares it again`);
      else console.error(`Windows stop: the store ${store.folder} is still being prepared, so it is left as it stands and the next open prepares it again`);
      return true;
    }
    if (store.pid === undefined) Object.assign(store, capture(store.folder));
    const terminal = startupBegin('cluster.stop', store.folder);
    const pidFile = join(store.folder, 'postmaster.pid');
    // The one look at the record this stop takes: a record the capture found absent and this look finds names no holder,
    // since it appeared between the two, so neither its holder nor its exit is established here and the outcome below is
    // unknown. With the records off the same single look still decides the stop, and it adds no read of its own.
    const present = existsSync(pidFile);
    const appeared = store.pid === undefined && store.holder === 'absent' && present;
    let evidence: StartupEvidence = { ...(store.holder === 'absent' && store.pid === undefined ? {} : { identity: 'unknown' as const }), signal: 'none', command: 'none', probe: 'skipped', ...(appeared ? {} : { holder: store.holder }), ...(store.pid === undefined ? {} : { postmasterPid: store.pid }) };
    try {
    if (!present && (store.pid === undefined || !exists(store.pid))) { if (store.pid === undefined && store.holder === 'absent') terminal('absent', evidence); return true; }
    // The installed binary only: stopping must never download a PostgreSQL build.
    if (!existsSync(pgCtl)) {
      console.error(`Windows stop could not stop the store ${store.folder}: ${pgCtl} is not installed`);
      return false;
    }
    const ok = reads.stopStore ? reads.stopStore(pgCtl, store.folder) : (() => {
      const commandTerminal = startupBegin('cluster.stop.command', store.folder);
      evidence = { ...evidence, command: 'launch-error' };
      try {
      const result = withSpanSync('process.run', { 'process.command': pgCtl, 'process.args': ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'] }, (span) => { const answer = spawnSync(pgCtl, ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; });
      evidence = { ...evidence, command: result.error !== undefined ? ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'launch-error') : result.signal !== null ? 'signal' : 'exit', ...(result.status === null ? {} : { code: result.status }) };
      commandTerminal(!result.error && result.status === 0 ? 'ok' : 'error', evidence);
      if (result.error || result.status !== 0) console.error(`Windows stop: pg_ctl stop of ${store.folder} exited ${String(result.status)}: ${result.error?.message ?? ''} ${result.stdout} ${result.stderr}`);
      return !result.error && result.status === 0;
      } catch (error) { commandTerminal('error', evidence); throw error; }
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
    } finally { terminal('unknown', evidence); }
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
