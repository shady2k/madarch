/**
 * The extract driver on a store's own server (decision 0028): the engine every developer's
 * machine runs. The cases live in `extract-driver-suite.ts`; the same cases
 * run on a server in `extract-driver-postgres.test.ts`.
 */
import { afterAll, beforeAll } from 'bun:test';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { extractDriverTests } from './extract-driver-suite.js';
import { createTestDatabaseOwner } from './test-database.js';

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

beforeAll(async () => {
  owner = await createTestDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await owner.ready;
}, 60_000);

afterAll(async () => {
  await owner?.close();
}, 60_000);

extractDriverTests('store', () => {
  if (owner === undefined || store === undefined) throw new Error("the store's owner did not open");
  return { owner, store };
});
