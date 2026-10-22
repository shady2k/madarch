/**
 * The extract driver on PostgreSQL (decision 0028): the cases of
 * `extract-driver-suite.ts` against the server `MADARCH_TEST_POSTGRES_URL`
 * names, which `.pod-pg.sh` starts on the test pod and CI's checks job
 * starts. Without the variable the file is skipped and the skip names it.
 * The tables live in a schema of their own, dropped before and after.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { extractDriverTests } from './extract-driver-suite.js';

const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];
const SCHEMA = 'madarch_extract_driver_test';

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

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
  store = createGraphStore(owner);
  await owner.ready;
}, 120_000);

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
}, 120_000);

if (connectionString === undefined) {
  test.skip('the extract driver on PostgreSQL (skipped: MADARCH_TEST_POSTGRES_URL names no PostgreSQL server in this environment)', () => {});
} else {
  describe('server', () => {
    test('the server loads btree_gist', async () => {
      await owner!.run(async (tx) => {
        await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
      });
    });
  });
  extractDriverTests('PostgreSQL', () => {
    if (owner === undefined || store === undefined) throw new Error('the PostgreSQL owner did not open');
    return { owner, store };
  });
}
