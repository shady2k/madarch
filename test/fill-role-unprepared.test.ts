import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { startupClock } from '../src/obs/startup-platform.js';
import { closureOf } from '../src/plugin/closure.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { postmasterOfDataDir, processStartTime } from '../src/adapters/postgres-cluster.js';
import { namesAnAttempt, preparingRecordPath, runsOnDataDir, type PreparingRecord } from '../src/adapters/postgres-preparation-record.js';
import { declareFileTextQueue, FILE_TEXT_DEADLINE_MS, readFileTextByBlob } from '../src/knowledge/file-texts.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { MAX_OPEN_RETRY_MS, nextOpenRetryDelay, runFillRole } from '../src/knowledge/fill-role.js';

test('opening retry ceiling leaves six attempts within the file-text deadline', () => {
  expect(MAX_OPEN_RETRY_MS * 6).toBeLessThanOrEqual(FILE_TEXT_DEADLINE_MS);
});

test('opening retry delays double from one second up to five seconds', () => {
  const delays: number[] = [];
  let previous: number | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    previous = nextOpenRetryDelay(previous);
    delays.push(previous);
  }
  expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
});

test('default store preparation installs the file-text queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-file-text-queue-'));
  const owner = await createDatabaseOwner({ store: join(root, 'graph') });
  try {
    await prepareQueueSchema(owner);
    const queue = await createPgBossQueue({ owner, supervise: false });
    try { await declareFileTextQueue(queue); } finally { await queue.stop(); }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each([false, true])('a store without file-texts is reported once and releases its owner before the next pass (close rejects: %s)', async (closeRejects) => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-unprepared-'));
  const store = join(root, 'product', 'graph');
  mkdirSync(store, { recursive: true });
  const preparation = await createDatabaseOwner({ store });
  const opened: { close(): Promise<void> }[] = [];
  try {
    await prepareQueueSchema(preparation, { declarations: [
      { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
    ] });
    const messages: string[] = [];
    let lastCloses = -1;
    let closes = 0;
    const closedByPass: number[] = [];
    expect(await runFillRole({
      knowledgeRoot: root,
      log: (line) => messages.push(line),
      idle: () => {
        expect(closes).toBe(opened.length);
        if (closes !== lastCloses) closedByPass.push(closes);
        lastCloses = closes;
        return closes === 3;
      },
      openStore: async (folder) => {
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        const close = owner.close.bind(owner);
        owner.close = async () => {
          closes++;
          await close();
          if (closeRejects) throw new Error('fixture close failed');
        };
        opened.push(owner);
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    })).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`the store ${join(root, 'product')} could not be opened`);
    expect(messages[0]).toContain('the queue "file-texts" is not prepared');
    expect(opened).toHaveLength(3);
    expect(closedByPass).toEqual([0, 1, 2, 3]);
    expect(closes).toBe(opened.length);
  } finally {
    for (const owner of opened) await owner.close().catch(() => undefined);
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);


test('a store prepared after its first refusal is reopened and answers a file read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-prepared-later-'));
  const knowledgeRoot = join(root, 'knowledge');
  const store = join(knowledgeRoot, 'product', 'graph');
  const product = join(root, 'product');
  mkdirSync(store, { recursive: true });
  mkdirSync(join(product, 'madarch'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const plugin = join(product, 'plugins', 'git');
  cpSync(join(import.meta.dir, '..', 'plugins', 'git'), plugin, { recursive: true });
  writeFileSync(join(product, 'madarch', 'plugins.lock'), `plugins:\n  - id: git\n    version: 1.0.0\n    closure: ${closureOf(plugin).hash}\n    path: plugins/git\n`);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: product, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(product, 'a.ts'), 'export const answer = 42;\n');
  git('add', '-A');
  git('commit', '-qm', 'a file to read');
  const blob = git('rev-parse', 'HEAD:a.ts');
  const preparation = await createDatabaseOwner({ store });
  let stopped = false;
  let opens = 0;
  let closes = 0;
  let role: Promise<number> | undefined;
  let queue: Awaited<ReturnType<typeof createPgBossQueue>> | undefined;
  const messages: string[] = [];
  const refused = Promise.withResolvers<void>();
  try {
    await prepareQueueSchema(preparation, { declarations: [
      { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
    ] });
    role = runFillRole({
      knowledgeRoot,
      log: (line) => { messages.push(line); refused.resolve(); },
      idle: () => stopped,
      openStore: async (folder) => {
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        opens++;
        const close = owner.close.bind(owner);
        owner.close = async () => { closes++; await close(); };
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    });
    await refused.promise;
    expect(closes).toBe(opens);
    await prepareQueueSchema(preparation);
    queue = await createPgBossQueue({ owner: preparation, supervise: false });
    await declareFileTextQueue(queue);
    const answer = await readFileTextByBlob(queue, { product, repository: 'sample', root: product, blob, from: 1, fromColumn: null, to: null });
    expect(answer.text).toBe('export const answer = 42;\n');
    expect(answer.complete).toBe(true);
    expect(opens).toBeGreaterThanOrEqual(2);
    expect(messages).toHaveLength(1);
    stopped = true;
    expect(await role).toBe(0);
    expect(closes).toBe(opens);
  } finally {
    stopped = true;
    await role;
    await queue?.stop();
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);


test('a role ends within its ending budget when a file-read session does not close', async () => {
  // A plugin session that never closes is the one wait of the ending path that no store bounds: the role gives a store's
  // own close `ENDING_MS`, and the file-read sessions get the same budget, so a plugin that hangs cannot keep the role —
  // and with it the store's PostgreSQL server — alive. Before this bound the role awaited that close for ever, and a case
  // waiting for the role (this file's fourth one awaits it in its `finally`) could only end by its own timeout.
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-read-sessions-'));
  const started = performance.now();
  try {
    expect(await runFillRole({
      knowledgeRoot: join(root, 'knowledge'),
      idle: () => true,
      log: () => undefined,
      openStore: async () => { throw new Error('no store stands under an empty knowledge root'); },
      closeReadSessions: () => new Promise<void>(() => undefined),
    })).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(process.platform !== 'linux')('a signalled role asks its store to stop at once, so the server still stops when the api kills the role 300 ms later', async () => {
  // The wait the ending path must not take before it gives a store up: `end()` used to wait out the file-read sessions'
  // close (up to `ENDING_MS / 2`) and only then ask the store to stop, while the api role that started this one sends
  // `SIGKILL` 300 ms after `SIGTERM` (`src/server/http.ts`). A session that never closes then left a store only this
  // process served running after the role was gone. The role is a process of its own here because `end()` ends the
  // process it runs in; its store's PostgreSQL server is one that process installs, starts and holds alone.
  //
  // It runs in a process group of its own (`detached`), and the case ends only what it can prove is the fixture's own:
  // the role child by the pid it was spawned with, a detached `initdb` by the store's preparation record, and the server
  // by its data folder's pid file. Nothing of the fixture outlives the folder this case removes, and no process of another
  // case is ever signalled for merely naming a path this one wrote under.
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-signal-'));
  const knowledgeRoot = join(root, 'knowledge');
  const store = join(knowledgeRoot, 'product', 'graph');
  const readyFile = join(root, 'opened');
  const logFile = join(root, 'role.log');
  const dataDir = join(store, 'pgdata');
  mkdirSync(store, { recursive: true });
  let childPid: number | undefined;
  let childStart: string | undefined;
  let exited: Promise<RoleExit> | undefined;
  let postmasterPid: number | undefined;
  let postmasterStart: string | undefined;
  // What this case's own body threw: the ending never removes a folder under a process of the fixture, and it never
  // replaces that failure with its own complaint about the folder it leaves.
  let failure: unknown;
  try {
    const spawned = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'fill-role-signal-child.ts'), knowledgeRoot, readyFile, logFile], {
      // Its stderr is a pipe: the role writes the moment it asks the store's server to stop as a startup record there
      // (`src/obs/log.ts`), and the case reads that record's own clock reading instead of timing the pipe.
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env: { ...process.env, MADARCH_STARTUP_TIMING: '1', MADARCH_TRACE: 'on' },
    });
    childPid = spawned.pid;
    childStart = spawned.pid === undefined ? undefined : processStartTime(spawned.pid);
    const exit = exitOf(spawned);
    exited = exit;
    // The role's records, as its stderr hands them over. They are read from the start, so a record written before the
    // signal is held as that and never taken for the ending's request.
    const stops = stopRecords(Readable.toWeb(spawned.stderr!) as unknown as ReadableStream<Uint8Array>);
    const endState: { status?: RoleExit } = {};
    void exit.then((status) => { endState.status = status; });
    const opened = performance.now();
    while (!existsSync(readyFile)) {
      if (endState.status !== undefined) throw new Error(`test/fill-role-unprepared.test.ts:1: the role ended (${describeExit(endState.status)}) before it opened a store under ${knowledgeRoot}: ${roleLog(logFile)}`);
      if (performance.now() - opened > 30_000) throw new Error(`test/fill-role-unprepared.test.ts:1: the role opened no store under ${knowledgeRoot}: ${roleLog(logFile)}`);
      await Bun.sleep(20);
    }
    const postmaster = storeServer(dataDir, logFile);
    // The server's kernel start time is taken here, while the case holds it: the ending can then tell that same process
    // from whatever later holds its pid, after `postmaster.pid` may be gone.
    postmasterPid = postmaster;
    postmasterStart = processStartTime(postmaster);
    expect(running(postmaster)).toBe(true);
    expect(stops.before, `the role asked a store to stop ${String(stops.before.length)} time(s) before the signal`).toHaveLength(0);
    // The one clock this process and the role share (`startupClock`): the delay of the stop's dispatch is the role's own
    // reading of it minus the moment the signal was sent, so a slow read of the pipe cannot widen the measurement.
    const sent = startupClock();
    stops.markSignalled();
    spawned.kill('SIGTERM');
    // The api role gives the ending 300 ms and then takes it away, its hard kill reaching the role's own process and
    // never its group (`src/server/http.ts`): the case does the same, so what follows holds for the real ending.
    const killedHard = (async () => {
      const endedByItself = await Promise.race([exit.then(() => true), Bun.sleep(300).then(() => false)]);
      if (endedByItself) return;
      try { spawned.kill('SIGKILL'); } catch { /* already gone */ }
    })();
    const requested = await stops.afterSignal;
    await killedHard;
    const status = await exit;
    const serverStopped = await stopsRunning(postmaster, 10_000);
    console.log('signalled fill role', JSON.stringify({ dispatchedMs: requested === undefined ? null : Math.round(dispatchMs(sent, requested)), exit: describeExit(status), serverStopped }));
    if (requested === undefined) throw new Error(`test/fill-role-unprepared.test.ts:1: the role ended (${describeExit(status)}) without asking the store's server at ${dataDir} to stop: ${roleLog(logFile)}`);
    // A reading of the shared clock and of the same domain, or the difference below is no duration at all.
    expect(requested.clock, `the role's stop record carries no shared clock: ${JSON.stringify(requested)}`).toBe('boottime');
    expect(requested.domain, `the role's stop record is of another clock domain: ${JSON.stringify(requested)}`).toBe(sent.domain);
    const dispatched = dispatchMs(sent, requested);
    // The stop's request left inside the window the api role's `SIGKILL` leaves it: 300 ms, not the 800 ms of the
    // sessions' close it used to wait out.
    expect(dispatched, `the store's stop was dispatched ${String(Math.round(dispatched))} ms after the signal`).toBeGreaterThanOrEqual(0);
    expect(dispatched, `the store's stop was dispatched ${String(Math.round(dispatched))} ms after the signal`).toBeLessThan(300);
    // The role was still giving its store up when the hard kill came, as it is with a session that never closes...
    expect(status.signal, `the role ended by ${describeExit(status)}, so the api's hard kill never reached it`).toBe('SIGKILL');
    // ...and the stop the role had already asked for still ended the server it alone held.
    expect(serverStopped, `test/fill-role-unprepared.test.ts:1: the store's PostgreSQL server ${String(postmaster)} at ${dataDir} still ran 10 s after the role was killed`).toBe(true);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Nothing the case started may outlive its folder, and the folder goes only once every process of the fixture has
    // ended: a server or an `initdb` still holding the data directory — one stuck in `D`, say — would have it erased
    // under it.
    const entries: FixtureProcess[] = [];
    if (childPid !== undefined) entries.push({ role: 'role child', pid: childPid, startTime: childStart });
    const initdb = recordedInitdb(dataDir);
    if (initdb !== undefined) entries.push(initdb);
    const server = serverOf(dataDir, postmasterPid, postmasterStart);
    if (server !== undefined) entries.push(server);
    const outlived = outlivedText(await endFixture(entries, childPid === undefined ? undefined : exited, 5_000), root, dataDir);
    if (outlived === undefined) rmSync(root, { recursive: true, force: true });
    else if (failure === undefined) throw new Error(`${import.meta.path}:281: ${outlived}`);
    else console.error(`${import.meta.path}:282: ${outlived}`);
  }
}, 120_000);

test('an ending names every process of the fixture it could not end, and no folder is removed then', () => {
  // The verdict the case's own `finally` acts on (madarch-64o5.74): a folder is removed only when every verified process
  // of the fixture has ended, and what a person reads otherwise is each survivor's role, ids, identity and state.
  const root = join(tmpdir(), 'madarch-fill-ending');
  const dataDir = join(root, 'knowledge', 'product', 'graph', 'pgdata');
  expect(outlivedText({ survivors: [], childEnded: true }, root, dataDir)).toBeUndefined();
  const left = outlivedText({ survivors: [{ role: 'initdb', pid: 4321, startTime: '99', pgid: 4321, state: 'D' }], childEnded: false }, root, dataDir);
  expect(left).toContain('the role child has not ended');
  expect(left).toContain('initdb pid 4321, process group 4321, start time 99, state D');
  expect(left).toContain(root);
  expect(left).toContain(dataDir);
  expect(left).toContain('test/run-scratch.ts');
});

test.skipIf(process.platform !== 'linux')('an ending leaves a process alone that merely names the folder', async () => {
  // The ending signals a process only when the case could prove it is the fixture's own (madarch-64o5.74): a reader's
  // `tail -f <the role's log>`, or any other program whose command line or environment names the folder, is none of ours.
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-bystander-'));
  const bystander = spawn('sleep', ['300'], { env: { ...process.env, MADARCH_FIXTURE_FOLDER: root }, stdio: 'ignore' });
  try {
    expect(await endFixture([], undefined, 50)).toEqual({ survivors: [], childEnded: true });
    expect(bystander.pid === undefined ? false : running(bystander.pid)).toBe(true);
  } finally {
    if (bystander.pid !== undefined) { try { process.kill(bystander.pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

/** One startup record of the role's ending, as its stderr hands it over (`src/obs/log.ts`). */
interface StartupRecord {
  readonly phase?: string;
  readonly edge?: string;
  readonly clock?: string;
  readonly ns?: string;
  readonly domain?: string;
}

/** How a child of this case ended: `node` reports a killing signal as the signal, never as an exit code. */
interface RoleExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function describeExit(status: RoleExit): string {
  return status.code !== null ? `exit ${String(status.code)}` : `signal ${String(status.signal)}`;
}

/** The moment the role ends, as the code or the signal that took it. */
function exitOf(child: ChildProcess): Promise<RoleExit> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode }); return; }
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
}

/** How long the role took to ask a store's server to stop, in the shared clock's readings both processes wrote. */
function dispatchMs(sent: ReturnType<typeof startupClock>, requested: StartupRecord): number {
  if (requested.ns === undefined) throw new Error(`test/fill-role-unprepared.test.ts:1: the role's stop record carries no clock reading: ${JSON.stringify(requested)}`);
  return Number(BigInt(requested.ns) - BigInt(sent.ns)) / 1_000_000;
}

/** Whether a process stopped within the budget, polled: one finishing its shutdown is still listed for a while. */
async function stopsRunning(pid: number, budgetMs: number): Promise<boolean> {
  const until = performance.now() + budgetMs;
  while (running(pid)) {
    if (performance.now() >= until) return false;
    await Bun.sleep(20);
  }
  return true;
}

/**
 * A process of this case's fixture, with the identity that tells it from whatever later holds its pid: the role child is
 * spawned here, and a detached `initdb` and the store's server are read from the store's own records.
 */
interface FixtureProcess {
  readonly role: 'role child' | 'initdb' | 'postmaster';
  readonly pid: number;
  /** The kernel start time the fixture's own records give it, where one was read. */
  readonly startTime: string | undefined;
}

/** A process of the fixture the ending found still alive, with what a person needs to end it by hand. */
interface SurvivingProcess extends FixtureProcess {
  readonly pgid: number;
  readonly state: string;
}

/** What an ending found: every verified process still alive, and whether the case's own child was taken. */
interface EndingReport {
  readonly survivors: readonly SurvivingProcess[];
  readonly childEnded: boolean;
}

/**
 * Ends the fixture's verified processes and takes the role's own child. A pid is signalled only after this case read what
 * proves the process is the fixture's own, and every pass of the wait asks again with the start time that process had, so
 * a pid the kernel handed out again is never signalled.
 */
async function endFixture(entries: readonly FixtureProcess[], exited: Promise<RoleExit> | undefined, budgetMs: number): Promise<EndingReport> {
  const survivors = await endVerifiedProcesses(entries, budgetMs);
  // The role's own child has not ended until this process has taken its exit: the kernel lists a killed child as a zombie
  // until then, which `/proc` alone cannot tell from a process still running.
  let childEnded = survivors.every((entry) => entry.role !== 'role child');
  if (childEnded && exited !== undefined) childEnded = await Promise.race([exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
  return { survivors, childEnded };
}

/** Ends every verified process of the fixture and waits for it, returning those that outlived the budget. */
async function endVerifiedProcesses(entries: readonly FixtureProcess[], budgetMs: number): Promise<SurvivingProcess[]> {
  const until = performance.now() + budgetMs;
  for (;;) {
    const alive = entries.filter(sameProcess);
    if (alive.length === 0) return [];
    for (const entry of alive) endVerified(entry);
    if (performance.now() >= until) return entries.filter(sameProcess).map(survivorOf);
    await Bun.sleep(20);
  }
}

/** Whether a pid is still exactly the process the fixture verified, by the kernel start time it had then. */
function sameProcess(entry: FixtureProcess): boolean {
  if (!running(entry.pid)) return false;
  if (entry.startTime !== undefined) return processStartTime(entry.pid) === entry.startTime;
  // This case's own child: the kernel cannot give its pid to another process before this one takes its exit.
  return entry.role === 'role child';
}

/**
 * Ends a verified process. The fixture's own detached child goes with its process group, and a store's server only by its
 * pid: the server's children end with their postmaster, and a group is never what a data folder's record verifies.
 */
function endVerified(entry: FixtureProcess): void {
  const group = groupOf(entry.pid);
  if (entry.role !== 'postmaster' && group === entry.pid && group !== groupOf(process.pid)) { try { process.kill(-group, 'SIGKILL'); return; } catch { /* the group is gone */ } }
  try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** A surviving process as a person reads it to end it by hand: its role, its ids, the identity it was verified by, its state. */
function survivorOf(entry: FixtureProcess): SurvivingProcess {
  return { ...entry, pgid: groupOf(entry.pid), state: stateOf(entry.pid) };
}

/** What an ending left alive, or undefined when every process of the fixture ended and the folder may go. */
function outlivedText(report: EndingReport, root: string, dataDir: string): string | undefined {
  const left: string[] = [];
  if (!report.childEnded && report.survivors.every((entry) => entry.role !== 'role child')) left.push('the role child has not ended');
  for (const entry of report.survivors) left.push(`${entry.role} pid ${String(entry.pid)}, process group ${String(entry.pgid)}, start time ${String(entry.startTime)}, state ${entry.state}`);
  if (left.length === 0) return undefined;
  return `the fixture's processes outlived the ending's 5 s budget at ${root} (${left.join('; ')}), so the store's data folder ${dataDir} is left as it stands for test/run-scratch.ts to sweep`;
}

/** A process's state, from the field after its parenthesised name in `/proc/<pid>/stat`: `S`, `R`, `D`, `Z`. */
function stateOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'unknown';
  } catch { return 'gone'; }
}

/** The command line of a process as the kernel lists it, or undefined when it is gone or not this process's to read. */
function commandLineOf(pid: number): string[] | undefined {
  try { return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter((part) => part !== ''); } catch { return undefined; }
}

/**
 * The `initdb` a store's preparation record names, verified as that very process. A detached `initdb` starts before
 * `postmaster.pid` exists, so `madarch.preparing` beside the data directory is the only thing that names it
 * (`src/adapters/postgres-cluster.ts`); a record this project did not write, or a pid the kernel gave out again, is never
 * taken for the fixture's own.
 */
function recordedInitdb(dataDir: string): FixtureProcess | undefined {
  let record: PreparingRecord;
  try { record = JSON.parse(readFileSync(preparingRecordPath(dataDir), 'utf8')) as PreparingRecord; } catch { return undefined; }
  const initdb = record.initdb;
  if (initdb === undefined || !namesAnAttempt(record)) return undefined;
  const argv = commandLineOf(initdb.pid);
  if (argv === undefined || !runsOnDataDir(argv[0] ?? '', argv, dataDir)) return undefined;
  const startTime = initdb.startTime ?? processStartTime(initdb.pid);
  if (startTime === undefined || processStartTime(initdb.pid) !== startTime) return undefined;
  return { role: 'initdb', pid: initdb.pid, startTime };
}

/**
 * The store's server, verified through the adapter's own reading of a data folder's pid file (`postmasterOfDataDir`,
 * `src/adapters/postgres-cluster.ts`) and as the very process the case saw. The pid and start time are the ones read when
 * the case found the server; where the case never got that far, they are read from `postmaster.pid` itself.
 */
function serverOf(dataDir: string, pid: number | undefined, startTime: string | undefined): FixtureProcess | undefined {
  const held = pid !== undefined && startTime !== undefined && stillThatProcess(pid, startTime) ? { pid, startTime } : holderInFile(dataDir);
  if (held === undefined || held.startTime === undefined) return undefined;
  if (!stillThatProcess(held.pid, held.startTime)) return undefined;
  if (!postmasterOfDataDir(dataDir, held.pid)) return undefined;
  return { role: 'postmaster', pid: held.pid, startTime: held.startTime };
}

/** Whether this pid is alive and still the process the kernel start time names. */
function stillThatProcess(pid: number, startTime: string): boolean {
  return running(pid) && processStartTime(pid) === startTime;
}

/** The pid a data folder's `postmaster.pid` names, with the start time the kernel gives it now. */
function holderInFile(dataDir: string): { readonly pid: number; readonly startTime: string | undefined } | undefined {
  try {
    const pid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]!.trim());
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    return { pid, startTime: processStartTime(pid) };
  } catch { return undefined; }
}

/** A process's group, from `/proc/<pid>/stat`: the third field after its parenthesised name. */
function groupOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch { return -1; }
}

/** What the role of this case said, for a failure's message. */
function roleLog(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return '(the role said nothing)'; }
}

/** The pid of the store's PostgreSQL server the role holds, or a failure naming what the role said. */
function storeServer(dataDir: string, logFile: string): number {
  try { return Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]!.trim()); }
  catch { throw new Error(`test/fill-role-unprepared.test.ts:1: the role holds no store's server at ${dataDir}: ${roleLog(logFile)}`); }
}

/** Whether the kernel still lists this process as running: one it ended is a zombie or gone. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch { return false; }
}

/**
 * The role's own records of asking a store's server to stop, read from the startup records its ending writes to its
 * stderr (`src/obs/log.ts`): a record reaches this process through the pipe within a few milliseconds of the call, so
 * the case compares the two clocks' readings instead of timing the pipe. A `cluster.stop` record is written before the
 * lock is asked for and a `cluster.stop.command` one right before `pg_ctl` is started
 * (`src/adapters/postgres-cluster.ts`), so only the latter is the stop's dispatch.
 */
function stopRecords(stream: ReadableStream<Uint8Array>): { readonly before: StartupRecord[]; markSignalled(): void; readonly afterSignal: Promise<StartupRecord | undefined> } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const before: StartupRecord[] = [];
  let pending = '';
  let signalled = false;
  let answer: ((record: StartupRecord | undefined) => void) | undefined;
  const afterSignal = new Promise<StartupRecord | undefined>((resolve) => { answer = resolve; });
  const settle = (record: StartupRecord | undefined): void => { answer?.(record); answer = undefined; };
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { settle(undefined); return; }
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let record: StartupRecord = {};
        try { record = JSON.parse(line) as StartupRecord; } catch { continue; }
        if (record.phase !== 'cluster.stop' && record.phase !== 'cluster.stop.command') continue;
        if (!signalled) { before.push(record); continue; }
        if (record.phase === 'cluster.stop.command' && record.edge === 'begin') settle(record);
      }
    }
  })().catch(() => undefined);
  return { before, markSignalled: () => { signalled = true; }, afterSignal };
}

