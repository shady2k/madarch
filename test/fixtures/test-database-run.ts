/**
 * A child run's own case (ALX-119, ALX-186): it opens the two databases a case
 * commonly opens — the run's default empty contract and one explicit contract —
 * closes them, and names in its output that no case database is left once they
 * closed. `test/test-database-cleanliness.test.ts` runs it as `bun test` and
 * checks the run's folder with `.shady2k/run-scratch-check.mjs`.
 */
import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { clusterEndpoint } from '../../src/adapters/postgres-cluster.js';
import { generatedTableName, type GraphContract } from '../../src/graph/contract.js';
import { createTestDatabaseOwner, TEST_SERVER_VARIABLE } from '../test-database.js';

const CHILD_CONTRACT: GraphContract = {
  vertex: [{ name: 'probe.child-node', table: generatedTableName('probe.child-node', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' }],
  edge: [],
  dictionary: [],
};

/** How many databases this process's cases still hold on the run's server. */
async function caseDatabases(): Promise<string[]> {
  const socketDir = process.env[TEST_SERVER_VARIABLE]?.trim() ?? '';
  const client = new Client({ ...clusterEndpoint(socketDir), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    const rows = await client.query<{ datname: string }>('SELECT datname FROM pg_database');
    const prefix = `t_${String(process.pid)}_`;
    return rows.rows.map((row) => row.datname).filter((name) => name.startsWith(prefix));
  } finally {
    await client.end().catch(() => undefined);
  }
}

test('two case databases are dropped when their owners close', async () => {
  const empty = await createTestDatabaseOwner();
  const declared = await createTestDatabaseOwner({ graphContract: CHILD_CONTRACT });
  expect(await caseDatabases()).toHaveLength(2);
  await empty.close();
  await declared.close();
  // Each close dropped its database before it resolved: the server holds neither.
  expect(await caseDatabases()).toEqual([]);
  console.log('harness-cleanliness: no case database left');
}, 60_000);
