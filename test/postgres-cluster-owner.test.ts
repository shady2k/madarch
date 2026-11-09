/**
 * One owner of a store's PostgreSQL cluster across processes (madarch-8bdc.9): the last process using a server stops it,
 * a process that attaches and leaves keeps it answering for the one that opened it, and an open waits for a start
 * another process is making instead of starting a second server of the same store.
 *
 * The cases run real processes: the cluster's rule is a lock the kernel holds, and only a second process can show it.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterPaths, clusterQuery, openCluster, CLUSTER_ADMIN_DATABASE, CLUSTER_PORT, CLUSTER_USER } from '../src/adapters/postgres-cluster.js';

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