test('the fill role alone backs off opening an unprepared store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-alone-'));
  const store = join(root, 'product', 'graph');
  const preparation = await createDatabaseOwner({ store });
  let opens = 0;
  let openedAt = 0;
  const retryGaps: number[] = [];
  const messages: string[] = [];
  try {
    await prepareQueueSchema(preparation, { declarations: [
      { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
    ] });
    await preparation.close();
    const started = performance.now();
    expect(await runFillRole({
      knowledgeRoot: root,
      log: (line) => messages.push(line),
      idle: () => performance.now() - started >= 3_000 && opens >= 2,
      openStore: async (folder) => {
        const now = performance.now();
        if (opens > 0) retryGaps.push(now - openedAt);
        openedAt = now;
        opens++;
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    })).toBe(0);
    expect(opens).toBeGreaterThanOrEqual(2);
    expect(opens).toBeLessThanOrEqual(3);
    expect(Math.min(...retryGaps)).toBeGreaterThanOrEqual(1_000);
    expect(messages).toHaveLength(1);
  } finally {
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('changing opening errors are bounded by backoff and do not delay another store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-opening-errors-'));
  mkdirSync(join(root, 'a-broken', 'graph'), { recursive: true });
  const messages: string[] = [];
  const attempts: number[] = [];
  const healthyStore = join(root, 'b-ready', 'graph');
  let healthyOpenedAt: number | undefined;
  let preparation: Awaited<ReturnType<typeof createDatabaseOwner>> | undefined;
  try {
    preparation = await createDatabaseOwner({ store: healthyStore });
    await prepareQueueSchema(preparation);
    const started = performance.now();
    expect(await runFillRole({
      knowledgeRoot: root,
      log: (line) => messages.push(line),
      idle: () => performance.now() - started >= 3_000,
      openStore: async (folder) => {
        if (folder !== healthyStore) {
          attempts.push(performance.now() - started);
          throw new Error(`server failed\n${performance.now()} [${attempts.length}] variable startup log`);
        }
        healthyOpenedAt = performance.now() - started;
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    })).toBe(0);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.length).toBeLessThanOrEqual(3);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1_000);
    expect(healthyOpenedAt).toBeDefined();
    expect(healthyOpenedAt!).toBeLessThan(attempts[1]!);
    expect(messages.length).toBe(attempts.length);
    expect(messages.length).toBeLessThanOrEqual(3);
  } finally {
    await preparation?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
