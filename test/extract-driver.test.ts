/**
 * The extract driver on PGlite (decision 0028): the engine every developer's
 * machine runs. The cases live in `extract-driver-suite.ts`; the same cases
 * run on a server in `extract-driver-postgres.test.ts`.
 */
import { afterAll, beforeAll } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { extractDriverTests } from './extract-driver-suite.js';

let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

beforeAll(async () => {
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await owner.ready;
}, 60_000);

afterAll(async () => {
  await owner?.close();
}, 60_000);

extractDriverTests('PGlite', () => {
  if (owner === undefined || store === undefined) throw new Error('the PGlite owner did not open');
  return { owner, store };
});
