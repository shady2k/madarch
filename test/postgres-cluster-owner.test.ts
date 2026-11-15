/**
 * One owner of a store's PostgreSQL cluster across processes (madarch-8bdc.9): the last process using a server stops it,
 * a process that attaches and leaves keeps it answering for the one that opened it, and an open waits for a start
 * another process is making instead of starting a second server of the same store.
 *
 * The cases run real processes: the cluster's rule is a lock the kernel holds, and only a second process can show it.
 */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clusterPaths, clusterQuery, openCluster, processStartTime, stopStoreForExit, CLUSTER_ADMIN_DATABASE, CLUSTER_PORT, CLUSTER_USER } from '../src/adapters/postgres-cluster.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-cluster-owner-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A store folder of this test's own, whose cluster is the case's. */
const storeOf = (name: string): string => join(root, name, 'store');

/** Whether the store's server answers a statement. */
async function answering(store: string): Promise<boolean> {
  const { socketDir } = clusterPaths(store);
  try {
    await clusterQuery({ dataDir: socketDir, socketDir, port: CLUSTER_PORT, user: CLUSTER_USER, bin: '', stop: async () => undefined }, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** The pid `postmaster.pid` names, or null when no line does: a server still there, or gone. */
function postmasterOf(store: string): number | null {
  try {
    const pid = Number(readFileSync(join(clusterPaths(store).dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether a process is still there: one this process may not signal counts as there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}


/** A program really named `postgres`, running on this folder: what a preparation still naming it looks like. */
function postgresHolder(dataDir: string): ReturnType<typeof Bun.spawn> {
  const bin = join(dirname(dataDir), 'fake-postgres');
  const program = join(bin, 'postgres');
  if (!existsSync(program)) { mkdirSync(bin, { recursive: true }); copyFileSync('/bin/yes', program); chmodSync(program, 0o755); }
  return Bun.spawn([program, '--', '-D', dataDir], { stdout: 'ignore', stderr: 'ignore' });
}

/** The child of this test: another process of the binary, with the same store. */
function child(mode: string, store: string, extra?: string, marker?: string) {
  return Bun.spawn(['bun', join(import.meta.dir, 'postgres-cluster-owner-driver.ts'), mode, store, ...(extra === undefined ? [] : [extra]), ...(marker === undefined ? [] : [marker])], { stdout: 'pipe', stderr: 'pipe' });
}

/** Waits until a file exists: the child says it holds what the case needs held. */
async function untilFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(20);
  }
  throw new Error(`the child never wrote ${path}`);
}

test('Windows resolves the shared TCP endpoint and credential from the owned data directory', async () => {
  const result = child('windows-endpoint', storeOf('windows endpoint with spaces'));
  expect(await result.exited).toBe(0);
  expect(JSON.parse(await new Response(result.stdout).text())).toEqual({ host: '127.0.0.1', port: 15432, password: 'private-test-password' });
}, 30_000);

test('one process opening a store twice runs one server, and the last hold stops it', async () => {
  const store = storeOf('twice');
  const first = await openCluster({ ...clusterPaths(store) });
  const second = await openCluster({ ...clusterPaths(store) });
  expect(second.socketDir).toBe(first.socketDir);
  // One hold given back leaves the server answering for the other; the last one stops it.
  await first.stop();
  expect(await answering(store)).toBe(true);
  await second.stop();
  expect(await answering(store)).toBe(false);
}, 120_000);

test('independent stores stop together without blocking the event loop and leave no server alive', async () => {
  const stores = [storeOf('concurrent-stop-a'), storeOf('concurrent-stop-b')];
  const clusters = [];
  try {
    for (const store of stores) clusters.push(await openCluster({ ...clusterPaths(store) }));
    const postmasters = stores.map(postmasterOf);
    expect(postmasters.every((pid) => pid !== null && alive(pid))).toBe(true);
    let stopping = true;
    let tickedDuringStop = false;
    const timer = setTimeout(() => { tickedDuringStop = stopping; }, 20);
    try {
      await Promise.all(clusters.map((cluster) => cluster.stop()));
      stopping = false;
      expect(tickedDuringStop).toBe(true);
      for (let index = 0; index < stores.length; index++) {
        expect(await answering(stores[index]!)).toBe(false);
        expect(postmasterOf(stores[index]!)).toBe(null);
        expect(alive(postmasters[index]!)).toBe(false);
      }
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await Promise.all(clusters.map((cluster) => cluster.stop()));
  }
}, 120_000);

test('a process that attaches and leaves keeps the server answering for the one that started it', async () => {
  const store = storeOf('attached');
  const held = await openCluster({ ...clusterPaths(store) });
  const leaving = child('open-and-leave', store);
  expect(await leaving.exited).toBe(0);
  expect(await new Response(leaving.stdout).text()).toContain('opened');
  // The childs leaving never stops a server another process holds.
  expect(await answering(store)).toBe(true);
  await held.stop();
  expect(await answering(store)).toBe(false);
}, 120_000);

test('a platform whose C library this build does not ask for refuses by name, and the module is loaded there without one', async () => {
  // What the Windows binary of CI run ddaefd9b failed at: a `dlopen` at the module's import, where no store is ever opened.
  // The child loads the module with this box's platform reported as another and opens a store: the module imports, and the
  // open refuses by name instead of loading a library the platform does not have.
  const refusing = child('refuse-platform', storeOf('refused'), 'freebsd');
  expect(await refusing.exited).toBe(0);
  const said = await new Response(refusing.stdout).text();
  expect(said).toContain('refused:');
  expect(said).toContain('freebsd');
  expect(said).toContain('flock(2)');
}, 120_000);

test('a store another process still uses is not stopped for this process\'s exit, and one nobody uses is', async () => {
  // The last resort of a process nothing waits for (madarch-8bdc.12): a role whose server was killed stops the store's
  // server itself. It gives the rule the cluster has — one process using it is enough to leave it running — and the
  // store it stops here was opened by no owner of this process at all, as a role killed before its first pass finds it.
  const store = storeOf('exit');
  const marker = join(root, 'holding.txt');
  const holding = child('hold-store', store, '60000', marker);
  try {
    await untilFile(marker);
    expect(await answering(store)).toBe(true);
    // Another process of the binary uses it: the exit leaves it answering.
    await stopStoreForExit(store);
    expect(await answering(store)).toBe(true);
    // The process that used it is gone: the next exit stops it.
    holding.kill('SIGKILL');
    await holding.exited;
    await stopStoreForExit(store);
    expect(await answering(store)).toBe(false);
    // The server itself is gone, not only its socket: a stop that failed must not pass for one that worked.
    const held = postmasterOf(store);
    expect(held === null || !alive(held)).toBe(true);
  } finally {
    try { holding.kill('SIGKILL'); } catch { /* already gone */ }
  }
}, 120_000);

test('an open waits for a start another process is making, then starts the server it finds nothing answering on', async () => {
  const store = storeOf('waiting');
  const marker = join(root, 'held.txt');
  const holding = child('hold-start', store, '1500', marker);
  try {
    await untilFile(marker);
    const started = performance.now();
    const opened = await openCluster({ ...clusterPaths(store) });
    // The start's lock was held for another 1.5 s: the open stood behind it instead of starting beside it.
    expect(performance.now() - started).toBeGreaterThan(300);
    expect(await answering(store)).toBe(true);
    await opened.stop();
  } finally {
    await holding.exited;
  }
}, 120_000);

test('a folder madarch never recorded preparing is never removed, and the open refuses naming it', async () => {
  // A folder that looks unfinished proves nothing: madarch may not have made it, and a stop or a crash in another
  // program leaves the same files. Only a folder madarch recorded preparing may be removed.
  const store = storeOf('foreign');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'base'), { recursive: true });
  writeFileSync(join(dataDir, 'base', 'someone-elses'), 'kept\n');
  let refusal: Error | undefined;
  try { await openCluster({ ...clusterPaths(store) }); } catch (error) { refusal = error as Error; }
  expect(refusal).toBeDefined();
  expect(refusal?.message).toContain(dataDir);
  expect(refusal?.message).toContain('move');
  expect(readFileSync(join(dataDir, 'base', 'someone-elses'), 'utf8')).toBe('kept\n');
  expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(false);
}, 30_000);

test('an older cluster missing what initdb leaves is refused, never erased', async () => {
  // A cluster of an older or damaged store can lack `base/1`, and its files are the store's data.
  const store = storeOf('older');
  const { dataDir } = clusterPaths(store);
  const opened = await openCluster({ ...clusterPaths(store) });
  await opened.stop();
  rmSync(join(dataDir, 'base', '1'), { recursive: true, force: true });
  rmSync(join(dirname(dataDir), 'madarch.prepared'), { force: true });
  writeFileSync(join(dataDir, 'base', 'kept'), 'still here\n');
  let refusal: Error | undefined;
  try { await openCluster({ ...clusterPaths(store) }); } catch (error) { refusal = error as Error; }
  expect(refusal).toBeDefined();
  expect(refusal?.message).toContain(dataDir);
  expect(readFileSync(join(dataDir, 'base', 'kept'), 'utf8')).toBe('still here\n');
  expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
}, 120_000);

test('a folder our record prepared, whose initdb is gone, is removed and prepared again', async () => {
  // What a stop or a crash during preparation leaves (madarch-64o5.79: the clean install walk): madarch wrote the record
  // before it ran initdb, and initdb is not there any more — neither finished nor running.
  const store = storeOf('recorded');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  writeFileSync(join(dataDir, 'global', 'half-made'), 'partial');
  const ended = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  await ended.exited;
  writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: ended.pid } })}\n`);
  const opened = await openCluster({ ...clusterPaths(store) });
  try {
    expect(existsSync(join(dataDir, 'global', 'half-made'))).toBe(false);
    expect(existsSync(join(dirname(dataDir), 'madarch.prepared'))).toBe(true);
    expect(existsSync(join(dirname(dataDir), 'madarch.preparing'))).toBe(false);
    await clusterQuery(opened, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
  } finally { await opened.stop(); }
}, 120_000);

test('a record naming a pid another process holds is no preparation of ours: the folder is prepared again', async () => {
  // Windows and a busy machine reuse pids: the recorded process must still be the initdb, by its start time, or what the
  // record names is somebody else and the preparation it described is gone.
  const store = storeOf('recycled');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  writeFileSync(join(dataDir, 'global', 'half-made'), 'partial');
  const other = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: other.pid, startTime: '0' } })}\n`);
    const opened = await openCluster({ ...clusterPaths(store), preparationWaitMs: 300 });
    try {
      expect(existsSync(join(dataDir, 'global', 'half-made'))).toBe(false);
      await clusterQuery(opened, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
    } finally { await opened.stop(); }
  } finally {
    other.kill('SIGKILL');
    await other.exited;
  }
}, 120_000);

