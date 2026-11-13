/**
 * One owner of a store's PostgreSQL cluster across processes (madarch-8bdc.9): the last process using a server stops it,
 * a process that attaches and leaves keeps it answering for the one that opened it, and an open waits for a start
 * another process is making instead of starting a second server of the same store.
 *
 * The cases run real processes: the cluster's rule is a lock the kernel holds, and only a second process can show it.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterPaths, clusterQuery, openCluster, stopStoreForExit, CLUSTER_ADMIN_DATABASE, CLUSTER_PORT, CLUSTER_USER } from '../src/adapters/postgres-cluster.js';

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
