/**
 * The temporal graph store on PostgreSQL (decision 0028): the cases of
 * `graph-store.test.ts` against the server `MADARCH_TEST_POSTGRES_URL` names,
 * which CI's checks job starts. Without the variable the file is skipped and
 * the skip names it. The tables live in a schema of their own, dropped before
 * and after, so a shared server does not accumulate runs and the other
 * suites' tables are not the graph's neighbours: the graph-only case sees
 * exactly its own.
 *
 * Writers here are separate connections of a pool, so the concurrent cases
 * (a generation published twice at once, a node ended while an edge to it is
 * inserted) really overlap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { graphStoreTests } from './graph-store-suite.js';

const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];
const SCHEMA = 'madarch_graph_store_test';

let owner: DatabaseOwner | undefined;

beforeAll(async () => {
  if (connectionString === undefined) return;
  const setup = await createPostgresDatabaseOwner({ connectionString });
  try {
    await setup.run(async (tx) => {
      await tx.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await tx.query(`CREATE SCHEMA ${SCHEMA}`);
    });
  } finally {
    await setup.close();
  }
  owner = await createPostgresDatabaseOwner({ connectionString, options: `-c search_path=${SCHEMA}` });
  await owner.ready;
}, 60_000);

afterAll(async () => {
  if (owner === undefined || connectionString === undefined) return;
  await owner.close();
  const cleanup = await createPostgresDatabaseOwner({ connectionString });
  try {
    await cleanup.run(async (tx) => {
      await tx.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    });
  } finally {
    await cleanup.close();
  }
}, 60_000);

if (connectionString === undefined) {
  test.skip('the graph store on PostgreSQL (skipped: MADARCH_TEST_POSTGRES_URL names no PostgreSQL server in this environment)', () => {});
} else {
  describe('server', () => {
    test('the server loads btree_gist', async () => {
      await owner!.run(async (tx) => {
        await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
        expect((await tx.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).rows.length).toBe(1);
      });
    });
  });
  graphStoreTests('PostgreSQL', () => owner!);
}
