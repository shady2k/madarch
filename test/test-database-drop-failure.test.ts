/**
 * The run's drop queue reports what it could not drop (ALX-134, the review of
 * ALX-119: `test/test-database.ts:255-277`). The queue keeps the drop off the
 * case's path, but a drop that failed stays owed and the drain names it: a
 * queue that reaches zero without dropping its database claims a success it
 * did not have.
 */
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
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
  if (held === undefined || held === '') throw new Error('test/test-database-drop-failure.test.ts:1: the run server is not there: run the suite from the repository root');
  return held;
}

/** One statement on the run server's administrative database, in a connection of its own. */
async function runServerStatement(sql: string, values: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new Client({ ...clusterEndpoint(runServerSocket()), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    return (await client.query(sql, [...values])).rows as Record<string, unknown>[];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The case databases of this process the run server holds, sorted by code point. */
async function caseDatabases(): Promise<string[]> {
  const rows = await runServerStatement("SELECT datname FROM pg_database WHERE datname LIKE $1", [`t_${String(process.pid)}\\_%`]);
  return rows.map((row) => String(row['datname'])).sort();
}

test('a failed DROP stays owed, is named by the drain, and is dropped by the next one', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: probeContract() });
  const [database] = await caseDatabases();
  expect(database).toBeDefined();
  // PostgreSQL refuses to drop a database that is a template: a real DROP failure, not a substituted error.
  await runServerStatement('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [database!]);
  await owner.close();
  const failure = await waitForTestDatabaseDrops().then(() => undefined, (error: unknown) => error);
  expect({
    named: failure instanceof Error && failure.message.includes(database!),
    cause: failure instanceof Error && failure.message.includes('cannot drop a template database'),
    owed: pendingTestDatabaseDrops(),
    held: (await caseDatabases()).includes(database!),
  }).toEqual({ named: true, cause: true, owed: 1, held: true });
  // The cause of the failure is gone: the next drain retries the drop the queue still owes.
  await runServerStatement('UPDATE pg_database SET datistemplate = false WHERE datname = $1', [database!]);
  await waitForTestDatabaseDrops();
  expect({ owed: pendingTestDatabaseDrops(), held: (await caseDatabases()).includes(database!) }).toEqual({ owed: 0, held: false });
}, 120_000);
