/**
 * The temporal graph store on PGlite (decision 0028), the engine every
 * developer's machine runs. One owner serves the file: PGlite boots in about
 * a second and a half, so each case drops and recreates the graph's tables
 * instead of opening another database. The same cases run on a server in
 * `graph-store-postgres.test.ts`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { graphStoreTests } from './graph-store-suite.js';

let owner: DatabaseOwner | undefined;

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  await owner.ready;
}, 60_000);

afterAll(async () => {
  await owner?.close();
}, 60_000);

test('btree_gist loads in the pinned PGlite and an exclusion constraint over a bigint and a range refuses an overlap', async () => {
  const probe = createPGliteDatabaseOwner({ btreeGist: true });
  try {
    await probe.exec(`CREATE EXTENSION btree_gist; CREATE TABLE probe (id bigint NOT NULL, during tstzrange NOT NULL, EXCLUDE USING gist (id WITH =, during WITH &&)); INSERT INTO probe VALUES (1, '[2026-01-01,2026-02-01)');`);
    await expect(probe.exec(`INSERT INTO probe VALUES (1, '[2026-01-15,2026-03-01)')`)).rejects.toThrow(/conflicting key value violates exclusion constraint/);
    await probe.exec(`INSERT INTO probe VALUES (2, '[2026-01-15,2026-03-01)')`);
  } finally {
    await probe.close();
  }
}, 60_000);

graphStoreTests('PGlite', () => owner!);
