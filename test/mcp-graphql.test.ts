/**
 * The MCP tools `graph_schema` and `graph_query` (decision 0036): the SDL and one operation, both through the same
 * executor the wiki's POST /graphql runs, over a real store.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema } from 'graphql';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { callRecordTool } from '../src/mcp/records.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let folder = '';
let owner: DatabaseOwner;
let fileA = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-mcp-graphql-'));
  folder = join(root, 'product');
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\nsections: []\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  const declared = graphContractOf(read.manifest);
  const contract = withManifestContract({ ...declared, edge: [...declared.edge, {
    name: 'demo.contains', table: generatedTableName('demo.contains', 'edge'), from: ['demo.repository'], to: ['demo.file'],
    repeats: false, fields: [{ name: 'position', type: 'integer', nullable: true }], capability: 'fixture',
  }] });
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await owner.transaction('write', async (tx) => {
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://example.test' }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' }, values: { lines: 10 }, producer: 'one', producerVersion: '1' },
      ],
      edges: [{ kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' } }, producer: 'one', producerVersion: '1' }],
      removals: [],
    }, 1, { author: 'one@1' });
  });
  const validation = validateProductManifests(folder);
  if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
  const ids = await owner.run(async (tx) => await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = 'demo.file'`));
  fileA = ids.rows[0]?.uid ?? '';
  if (fileA === '') throw new Error('the fixture file did not publish');
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

function context(): { owner: DatabaseOwner; repository: string; source: { repository: string; commit: string | null; branch: string | null; head: string | null; changed: { path: string; status: string }[] } } {
  return { owner, repository: folder, source: { repository: folder, commit: null, branch: null, head: null, changed: [] } };
}

test('graph_schema answers the product schema the executor uses', async () => {
  const answer = await callRecordTool('graph_schema', {}, context());
  expect(answer.isError).toBe(false);
  expect(() => buildSchema(answer.answer['schema'] as string)).not.toThrow();
});

test('graph_query runs an operation through the one executor', async () => {
  const answer = await callRecordTool('graph_query', { query: 'query ($id: ID!) { entity(id: $id) { ... on DemoFile { path lines } } }', variables: { id: fileA } }, context());
  expect(answer.isError).toBe(false);
  expect((answer.answer['data'] as Record<string, any>)['entity'].path).toBe('a.ts');
});

test('graph_query answers a refusal with its code', async () => {
  const answer = await callRecordTool('graph_query', { query: '{ allDemoRepository { edges { node { demoContains { edges { node { demoContainsOf { edges { node { path } } } } } } } } } }' }, context());
  expect(answer.isError).toBe(true);
  expect((answer.answer['errors'] as { extensions?: { code?: string } }[])[0]?.extensions?.code).toBe('LIMIT_DEPTH');
});
