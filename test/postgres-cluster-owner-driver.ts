/**
 * Another process of the binary for `test/postgres-cluster-owner.test.ts`: it opens a store's cluster and leaves it, or
 * holds the start's lock while it pretends to run `initdb`.
 */
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { clusterPaths, openCluster } from '../src/adapters/postgres-cluster.js';
import { ensurePostgresInstalled } from '../src/adapters/postgres-install.js';

const [mode, store, extra, marker] = process.argv.slice(2);
if (store === undefined) throw new Error('test/postgres-cluster-owner-driver.ts:1: the store the child works on was not named');

if (mode === 'open-and-leave') {
  const cluster = await openCluster({ ...clusterPaths(store) });
  console.log('opened');
  await cluster.stop();
} else if (mode === 'hold-start') {
  const { dataDir } = clusterPaths(store);
  const lock = join(dirname(dataDir), 'pgdata.lock');
  mkdirSync(dirname(lock), { recursive: true });
  const { symbols: { flock } } = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const fd = openSync(lock, 'a+');
  // LOCK_EX, held until this process leaves.
  if (flock(fd, 2) !== 0) throw new Error(`the start lock ${lock} could not be held`);
  if (marker !== undefined) writeFileSync(marker, `${String(process.pid)}\n`);
  await Bun.sleep(Number(extra ?? '1000'));
} else if (mode === 'refuse-platform') {
  // The server's programs are this box's, and the platform is then reported as one whose C library this build does not
  // ask for: the open must refuse by name instead of loading a library that is not there (madarch-8bdc.9).
  const { bin } = await ensurePostgresInstalled({});
  Object.defineProperty(process, 'platform', { value: extra, configurable: true });
  try {
    const cluster = await openCluster({ ...clusterPaths(store), bin });
    await cluster.stop();
    console.log('opened');
  } catch (error) {
    console.log(`refused: ${(error as Error).message}`);
  }
} else {
  throw new Error(`test/postgres-cluster-owner-driver.ts:1: ${String(mode)} is not a mode this driver has`);
}