test('a folder under an initdb our record names, still running, is left as it stands and the open refuses', async () => {
  // The lock of the madarch that started initdb died with it, so another opener reaches the folder while the initdb runs:
  // it waits, then refuses naming the initdb, and never removes what that initdb may still be writing.
  const store = storeOf('preparing');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  writeFileSync(join(dataDir, 'global', 'half-made'), 'partial');
  const initdb = postgresHolder(dataDir);
  try {
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: initdb.pid, startTime: processStartTime(initdb.pid) } })}\n`);
    const started = performance.now();
    let refusal: Error | undefined;
    try { await openCluster({ ...clusterPaths(store), preparationWaitMs: 300 }); } catch (error) { refusal = error as Error; }
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
    expect(refusal).toBeDefined();
  expect(refusal?.message).toContain(dataDir);
    expect(refusal?.message).toContain(String(initdb.pid));
    expect(readFileSync(join(dataDir, 'global', 'half-made'), 'utf8')).toBe('partial');
  } finally {
    initdb.kill('SIGKILL');
    await initdb.exited;
  }
}, 120_000);

test('a whole store is never prepared again, and a cluster made before the record gets it', async () => {
  const store = storeOf('whole');
  const { dataDir } = clusterPaths(store);
  const first = await openCluster({ ...clusterPaths(store) });
  await first.stop();
  const sentinel = join(dataDir, 'madarch.test-sentinel');
  writeFileSync(sentinel, 'kept\n');
  // A cluster prepared before this record existed: the record goes, and the cluster is still the one that is used.
  rmSync(join(dirname(dataDir), 'madarch.prepared'));
  const second = await openCluster({ ...clusterPaths(store) });
  try {
    expect(readFileSync(sentinel, 'utf8')).toBe('kept\n');
    expect(existsSync(join(dirname(dataDir), 'madarch.prepared'))).toBe(true);
    await clusterQuery(second, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
  } finally { await second.stop(); }
}, 120_000);

test('a record of a live initdb outranks what a half-made folder looks like', async () => {
  // A running initdb writes what a whole cluster leaves — `PG_VERSION`, `global/pg_control`, `base/1` — so those files
  // cannot say the cluster is ready while our record says a preparation is under way (codex P1 on 9027bc2a).
  const store = storeOf('preparing artifacts');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  mkdirSync(join(dataDir, 'base', '1'), { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  writeFileSync(join(dataDir, 'global', 'pg_control'), 'partial');
  const initdb = postgresHolder(dataDir);
  try {
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: initdb.pid, startTime: processStartTime(initdb.pid) } })}\n`);
    let refusal: Error | undefined;
    try { await openCluster({ ...clusterPaths(store), preparationWaitMs: 300 }); } catch (error) { refusal = error as Error; }
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(dataDir);
    expect(refusal?.message).toContain(String(initdb.pid));
    expect(readFileSync(join(dataDir, 'global', 'pg_control'), 'utf8')).toBe('partial');
  } finally {
    initdb.kill('SIGKILL');
    await initdb.exited;
  }
}, 120_000);

