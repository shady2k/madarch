import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { createTestDatabaseOwner, pendingTestDatabaseDrops, TEST_SERVER_VARIABLE, waitForTestDatabaseDrops } from './test-database.js';

async function caseDatabases(): Promise<string[]> {
  const socketDir = process.env[TEST_SERVER_VARIABLE];
  if (socketDir === undefined) throw new Error('test server socket directory is missing');
  const client = new Client({ ...clusterEndpoint(socketDir), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    const result = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname', [`t_${String(process.pid)}\_%`]);
    return result.rows.map(({ datname }) => datname);
  } finally {
    await client.end();
  }
}

test('timing callback failures do not stop drops and the drain names every owed database', async () => {
  const phases: string[] = [];
  let throwFirst = true;
  let throwSecond = true;
  const first = await createTestDatabaseOwner({ timing: (phase) => {
    if (phase === 'database-drop-start' && throwFirst) { throwFirst = false; throw new Error('first timing failure'); }
  } });
  const second = await createTestDatabaseOwner({ timing: (phase) => {
    phases.push(phase);
    if (phase === 'database-drop-start' && throwSecond) throw new Error('second timing failure');
  } });
  const [firstDatabase, secondDatabase] = await caseDatabases();
  await first.close();
  await second.close();
  const failure = await waitForTestDatabaseDrops().then(() => undefined, (error: unknown) => error);
  expect(phases).toContain('database-drop-start');
  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : '';
  expect(message).toContain('first timing failure');
  expect(message).toContain('second timing failure');
  expect(message).toContain(firstDatabase!);
  expect(message).toContain(secondDatabase!);
  expect(pendingTestDatabaseDrops()).toBe(2);
  throwSecond = false;
  await waitForTestDatabaseDrops();
  expect(pendingTestDatabaseDrops()).toBe(0);
}, 60_000);
