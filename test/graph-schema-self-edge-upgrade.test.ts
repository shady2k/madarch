import { testHostBinding } from './host-binding-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SCHEMA, SCHEMA_REVISION, graphSchemaStamp } from '../src/adapters/schemas/graph-definition.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { EMPTY_CONTRACT, generatedTableName } from '../src/graph/contract.js';
import { MANIFEST_CONTRACT, MANIFEST_RELATION_EDGE, withManifestContract } from '../src/graph/manifest-contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { publishGraphDrafts } from '../src/graph/write.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-self-edge-upgrade-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('upgrades a populated catalogue without resetting authored history and preserves self relations on reopen', async () => {
  const store = join(root, 'store');
  const before = { ...MANIFEST_CONTRACT, edge: [] };
  const contract = withManifestContract(EMPTY_CONTRACT);
  // Recreate the previous build's fingerprint, including its old SQL and vertex-only metadata contract.
  const oldSchema = SCHEMA.filter((sql) => sql !== 'ALTER TABLE edge DROP CONSTRAINT IF EXISTS edge_check')
    .map((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS edge (')
      ? sql.replace('context_id bigint NOT NULL DEFAULT 1\n  )', 'context_id bigint NOT NULL DEFAULT 1,\n    CHECK (from_node <> to_node)\n  )')
      : sql);
  const declaration = JSON.stringify(before, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
  const oldStamp = createHash('sha256').update([`revision ${String(SCHEMA_REVISION)}`, ...oldSchema, declaration].join('\n')).digest('hex');
  expect(oldStamp).not.toBe(graphSchemaStamp(before));
  const kindTable = generatedTableName('manifest.kind', 'vertex');
  const edgeTable = generatedTableName(MANIFEST_RELATION_EDGE, 'edge');
  const first = await createDatabaseOwner({ store });
  let original: Record<string, unknown>[] = [];
  try {
    await prepareStore(first, { contract: before });
    const binding = await testHostBinding(first, before, 'manifest');
    await first.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, before, { vertices: [{
        kind: 'manifest.kind', key: { name: 'term' }, values: { declaration: { taken: true } },
        producer: 'manifest', producerVersion: '1',
      }], removals: [] }, 1, { binding, author: 'manifest@1', words: 'Keep this declaration' });
      await tx.query('ALTER TABLE edge ADD CONSTRAINT edge_check CHECK (from_node <> to_node)');
      await tx.query("UPDATE madarch_meta.schema_stamp SET stamp = $1 WHERE name = 'one-graph'", [oldStamp]);
    });
    original = (await first.run((tx) => tx.query(`SELECT n.uid, p.id, p.declaration FROM node n JOIN "${kindTable}" p ON p.node_id = n.id`))).rows;
  } finally { await first.close(); }

  const upgraded = await createDatabaseOwner({ store });
  try {
    expect(await prepareStore(upgraded, { contract })).toEqual({ reset: false });
    expect((await upgraded.run((tx) => tx.query(`SELECT n.uid, p.id, p.declaration FROM node n JOIN "${kindTable}" p ON p.node_id = n.id`))).rows).toEqual(original);
    expect((await upgraded.run((tx) => tx.query("SELECT words FROM operation WHERE author = 'manifest@1'"))).rows).toEqual([{ words: 'Keep this declaration' }]);
    const binding = await testHostBinding(upgraded, contract, 'manifest');
    await upgraded.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, { vertices: [], removals: [], edges: [{
        kind: MANIFEST_RELATION_EDGE,
        from: { kind: 'manifest.kind', key: { name: 'term' } },
        to: { kind: 'manifest.kind', key: { name: 'term' } },
        discriminator: 'related', values: { relation: 'related', declaration: { from: 'term', to: 'term' } },
        producer: 'manifest', producerVersion: '1',
      }] }, 1, { binding });
    });
    // The same preparation used before a fill must retain the metadata contract and its rows.
    expect(await prepareStore(upgraded, { contract: withManifestContract(contract) })).toEqual({ reset: false });
  } finally { await upgraded.close(); }

  const reopened = await createDatabaseOwner({ store });
  try {
    await createOneGraphSchema(reopened, contract);
    expect((await reopened.run((tx) => tx.query(`SELECT n.uid, p.id, p.declaration FROM node n JOIN "${kindTable}" p ON p.node_id = n.id`))).rows).toEqual(original);
    expect((await reopened.run((tx) => tx.query(`SELECT e.from_node = e.to_node AS self, p.relation FROM edge e JOIN "${edgeTable}" p ON p.edge_id = e.id WHERE p.state = 'open'`))).rows).toEqual([{ self: true, relation: 'related' }]);
  } finally { await reopened.close(); }
}, 30_000);
