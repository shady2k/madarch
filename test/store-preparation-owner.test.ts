import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { clusterPaths, postmasterOfDataDir, stopDatabasesUnderSync } from '../src/adapters/postgres-cluster.js';
import { postgresInstallFolder, postgresProgram } from '../src/adapters/postgres-builds.js';
import { storeSchemaLockKey } from '../src/adapters/schema-lock.js';
import { repositoryContract } from './repository-contract-fixture.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import type { GraphContract } from '../src/graph/contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { closeTrace, openTrace, runInTrace } from '../src/obs/trace.js';
import { publishStoreOwner, requestHistoryPreparation, requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';

test('owner prepares pinned contracts and new source databases for attach-only roles', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-ipc-'));
  try {
    await withStorePreparationOwner(async () => {
      const store = join(folder, 'graph');
      await requestStorePreparation(store, repositoryContract);
      const trace = openTrace({ store: folder, runId: 'repeat-preparation', console: false });
      try {
        await runInTrace(trace, async () => {
          // Object key order does not change the declared contract.
          const { vertex, edge, dictionary, ...metadata } = repositoryContract;
          const equivalent = { ...metadata, dictionary, edge, vertex };
          await requestStorePreparation(join(store, '.'), equivalent);
          await requestStorePreparation(store);
        });
      } finally { closeTrace(trace); }
      expect(readFileSync(trace.file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).name)).not.toContain('db.transaction');
      const unpublish = publishStoreOwner(folder);
      try {
        const env = { ...process.env };
        delete env.MADARCH_STORE_OWNER_URL;
        delete env.MADARCH_STORE_OWNER_TOKEN;
        const module = new URL('../src/product/store-preparation.ts', import.meta.url).pathname;
        const script = `import { withDaemonStorePreparation, requestStorePreparation } from ${JSON.stringify(module)}; await withDaemonStorePreparation(${JSON.stringify(folder)}, async () => await requestStorePreparation(${JSON.stringify(store)}));`;
        const invocation = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
        const stderr = await new Response(invocation.stderr).text();
        expect(await invocation.exited, stderr).toBe(0);
      } finally { unpublish(); }
      const previous = process.env.MADARCH_ROLE;
      process.env.MADARCH_ROLE = 'api';
      try {
        await expect(withStorePreparationOwner(async () => undefined)).rejects.toThrow('cannot own schema preparation');
        const client = await createDatabaseOwner({ store, connectOnly: true });
        try { await createOneGraphSchema(client, withManifestContract(repositoryContract)); } finally { await client.close(); }
        const changed: GraphContract = { vertex: [{ name: 'owner_added', table: 'owner_added_opinions', capability: 'test', fields: [{ name: 'label', type: 'text' }], key: ['label'] }], edge: [], dictionary: [] };
        await requestStorePreparation(store, changed);
        const changedClient = await createDatabaseOwner({ store, connectOnly: true });
        try { await createOneGraphSchema(changedClient, withManifestContract(changed)); } finally { await changedClient.close(); }
        await requestStorePreparation(store, repositoryContract);
        const restored = await createDatabaseOwner({ store, connectOnly: true });
        try { await createOneGraphSchema(restored, withManifestContract(repositoryContract)); } finally { await restored.close(); }
        await requestHistoryPreparation(store, 'h_added_source');
        const history = await createDatabaseOwner({ store, database: 'h_added_source', connectOnly: true });
        try {
          const held = await history.run(async (tx) => await tx.query("SELECT to_regclass('source_commits') AS relation"));
          expect(held.rows[0]?.relation).not.toBeNull();
        } finally { await history.close(); }
      } finally {
        if (previous === undefined) delete process.env.MADARCH_ROLE; else process.env.MADARCH_ROLE = previous;
      }
    });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 60_000);


test('SIGTERM cancels the preparation owner before its store closes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-owner-shutdown-'));
  const store = join(folder, 'graph');
  const module = new URL('../src/product/store-preparation.ts', import.meta.url).pathname;
  const fixture = new URL('./repository-contract-fixture.ts', import.meta.url).pathname;
  const script = `import { withStorePreparationOwner, requestStorePreparation } from ${JSON.stringify(module)};
import { repositoryContract } from ${JSON.stringify(fixture)};
await withStorePreparationOwner(async () => {
  await requestStorePreparation(${JSON.stringify(store)}, repositoryContract);
  console.log(JSON.stringify({ url: process.env.MADARCH_STORE_OWNER_URL, token: process.env.MADARCH_STORE_OWNER_TOKEN }));
  await new Promise(resolve => process.once('SIGTERM', resolve));
  await new Response(Bun.stdin.stream()).text();
});`;
  const env = { ...process.env };
  delete env.MADARCH_STORE_OWNER_URL;
  delete env.MADARCH_STORE_OWNER_TOKEN;
  const child = Bun.spawn([process.execPath, '-e', script], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text();
  let blocker: ReturnType<typeof Bun.spawn> | undefined;
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (description: string, check: () => boolean): Promise<void> => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) { if (check()) return; await Bun.sleep(50); }
    throw new Error(`${import.meta.path}:95: ${description} did not complete within 15000 ms (${folder})`);
  };
  try {
    let output = '';
    const reader = child.stdout.getReader();
    const reading = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        output += new TextDecoder().decode(next.value);
      }
    })();
    await waitFor('the preparation owner to announce its endpoint', () => output.includes('\n'));
    const endpoint = JSON.parse(output.split('\n')[0]!) as { url: string; token: string };
    const dataDir = join(store, 'pgdata');
    const postmaster = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim());
    if (!Number.isInteger(postmaster) || !postmasterOfDataDir(dataDir, postmaster)) throw new Error(`${dataDir}:1: preparation started no PostgreSQL server`);
    const psql = join(postgresInstallFolder(env), 'bin', postgresProgram('psql'));
    const connection = ['-X', '-h', clusterPaths(store).socketDir, '-U', 'postgres', '-d', 'madarch'];
    const query = (sql: string): string => execFileSync(psql, [...connection, '-A', '-t', '-c', sql], { env, encoding: 'utf8' }).trim();
    const blockingSession = Bun.spawn([psql, ...connection, '-v', 'ON_ERROR_STOP=1'], {
      env: { ...env, PGAPPNAME: 'preparation-shutdown-blocker' }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
    });
    blocker = blockingSession;
    blockingSession.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(${storeSchemaLockKey()});\n`);
    blockingSession.stdin.flush();
    await waitFor('the blocker to hold the schema lock', () => query("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='preparation-shutdown-blocker' AND l.locktype='advisory' AND l.granted") === '1');
    const changed: GraphContract = { vertex: [{ name: 'shutdown_added', table: 'shutdown_added_opinions', capability: 'test', fields: [{ name: 'label', type: 'text' }], key: ['label'] }], edge: [], dictionary: [] };
    let requestSettled = false;
    const request = fetch(endpoint.url, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ store, contract: changed }),
    }).then(async response => ({ ok: response.ok, message: await response.text() }), error => ({ ok: false, message: String(error) })).finally(() => { requestSettled = true; });
    await waitFor('preparation to wait behind the schema lock', () => query("SELECT count(*) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND EXISTS (SELECT 1 FROM pg_stat_activity blocker WHERE blocker.application_name='preparation-shutdown-blocker' AND blocker.pid=ANY(pg_blocking_pids(a.pid)))") !== '0');
    child.kill('SIGTERM');
    await waitFor('the preparation request to settle while the owner scope is still active', () => requestSettled);
    child.stdin.end();
    await waitFor('the preparation owner to exit after SIGTERM', () => child.exitCode !== null);
    expect(await child.exited, await stderr).toBe(0);
    await reading;
    expect((await request).ok).toBe(false);
    await waitFor('the recorded PostgreSQL server to exit', () => !alive(postmaster));
    expect(existsSync(join(dataDir, 'postmaster.pid'))).toBe(false);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    blocker?.kill('SIGKILL');
    if (blocker !== undefined) await blocker.exited;
    stopDatabasesUnderSync(folder);
    rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);
