import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * The contract lock (decision 0034, item 14): two first fills of one fresh store create the generated tables
 * one at a time, so the catalog's unique type name never sees two CREATE TABLE statements for one table.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryContract } from './repository-contract-fixture.js';
import { generatedTableName } from '../src/graph/contract.js';

import { createTestDatabaseOwner } from './test-database.js';

test('two concurrent first fills create every generated table once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-contract-lock-'));
  const store = join(root, 'store');
  /** The graph's own tables, which every store holds: the mechanism the product's contracts build on. */
const MECHANISM_TABLES = ['context', 'edge', 'entity', 'node', 'operation', 'unresolved_reference'] as const;

const RECORD_TABLES = [
    ...MECHANISM_TABLES,
    ...repositoryContract.vertex.map((kind) => generatedTableName(kind.name, 'vertex')),
    ...repositoryContract.edge.flatMap((kind) => (kind.fields.length === 0 ? [] : [generatedTableName(kind.name, 'edge')])),
    ...repositoryContract.dictionary.map((one) => generatedTableName(one.name, 'dictionary')),
  ];
  const [left, right] = await Promise.all([
    createTestDatabaseOwner({ store }),
    createTestDatabaseOwner({ store }),
  ]);
  try {
    await Promise.all([
      prepareStore(left, { contract: repositoryContract }),
      prepareStore(right, { contract: repositoryContract }),
    ]);
    const found = await left.transaction('snapshot', async (tx) => await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    ));
    const names = found.rows.map((row) => row.table_name);
    for (const table of RECORD_TABLES) expect(names.filter((name) => name === table)).toHaveLength(1);
  } finally {
    await left.close();
    await right.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