for (const shape of ['readable', 'unreadable'] as const) {
  test(`a folder carrying our preparing record is prepared again, even when its files look whole (${shape} record)`, async () => {
    // `madarch.prepared`, written only once initdb exits, is the one proof that a cluster is whole. A folder that carries
    // `madarch.preparing` was abandoned by a stop or a crash, and its files cannot say otherwise: initdb's bootstrap
    // writes `PG_VERSION`, `global/pg_control` and `base/1` long before the `postgres` database exists
    // (madarch-64o5.81). A record a crash left half-written still says madarch started the preparation.
    const store = storeOf(`abandoned preparation ${shape}`);
    const { dataDir } = clusterPaths(store);
    const first = await openCluster({ ...clusterPaths(store) });
    await first.stop();
    const sentinel = join(dataDir, 'madarch.test-sentinel');
    writeFileSync(sentinel, 'gone\n');
    const ended = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await ended.exited;
    rmSync(join(dirname(dataDir), 'madarch.prepared'), { force: true });
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), shape === 'readable'
      ? `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: ended.pid } })}\n`
      : '{"version":"test","startedAt":');
    const second = await openCluster({ ...clusterPaths(store) });
    try {
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(dirname(dataDir), 'madarch.prepared'))).toBe(true);
      expect(existsSync(join(dirname(dataDir), 'madarch.preparing'))).toBe(false);
      await clusterQuery(second, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
    } finally { await second.stop(); }
  }, 120_000);
}

