/** Windows terminates processes for SIGTERM, so the stopper itself must release their stores. */
import { withSpanSync } from '../obs/trace.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { postgresInstallFolder, postgresProgram } from '../adapters/postgres-builds.js';
import { commandLineArguments, preparationInProgress, runsOnDataDir } from '../adapters/postgres-preparation-record.js';
import { endWindowsProcesses, listWindowsProcesses, type WindowsEndResult, type WindowsProcess } from '../adapters/windows-processes.js';
import { knowledgeRootOf } from './store.js';

export type { WindowsEndResult, WindowsProcess };

const MAX_END_ROUNDS = 3;

function processKey(pid: number, created: number): string {
  return `${String(pid)}:${String(created)}`;
}

function collectProcessTree(
  roots: readonly WindowsProcess[],
  processes: readonly WindowsProcess[],
  initialBootstrap: ReadonlySet<number> = new Set(),
): { row: WindowsProcess; bootstrap: boolean }[] {
  const treeRows: WindowsProcess[] = [];
  const treePids = new Set<number>();
  const bootstrap = new Set<number>(initialBootstrap);
  for (const root of roots) {
    if (root.created === undefined || treePids.has(root.pid)) continue;
    treeRows.push(root);
    treePids.add(root.pid);
    if (root.name.toLowerCase() === 'initdb.exe') bootstrap.add(root.pid);
  }
  for (let index = 0; index < treeRows.length; index++) {
    const parent = treeRows[index]!;
    for (const child of processes) {
      if (child.parent !== parent.pid || treePids.has(child.pid)) continue;
      if (child.created === undefined) {
        console.error(`Windows stop ignored pid ${child.pid} (${child.name || 'unknown'}): missing creation time (parent pid ${parent.pid})`);
        continue;
      }
      if (parent.created === undefined || child.created < parent.created) {
        console.error(`Windows stop ignored pid ${child.pid} (${child.name || 'unknown'}): older than pid ${parent.pid}`);
        continue;
      }
      const preparing = bootstrap.has(child.parent) || child.name.toLowerCase() === 'initdb.exe';
      if (child.name.toLowerCase() === 'postgres.exe' && !preparing) continue;
      treeRows.push(child);
      treePids.add(child.pid);
      if (preparing) bootstrap.add(child.pid);
    }
  }
  return treeRows.map((row) => ({ row, bootstrap: bootstrap.has(row.pid) }));
}

