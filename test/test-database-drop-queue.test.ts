/**
 * The run's drops of case databases (ALX-105 variant 4, ALX-119): `DROP DATABASE`
 * checkpoints the whole cluster, so a case's teardown queues it, the run waits
 * for the queue before it stops its server, and a finished run leaves no
 * database and no folder behind.
 */
import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner, pendingTestDatabaseDrops, TEST_SERVER_VARIABLE, waitForTestDatabaseDrops } from './test-database.js';

/** A contract no other file of the run declares, so its template is this case's own first preparation. */
function probeContract(): GraphContract {
  const suffix = randomBytes(4).toString('hex');
  return {
    vertex: [{
      name: `probe.node-${suffix}`,
      table: generatedTableName(`probe.node-${suffix}`, 'vertex'),
      key: ['name'],
      fields: [{ name: 'name', type: 'text' }],
      capability: 'fixture',
    }],
    edge: [],
    dictionary: [],
  };
}

/** The run server's socket folder: the preload names it before any test file loads. */
function runServerSocket(): string {
  const held = process.env[TEST_SERVER_VARIABLE]?.trim();
  if (held === undefined || held === '') throw new Error('test/test-database-drop-queue.test.ts:1: the run server is not there: run the suite from the repository root');
  return held;
}

/** The names of the databases the run's server holds. */
async function serverDatabases(): Promise<string[]> {
  const client = new Client({ ...clusterEndpoint(runServerSocket()), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    const rows = await client.query<{ datname: string }>('SELECT datname FROM pg_database');
    return rows.rows.map((row) => row.datname);
  } finally {
    await client.end().catch(() => undefined);
  }
}

test('a case teardown queues the drop of its database instead of waiting for it', async () => {
  const contract = probeContract();
  const phases: string[] = [];
  const owner = await createTestDatabaseOwner({ graphContract: contract, timing: (phase) => phases.push(phase) });
  await owner.close();
  // The close returned. A drop it waited for reports itself before returning, and this one is owed, not done.
  expect(phases).toContain('database-owner-close');
  expect(pendingTestDatabaseDrops()).toBeGreaterThan(0);
  await waitForTestDatabaseDrops();
  expect(pendingTestDatabaseDrops()).toBe(0);
  // The queue drained by dropping the databases: no case database of this process outlives its case.
  const prefix = `t_${String(process.pid)}_`;
  expect((await serverDatabases()).filter((name) => name.startsWith(prefix))).toEqual([]);
}, 60_000);

test('a finished child run leaves no case database and no folder behind', async () => {
  const root = join(import.meta.dir, '..');
  const script = join(root, '.shady2k', 'run-scratch-check.mjs');
  const run = join(import.meta.dir, 'fixtures', 'test-database-run.ts');
  // The two snapshots stand outside the watched folders: a `madarch-` name in the temporary folder would be the run's own.
  const snapshots = mkdtempSync(join(tmpdir(), 'cleanliness-'));
  const before = join(snapshots, 'before.txt');
  const after = join(snapshots, 'after.txt');
  const where = { home: process.env['HOME'] ?? '', tmp: process.env['TMPDIR'] ?? '' };
  const check = (args: string[]) => Bun.spawnSync([process.execPath, script, ...args, '--home', where.home, '--tmp', where.tmp], { cwd: root });
  try {
    expect(check(['snapshot', before]).exitCode).toBe(0);
    const child = Bun.spawnSync([process.execPath, 'test', run], { cwd: root, env: { ...process.env } });
    const output = child.stdout.toString() + child.stderr.toString();
    // The child names this only after its own drop queue drained and its server held no case database.
    expect(output).toContain('harness-cleanliness: no case database left');
    expect({ code: child.exitCode, output }).toMatchObject({ code: 0 });
    expect(check(['snapshot', after]).exitCode).toBe(0);
    const compared = check(['compare', before, after]);
    expect({ code: compared.exitCode, output: compared.stdout.toString() + compared.stderr.toString() })
      .toMatchObject({ code: 0, output: expect.stringContaining('the run left the home and the temporary folder as it found them') });
  } finally {
    rmSync(snapshots, { recursive: true, force: true });
  }
}, 120_000);
