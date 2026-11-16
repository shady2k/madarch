import { testHostBinding } from './host-binding-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SCHEMA, SCHEMA_REVISION, graphSchemaStamp } from '../src/adapters/schemas/graph-definition.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { installDisputeSelection, refreshDisputeSelection } from '../src/graph/disputes.js';
import { readKindAssertions } from '../src/graph/records.js';
import { MANIFEST_CONTRACT, MANIFEST_RELATION_EDGE, withManifestContract } from '../src/graph/manifest-contract.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-self-edge-upgrade-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('upgrades a populated catalogue without resetting authored history and preserves self relations on reopen', async () => {
  const store = join(root, 'store');
  const before = withAssertionContract({ ...MANIFEST_CONTRACT, edge: MANIFEST_CONTRACT.edge.filter(edge => edge.name !== MANIFEST_RELATION_EDGE) });
  const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
  // Recreate the previous build's fingerprint before self relations were installed.
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
  const savedDeclaration = JSON.stringify({ taken: true });
  let operationUid = '';
  const first = await createDatabaseOwner({ store });
  let original: Awaited<ReturnType<typeof readKindAssertions>> = [];
  try {
    await prepareStore(first, { contract: before });
    const binding = await testHostBinding(first, before, 'manifest');
    await first.transaction('write', async (tx) => {
      await installDisputeSelection(tx, before);
      const capability = await activateGraphProducer(tx, before, binding);
      operationUid = capability.operationUid;
      const operation = await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid=$1::uuid', [operationUid]);
      await writeAssertion(tx, before, { sort: 'vertex', kind: 'system.operation', subjectId: operation.rows[0]!.id, property: 'words', operation: 'assert', value: 'Keep this declaration' });
      await publishGraphDrafts(tx, before, { vertices: [{
        kind: 'manifest.kind', key: { name: 'term' }, values: { declaration: savedDeclaration },
        producer: 'manifest', producerVersion: '1',
      }], removals: [] }, 1, { binding, author: 'manifest@1', words: 'Keep this declaration' });
      await tx.query('ALTER TABLE edge ADD CONSTRAINT edge_check CHECK (from_node <> to_node)');
      await tx.query("UPDATE madarch_meta.schema_stamp SET stamp = $1 WHERE name = 'one-graph'", [oldStamp]);
      await refreshDisputeSelection(tx, before);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    original = await first.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'], { contract: before }));
  } finally { await first.close(); }

  const upgraded = await createDatabaseOwner({ store });
  try {
    expect(await prepareStore(upgraded, { contract })).toEqual({ reset: false });
    expect(await upgraded.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'], { contract }))).toEqual(original);
    const operations = await upgraded.run(tx => readKindAssertions(tx, 'vertex', 'system.operation', ['words'], { contract, subjectUids: [operationUid] }));
    expect(operations.map(row => row.values.words)).toEqual(['Keep this declaration']);
    const binding = await testHostBinding(upgraded, contract, 'manifest');
    await upgraded.transaction('write', async (tx) => {
      await installDisputeSelection(tx, contract);
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [], removals: [], edges: [{
        kind: MANIFEST_RELATION_EDGE,
        from: { kind: 'manifest.kind', key: { name: 'term' } },
        to: { kind: 'manifest.kind', key: { name: 'term' } },
        discriminator: 'related', values: { relation: 'related', declaration: JSON.stringify({ from: 'term', to: 'term' }) },
        producer: 'manifest', producerVersion: '1',
      }] }, 1, { binding });
      await refreshDisputeSelection(tx, contract);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    // The same preparation used before a fill must retain the metadata contract and its rows.
    expect(await prepareStore(upgraded, { contract: withManifestContract(contract) })).toEqual({ reset: false });
  } finally { await upgraded.close(); }

  const reopened = await createDatabaseOwner({ store });
  try {
    await createOneGraphSchema(reopened, contract);
    expect(await reopened.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'], { contract }))).toEqual(original);
    const relations = await reopened.run(tx => readKindAssertions(tx, 'edge', MANIFEST_RELATION_EDGE, ['relation'], { contract }));
    expect(relations.map(row => ({ self: row.from === row.to, relation: row.values.relation }))).toEqual([{ self: true, relation: 'related' }]);
    const operations = await reopened.run(tx => readKindAssertions(tx, 'vertex', 'system.operation', ['words'], { contract, subjectUids: [operationUid] }));
    expect(operations.map(row => row.values.words)).toEqual(['Keep this declaration']);
  } finally { await reopened.close(); }
}, 30_000);
