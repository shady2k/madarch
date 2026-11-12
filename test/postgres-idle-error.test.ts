/** A lost idle PostgreSQL connection is reported for its store, not an unhandled EventEmitter error (madarch-8bdc.10). */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { clusterPaths, openCluster } from '../src/adapters/postgres-cluster.js';

test('losing a store server with an idle pool logs the store and the next query rejects by name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-idle-error-'));
  const store = join(root, 'store');
  const cluster = await openCluster(clusterPaths(store));
  let owner: DatabaseOwner | undefined;
  const messages: string[] = [];
  const logged = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { messages.push(parts.map(String).join(' ')); });
  try {
    owner = await createDatabaseOwner({ store });
    const result = await owner.run(async (connection) => await connection.query<{ value: number }>('SELECT 1::int AS value'));
    expect(result.rows).toEqual([{ value: 1 }]);
    // The statement has returned its connection to the pool. Fast shutdown closes that idle connection for real.
    const stop = Bun.spawn([join(cluster.bin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'), '-D', cluster.dataDir, '-m', 'fast', '-w', 'stop'], { stdout: 'pipe', stderr: 'pipe' });
    const code = await stop.exited;
    const stderr = await new Response(stop.stderr).text();
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    const until = Date.now() + 5_000;
    while (!messages.some((line) => line.includes('PostgreSQL pool') && line.includes(store)) && Date.now() < until) await Bun.sleep(20);
    expect(messages.some((line) => line.includes('PostgreSQL pool') && line.includes(store))).toBe(true);
    // Bun also fails this test run if either the Pool or its Client emits an unhandled error.
    await expect(owner.run(async (connection) => await connection.query('SELECT 1'))).rejects.toThrow(store);
  } finally {
    try { await owner?.close(); }
    finally {
      logged.mockRestore();
      await cluster.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);