test('a store waiting for its server says so every few seconds and refuses with the last attempt\'s reason', async () => {
  // The wait a Windows store makes for its server is driven here with a probe that never answers: the line reaches
  // stderr (the walk reads it) every few seconds, not on every 100 ms attempt, and the refusal names why (madarch-64o5.81).
  const store = storeOf('answer wait');
  const { dataDir } = clusterPaths(store);
  const outcome = child('answer-wait', store, '3000');
  expect(await outcome.exited).toBe(0);
  const said = await new Response(outcome.stderr).text();
  const answer = await new Response(outcome.stdout).text();
  expect(said).toContain(`madarch: waiting for PostgreSQL on ${dataDir}, 0 s of 3`);
  expect(answer).toContain('did not answer');
  expect(answer).toContain('database "postgres" does not exist');
}, 60_000);

test('an initdb killed before it made the postgres database leaves a folder the next open prepares again', async () => {
  // The shape the clean-install walk met on windows-x64 at b43b57ff (madarch-64o5.81): a stop ended initdb after its
  // bootstrap checkpoint and before `make_postgres`, so the folder held `PG_VERSION`, `global/pg_control` and `base/1`
  // and no `postgres` database. The next open started that cluster and every connection answered
  // `FATAL: database "postgres" does not exist` for the whole readiness bound.
  const store = storeOf('no postgres database');
  const { dataDir } = clusterPaths(store);
  const first = await openCluster({ ...clusterPaths(store) });
  await first.stop();
  // What `make_postgres` would have made, removed: the cluster is otherwise whole and its records say nothing.
  rmSync(join(dataDir, 'base', '5'), { recursive: true, force: true });
  rmSync(join(dirname(dataDir), 'madarch.prepared'), { force: true });
  rmSync(join(dirname(dataDir), 'madarch.preparing'), { force: true });
  const ended = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  await ended.exited;
  writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: ended.pid } })}\n`);
  const second = await openCluster({ ...clusterPaths(store) });
  try {
    expect(existsSync(join(dataDir, 'base', '5'))).toBe(true);
    await clusterQuery(second, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
  } finally { await second.stop(); }
}, 120_000);

test('a server that starts without answering its own admin database is refused with that reason and the log path', async () => {
  // A store prepared before our records existed has no `madarch.prepared`, so its files are its proof and it is kept.
  // When the server then cannot answer, the refusal names why — `database "postgres" does not exist` — beside the
  // store's log, never only "it does not answer" (madarch-64o5.81).
  const store = storeOf('refused with a reason');
  const { dataDir } = clusterPaths(store);
  const first = await openCluster({ ...clusterPaths(store) });
  await first.stop();
  rmSync(join(dataDir, 'base', '5'), { recursive: true, force: true });
  rmSync(join(dirname(dataDir), 'madarch.prepared'), { force: true });
  rmSync(join(dirname(dataDir), 'madarch.preparing'), { force: true });
  let refusal: Error | undefined;
  try { await openCluster({ ...clusterPaths(store) }); } catch (error) { refusal = error as Error; }
  try {
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(join(dataDir, '..', 'postgres.log'));
    expect(refusal?.message).toContain('database "postgres" does not exist');
  } finally { await stopStoreForExit(store, { force: true }); }
}, 120_000);

test('an initdb that does not finish is ended with its whole tree, and the open says so', async () => {
  // initdb runs its bootstrap in a descendant that holds initdb's pipes, so killing initdb alone leaves a start waiting
  // on an initdb that ended — and the descendant writing the store (codex P1 on 9027bc2a).
  const store = storeOf('hung initdb');
  const bin = join(root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const pids = join(root, 'fake-initdb-pids.txt');
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\necho $$ > "${pids}"\nsleep 300 &\necho $! >> "${pids}"\nsleep 300\n`);
  chmodSync(join(bin, 'initdb'), 0o755);
  let refusal: Error | undefined;
  try { await openCluster({ ...clusterPaths(store), bin, initdbTimeoutMs: 500 }); } catch (error) { refusal = error as Error; }
  expect(refusal).toBeDefined();
  expect(refusal?.message).toContain('did not finish within 500 ms');
  const written = readFileSync(pids, 'utf8').trim().split('\n').map((line) => Number(line));
  expect(written).toHaveLength(2);
  const deadline = Date.now() + 10_000;
  while (written.some((pid) => alive(pid)) && Date.now() < deadline) await Bun.sleep(50);
  expect(written.filter((pid) => alive(pid))).toEqual([]);
}, 60_000);

