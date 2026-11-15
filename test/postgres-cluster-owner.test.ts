/**
 * One owner of a store's PostgreSQL cluster across processes (madarch-8bdc.9): the last process using a server stops it,
 * a process that attaches and leaves keeps it answering for the one that opened it, and an open waits for a start
 * another process is making instead of starting a second server of the same store.
 *
 * The cases run real processes: the cluster's rule is a lock the kernel holds, and only a second process can show it.
 */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const initdb = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
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
  const initdb = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
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

test('a cluster initdb finished while the open waited is kept, not removed', async () => {
  // The recorded initdb was killed, so the next open waits for it — and it finished first. What it left is a whole
  // cluster, and the open keeps it instead of removing it as unfinished (codex P1 on 9027bc2a).
  const store = storeOf('finished while waiting');
  const { dataDir } = clusterPaths(store);
  const first = await openCluster({ ...clusterPaths(store) });
  await first.stop();
  const sentinel = join(dataDir, 'madarch.test-sentinel');
  writeFileSync(sentinel, 'kept\n');
  const ended = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  await ended.exited;
  rmSync(join(dirname(dataDir), 'madarch.prepared'), { force: true });
  writeFileSync(join(dirname(dataDir), 'madarch.preparing'), `${JSON.stringify({ version: 'test', startedAt: new Date().toISOString(), initdb: { pid: ended.pid } })}\n`);
  const second = await openCluster({ ...clusterPaths(store) });
  try {
    expect(readFileSync(sentinel, 'utf8')).toBe('kept\n');
    expect(existsSync(join(dirname(dataDir), 'madarch.prepared'))).toBe(true);
    expect(existsSync(join(dirname(dataDir), 'madarch.preparing'))).toBe(false);
    await clusterQuery(second, CLUSTER_ADMIN_DATABASE, 'SELECT 1');
  } finally { await second.stop(); }
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