/** Running PostgreSQL receives pg_ctl stop; initdb's bootstrap children are part of preparation, not a store server. */
export function applicationProcessTree(pid: number, processes: readonly WindowsProcess[]): number[] {
  const root = processes.find((row) => row.pid === pid);
  if (root === undefined || root.created === undefined) return [];
  return collectProcessTree([root], processes).map((entry) => entry.row.pid);
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
export function stopWindowsDaemon(
  state: { pid: number; home: string },
  ownsRoot: 'stores-only' | ((commandLine: string) => boolean),
  reads: {
    processes?: () => WindowsProcess[] | undefined;
    end?: (targets: readonly { pid: number; created: number }[]) => WindowsEndResult | undefined;
    alive?: (pid: number) => boolean;
    pgCtl?: string;
    stopStore?: (program: string, folder: string) => boolean;
    /** The store data folders under the home's knowledge root, or the error that stopped the listing. */
    storeFolders?: () => string[] | Error;
  } = {},
): boolean {
  const exists = reads.alive ?? alive;
  const listProcesses = reads.processes ?? listWindowsProcesses;
  const endProcesses = reads.end ?? endWindowsProcesses;

  let initialEntries: { row: WindowsProcess; bootstrap: boolean }[] = [];
  if (ownsRoot !== 'stores-only') {
    const snapshot = listProcesses();
    if (snapshot === undefined) {
      // The listing is the only thing that can say what the daemon started: a stop that cannot read it cannot end a
      // tree it cannot name, and must not guess.
      console.error(`Windows stop could not read the process list with powershell or pwsh, so the tree of pid ${state.pid} could not be named or ended`);
      return false;
    }
    const rootRow = snapshot.find((row) => row.pid === state.pid);
    if (rootRow === undefined) {
      if (exists(state.pid)) {
        console.error(`Windows stop could not find live pid ${state.pid} in the process list, so its ownership could not be verified and nothing was ended`);
        return false;
      }
    } else if (rootRow.commandLine === '') {
      console.error(`Windows stop refused pid ${state.pid} (${rootRow.name || 'unknown'}): empty command line`);
      return false;
    } else if (!ownsRoot(rootRow.commandLine)) {
      console.error(`Windows stop refused pid ${state.pid} (${rootRow.name || 'unknown'}): command line is not owned by this target`);
      return false;
    } else if (rootRow.created === undefined) {
      console.error(`Windows stop refused pid ${state.pid} (${rootRow.name || 'unknown'}): missing creation time`);
      return false;
    } else {
      const initialPids = applicationProcessTree(state.pid, snapshot);
      const snapshotByPid = new Map(snapshot.map((row) => [row.pid, row]));
      const bootstrapPids = new Set<number>();
      initialEntries = initialPids.map((pid) => {
        const row = snapshotByPid.get(pid)!;
        const isBootstrap = row.name.toLowerCase() === 'initdb.exe' || (pid !== state.pid && bootstrapPids.has(row.parent));
        if (isBootstrap) bootstrapPids.add(pid);
        return { row, bootstrap: isBootstrap };
      });
      if (!reads.processes) {
        console.error(
          `Windows stop process tree: ${JSON.stringify(
            initialEntries.map(({ row: { pid, parent, name, created } }) => ({ pid, parent, name, created })),
          )}`,
        );
      }
    }
  }

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
  const stores = withSpanSync('stores.capture', { 'file.path': root, 'stores.count': before?.length ?? 0 }, () => (before ?? []).map((folder) => capture(folder)));

  const capturedRows = new Map<string, WindowsProcess>();
  const survivors = new Map<string, WindowsProcess>();
  let endFailed = false;

  let roundEntries = initialEntries;
  for (let round = 1; round <= MAX_END_ROUNDS && roundEntries.length > 0; round++) {
    // Children before parents: end verified targets in reverse BFS order.
    const targets = [...roundEntries].reverse().map((entry) => ({ pid: entry.row.pid, created: entry.row.created! }));
    const roundMap = new Map<number, { row: WindowsProcess; bootstrap: boolean }>();
    for (const entry of roundEntries) {
      capturedRows.set(processKey(entry.row.pid, entry.row.created!), entry.row);
      roundMap.set(entry.row.pid, entry);
    }

    const result = endProcesses(targets);
    if (result === undefined) {
      endFailed = true;
      console.error(`Windows stop could not end the process tree of pid ${state.pid}`);
      break;
    }

    const heldSet = new Set(result.held);
    for (const pid of result.left) {
      const entry = roundMap.get(pid);
      if (entry !== undefined) survivors.set(processKey(entry.row.pid, entry.row.created!), entry.row);
    }
    for (const target of targets) {
      if (heldSet.has(target.pid)) continue;
      if (result.processes.some((row) => row.pid === target.pid && row.created === target.created)) {
        const entry = roundMap.get(target.pid);
        if (entry !== undefined) survivors.set(processKey(entry.row.pid, entry.row.created!), entry.row);
      }
    }

    // Reconstruct only the rows held by this round's end call plus result.processes without duplicate (pid, created).
    // Earlier rounds' handles are already closed, so dead PIDs from earlier rounds must not act as straggler roots.
    const combined: WindowsProcess[] = [];
    const combinedKeys = new Set<string>();
    const heldRoots: WindowsProcess[] = [];
    const heldBootstrap = new Set<number>();
    for (const entry of roundEntries) {
      if (!heldSet.has(entry.row.pid)) continue;
      const key = processKey(entry.row.pid, entry.row.created!);
      combinedKeys.add(key);
      combined.push(entry.row);
      if (entry.bootstrap) heldBootstrap.add(entry.row.pid);
      heldRoots.push(entry.row);
    }
    for (const row of result.processes) {
      if (row.created !== undefined) {
        const key = processKey(row.pid, row.created);
        if (combinedKeys.has(key)) continue;
        combinedKeys.add(key);
      }
      combined.push(row);
    }

    const stragglers = heldRoots.length === 0
      ? []
      : collectProcessTree(heldRoots, combined, heldBootstrap).filter(
          (entry) => entry.row.created !== undefined && !capturedRows.has(processKey(entry.row.pid, entry.row.created)),
        );
    if (stragglers.length === 0) break;
    if (round === MAX_END_ROUNDS) {
      for (const entry of stragglers) {
        survivors.set(processKey(entry.row.pid, entry.row.created!), entry.row);
      }
      break;
    }
    roundEntries = stragglers;
  }

  const applicationsGone = !endFailed && survivors.size === 0;
  if (survivors.size > 0) {
    console.error(`Windows stop left ${[...survivors.values()].map((row) => `pid ${String(row.pid)} (${row.name || 'unknown'})`).join(', ')} running`);
  }

  const pgCtl = reads.pgCtl ?? join(postgresInstallFolder(process.env), 'bin', postgresProgram('pg_ctl'));
  const sweep = (store: { folder: string; pid?: number }): boolean => {
    // A store initdb is still making is not a store server: initdb's bootstrap writes the `postmaster.pid` pg_ctl reads,
    // and pg_ctl refuses it ("cannot stop server; single-user server is running"). What a stopped madarch left of that
    // preparation may still write the folder, so it is ended here — by identity, a program whose command line names the
    // folder, and by verified creation time — and success is claimed only when none remains.
    if (preparationInProgress(store.folder)) {
      const findHolders = (rows: readonly WindowsProcess[] | undefined): WindowsProcess[] | undefined =>
        rows?.filter((row) => runsOnDataDir(row.name, commandLineArguments(row.commandLine, 'win32'), store.folder, 'win32'));
      const found = findHolders(listProcesses());
      if (found === undefined) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and the process list could not be read, so it is left as it stands and this stop fails`);
        return false;
      }
      if (found.length === 0) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared, so it is left as it stands and the next open prepares it again`);
        return true;
      }
      const missingCreated = found.filter((row) => row.created === undefined);
      if (missingCreated.length > 0) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and ${missingCreated.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} has no creation time, so it is left as it stands and this stop fails`);
        return false;
      }
      const result = endProcesses(found.map((row) => ({ pid: row.pid, created: row.created! })));
      if (result === undefined) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and ending its holders failed, so it is left as it stands and this stop fails`);
        return false;
      }
      const leftSet = new Set(result.left);
      const remaining = found.filter((row) => leftSet.has(row.pid));
      for (const row of findHolders(result.processes) ?? []) {
        if (!remaining.some((existing) => existing.pid === row.pid && existing.created === row.created)) remaining.push(row);
      }
      if (remaining.length > 0) {
        console.error(`Windows stop: the store ${store.folder} is still being prepared and ${remaining.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} still name it, so this stop fails and the folder is left as it stands`);
        return false;
      }
      console.error(`Windows stop: the store ${store.folder} was still being prepared; its left-over ${found.map((one) => `${one.name} pid ${String(one.pid)}`).join(', ')} were ended, and the next open prepares it again`);
      return true;
    }
    store.pid ??= capture(store.folder).pid;
    const pidFile = join(store.folder, 'postmaster.pid');
    if (!existsSync(pidFile) && (store.pid === undefined || !exists(store.pid))) return true;
    // The installed binary only: stopping must never download a PostgreSQL build.
    if (!existsSync(pgCtl)) {
      console.error(`Windows stop could not stop the store ${store.folder}: ${pgCtl} is not installed`);
      return false;
    }
    const ok = reads.stopStore ? reads.stopStore(pgCtl, store.folder) : (() => {
      const result = withSpanSync('process.run', { 'process.command': pgCtl, 'process.args': ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'] }, (span) => { const answer = spawnSync(pgCtl, ['-D', store.folder, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); span.setAttribute('process.exit_code', answer.status ?? -1); span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? '')); span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? '')); return answer; });
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
