/** One store, an API pool and the real stop command; no catalogue or fill (madarch-64o5.74). */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { clusterPaths, clusterQuery, openCluster } from '../src/adapters/postgres-cluster.js';

test('stop with no daemon preserves an API-held store; backend termination loses only that client', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-stop-'));
  const store = join(home, '.madarch', 'knowledge', 'one', 'graph');
  mkdirSync(store, { recursive: true });
  const cluster = await openCluster(clusterPaths(store));
  await clusterQuery(cluster, 'postgres', "ALTER SYSTEM SET log_connections = 'on'");
  await clusterQuery(cluster, 'postgres', "ALTER SYSTEM SET log_disconnections = 'on'");
  await clusterQuery(cluster, 'postgres', 'SELECT pg_reload_conf()');
  const init = await createDatabaseOwner({ store });
  await init.close();
  const api = Bun.spawn(['bun', join(import.meta.dir, 'owner-stop-driver.ts'), store], { env: { ...process.env, PGAPPNAME: 'api' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = api.stdout.getReader();
    const first = await reader.read();
    const address = new TextDecoder().decode(first.value).trim();
    const before = await (await fetch(address)).json() as { pid: number; role: string };
    expect(before.role).toBe('api');
    // The API is now the only process holding this store; the test's hold cannot mask a broken stop.
    await cluster.stop();
    const stop = Bun.spawn(['bun', join(import.meta.dir, '../scripts/madarch.ts'), 'stop', '--home', home], { env: { ...process.env, PGAPPNAME: 'stop' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await stop.exited).toBe(0);
    expect(await (await fetch(address)).json()).toEqual(before);
    // Explicitly terminate one backend to reproduce the isolated FATAL without a server shutdown.
    await clusterQuery(cluster, 'postgres', 'SELECT pg_terminate_backend($1)', [before.pid]);
    await Bun.sleep(100);
    const after = await fetch(address);
    expect(after.status).toBe(200);
    const resumed = await after.json() as { pid: number; role: string };
    expect(resumed.pid).not.toBe(before.pid);
    expect(resumed.role).toBe('api');
    const log = readFileSync(join(store, 'postgres.log'), 'utf8');
    expect(log).toContain('terminating connection due to administrator command');
    expect(log).toContain('application_name=api');
    expect(log).not.toContain('received fast shutdown request');
    console.log(JSON.stringify({ before, resumed, log }));
  } finally {
    api.kill('SIGTERM');
    await api.exited;
    await cluster.stop();
  }
}, 60_000);
