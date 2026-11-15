/**
 * The starter's value sets reach the graph (madarch-64o5.68): the product's start writes the declared `values:` as
 * value-set and value-set-entry entities through the one writer, so an entry has a page and the field that points at
 * it has a backlink.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { testAgentBinding } from './host-binding-fixture.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { putEntityOpinion } from '../src/graph/graph-writes.js';
import { generatedTableName } from '../src/graph/contract.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-starter-values-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the declared value sets are published as entities, and a field points at an entry', async () => {
  const folder = mkdtempSync(join(root, 'product-'));
  seedStarterSet(folder);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  expect(readFileSync(join(folder, 'madarch/catalog.yaml'), 'utf8')).toContain('values:');
  const read = validateProductManifests(folder);
  if (!read.ok) throw new Error(JSON.stringify(read.findings, null, 2));
  if (read.value === undefined) throw new Error('starter manifest refused');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(read.value.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(read.value.manifest)));
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const sets = await owner.run((tx) => tx.query<{ name: string }>(`SELECT n.key->>'name' AS name FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'value-set' AND NOT n.removed ORDER BY 1`));
    expect(sets.rows.map((row) => row.name)).toEqual(['issue-type', 'label', 'link-type', 'priority', 'task-status']);
    const entries = await owner.run((tx) => tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'value-set-entry' AND NOT n.removed`));
    expect(entries.rows[0]!.count).toBe('27');
    const closed = await owner.run((tx) => tx.query<{ set: Record<string, unknown> }>(`SELECT n.key->'set' AS set FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'value-set-entry' AND n.key->>'value' = 'closed' AND NOT n.removed`));
    expect(closed.rows[0]!.set).toEqual({ kind: 'value-set', key: { name: 'task-status' } });
    // A work entity's field points at the entry, and the entry's page reaches it back through that reference.
    await putEntityOpinion(owner, await testAgentBinding(owner, withManifestContract(graphContractOf(read.value.manifest))), {
      kind: 'task', key: { tracker: 'test', key: 'T-1' }, values: { title: 'A task', description: 'body', status: { kind: 'value-set-entry', key: { set: { kind: 'value-set', key: { name: 'task-status' } }, value: 'closed' } } },
      evidence: [{ type: 'conversation', id: 'test', words: 'A task with a status.' }],
    });
    const held = await owner.run((tx) => tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${generatedTableName('task', 'vertex')}" p JOIN node n ON n.id = p.node_id WHERE p.state = 'open' AND p.status->'key'->>'value' = 'closed'`));
    expect(held.rows[0]!.count).toBe('1');
    const schema = graphqlSchemaOf(publishedManifestOf(read.value.manifest));
    expect(schema).toContain('statusOfTask');
  } finally { await owner.close(); }
}, 60_000);