test('a descendant of initdb that holds its stdout does not keep the process alive', async () => {
  // initdb's bootstrap descendant inherits its pipes. A start that waited for them outlived initdb, and the process
  // stayed alive on a pipe no one would close (measured before: Bun exited only when the descendant ended, 6 s later).
  const store = storeOf('initdb stdout');
  const bin = join(root, 'fake-bin-stdout');
  mkdirSync(bin, { recursive: true });
  const pids = join(root, 'fake-initdb-stdout-pids.txt');
  writeFileSync(join(bin, 'initdb'), `#!/bin/sh\necho $$ > "${pids}"\nsleep 30 &\necho $! >> "${pids}"\nexit 0\n`);
  writeFileSync(join(bin, 'pg_ctl'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'initdb'), 0o755);
  chmodSync(join(bin, 'pg_ctl'), 0o755);
  const started = performance.now();
  const run = Bun.spawn(['bun', join(import.meta.dir, 'postgres-cluster-owner-driver.ts'), 'open-and-exit', store, bin], { stdout: 'pipe', stderr: 'pipe' });
  const code = await run.exited;
  const elapsed = performance.now() - started;
  expect(code).toBe(0);
  expect(elapsed).toBeLessThan(10_000);
  const written = readFileSync(pids, 'utf8').trim().split('\n').map((line) => Number(line));
  expect(written).toHaveLength(2);
  const deadline = Date.now() + 5_000;
  while (written.some((pid) => alive(pid)) && Date.now() < deadline) await Bun.sleep(50);
  expect(written.filter((pid) => alive(pid))).toEqual([]);
}, 60_000);

