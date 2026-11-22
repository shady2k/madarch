/**
 * The starter's value sets reach the graph (madarch-64o5.68): the product's start writes the declared `values:` as
 * value-set and value-set-entry entities through the one writer. Entry parent identity is an edge,
 * while assignment of a declared scalar stays an attribute (0039.29).
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests, startupBinding } from '../src/graph/manifest-publication.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { putEntityAssertion } from '../src/graph/graph-writes.js';
import { readKindAssertions } from '../src/graph/records.js';
import { bindWriteCapability } from '../src/graph/write.js';
import { writeContractOf } from '../src/graph/graph-writes.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-starter-values-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the declared value sets have parent edges and assignments remain scalar values', async () => {
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
    const sets = await owner.run(tx => readKindAssertions(tx, 'vertex', 'value-set', []));
    expect(sets.map(row => row.key['name']).sort()).toEqual(['issue-type', 'label', 'link-type', 'priority', 'task-status']);
    const entries = await owner.run(tx => readKindAssertions(tx, 'vertex', 'value-set-entry', ['label_en']));
    expect(entries).toHaveLength(27);
    const parents = await owner.run(tx => readKindAssertions(tx, 'edge', 'value-set-entry-set', []));
    const taskStatus = sets.find(row => row.key['name'] === 'task-status')!;
    const closed = entries.find(row => row.key['value'] === 'closed' && parents.some(edge => edge.from === row.id && edge.to === taskStatus.id))!;
    expect(closed).toBeDefined();
    expect(closed.key).toEqual({ value: 'closed' });
    expect(parents.filter(edge => edge.from === closed.id).map(edge => edge.to)).toEqual([taskStatus.id]);
    const snapshots = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content']));
    const snapshot = snapshots[0]!;
    const contract = writeContractOf(read.value.manifest);
    await owner.transaction('write', async tx => {
      const authenticated = await startupBinding(tx, contract, 'test'); bindWriteCapability(tx, authenticated.binding);
      await putEntityAssertion(tx, { producer: 'test', version: '1' }, {
        kind: 'task', key: { tracker: 'test', key: 'T-1' }, values: { title: 'A task', description: 'body', status: 'closed' },
        evidence: [{ target: { kind: 'system.content-snapshot', key: snapshot.key, uid: snapshot.uid } }],
      });
    });
    const held = await owner.run(tx => readKindAssertions(tx, 'vertex', 'task', ['status']));
    expect(held).toHaveLength(1);
    expect(held[0]!.values['status']).toBe('closed');
    const schema = graphqlSchemaOf(publishedManifestOf(read.value.manifest));
    expect(schema).toContain('status: String');
    expect(schema).not.toContain('statusOfTask');
  } finally { await owner.close(); }
}, 60_000);