test('a recorded pid that is another process is no preparation: the store is prepared again at once', async () => {
  // Windows keeps no start time, and a stop frees initdb's id for whatever starts next. Identity is the command line that
  // names the folder: a live pid that names nothing of this store is not a preparation still running.
  const store = storeOf('reused pid');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  writeFileSync(join(dataDir, 'global', 'half-made'), 'partial');
  const other = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: other.pid } })}\n`);
    const started = performance.now();
    const opened = await openCluster({ ...clusterPaths(store), preparationWaitMs: 3_000 });
    try {
      // Not the recorded pid's wait: the pid is another process, so the store is prepared at once.
      expect(performance.now() - started).toBeLessThan(12_000);
      expect(existsSync(join(dataDir, 'global', 'half-made'))).toBe(false);
      await clusterQuery(opened, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
    } finally { await opened.stop(); }
  } finally {
    other.kill('SIGKILL');
    await other.exited;
  }
}, 120_000);

test('a preparation still naming its folder is waited for, and the wait says what it waits for', async () => {
  const store = storeOf('waiting preparation');
  const { dataDir } = clusterPaths(store);
  mkdirSync(join(dataDir, 'global'), { recursive: true });
  writeFileSync(join(dataDir, 'PG_VERSION'), '18\n');
  writeFileSync(join(dataDir, 'global', 'half-made'), 'partial');
  const bin = join(root, 'fake-postgres');
  mkdirSync(bin, { recursive: true });
  // A program really named `postgres`, whose own arguments name the folder: what the listing reads on POSIX is argv.
  const holderProgram = join(bin, 'postgres');
  copyFileSync('/bin/yes', holderProgram);
  chmodSync(holderProgram, 0o755);
  const holder = Bun.spawn([holderProgram, '--', '-D', dataDir], { stdout: 'ignore', stderr: 'ignore' });
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map((value) => String(value)).join(' ')); };
  try {
    writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: holder.pid } })}\n`);
    let refusal: Error | undefined;
    try { await openCluster({ ...clusterPaths(store), preparationWaitMs: 300 }); } catch (error) { refusal = error as Error; }
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(dataDir);
    expect(refusal?.message).toContain(String(holder.pid));
    const said = lines.join('\n');
    expect(said).toContain('waiting for');
    expect(said).toContain(`pid ${String(holder.pid)}`);
    expect(said).toContain(dataDir);
    expect(said).toContain('300 ms');
    expect(existsSync(join(dataDir, 'global', 'half-made'))).toBe(true);
  } finally {
    console.error = original;
    holder.kill('SIGKILL');
    await holder.exited;
  }
}, 120_000);
