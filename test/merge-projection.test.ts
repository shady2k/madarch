import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { startupBinding, validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { registerSystemSource } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer } from '../src/graph/producer-binding.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { resolveDuplicate } from '../src/graph/merges.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { SQL_TRANSACTION_KINDS } from '../src/sql-driver.js';

test('merged same-source member assertions agree across GraphQL fields, filters, ordering and aggregates', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-merge-projection-'));
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\nsections: []\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8').replace('catalog:\n', '  code:\n    en: Code\n    ru: Code\n    short: { en: Code, ru: Code }\n    open: true\n  code.structure:\n    en: Structure\n    ru: Structure\n    short: { en: Structure, ru: Structure }\n    parent: code\ncatalog:\n'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  const repository = readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8')
    .replace('key:\n- name', '- name: synonyms\n  type: json\n  schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: array, items: { type: string } }\n  producers: [agent]\nkey:\n- name');
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), repository);
  mkdirSync(join(folder, 'madarch/kinds/code/structure'), { recursive: true });
  writeFileSync(join(folder, 'madarch/kinds/code/structure/code.blob.yaml'), `id: code.blob
purpose: structure
definition: An immutable fixture content blob.
description: {en: Immutable fixture content., ru: Immutable fixture content.}
sources: [https://www.rfc-editor.org/rfc/rfc6234]
acquisition: [document]
relation-constraints: {out: [], in: []}
template-policy: none
source: graph
evidence: {immutable: true, digestField: digest, contentField: content, digestAlgorithm: sha256}
fields:
  - {name: digest, type: text, producers: [agent]}
  - {name: content, type: text, producers: [agent]}
key: [digest]
labels:
  en: {one: Content blob, many: Content blobs}
  ru: {one: Content blob, many: Content blobs}
`);
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = readKinds(folder);
  if (!read.present) throw new Error('missing fixture manifest');
  if (read.manifest.findings.length) throw new Error(read.manifest.findings.map(f => `${f.file}:${f.line}: ${f.message}`).join('\n'));
  const manifest = read.manifest;
  const contract = withManifestContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(validation.findings.map(f => `${f.file}:${f.line}: ${f.message}`).join('\n'));
    if (validation.value) await publishValidatedManifests(owner, validation.value);
    const scope = await owner.transaction(SQL_TRANSACTION_KINDS.write, async tx => (await startupBinding(tx, contract, 'fixture')).binding.productUid);
    const source = await registerSystemSource(owner, contract, { type: 'plugin', installationKey: 'merge-projection', scope, version: '1' });
    const binding = bindGraphProducer(owner, contract, { principal: source.principal,
      vertices: { 'demo.repository': ['size', 'synonyms'], 'code.blob': ['digest', 'content'] },
      edges: { mentions: [] }, actions: ['assert', 'merge'] });
    const ref = (name: string) => ({ kind: 'demo.repository', key: { name } });
    const digest = createHash('sha256').update('Merge evidence').digest('hex');
    await owner.transaction(SQL_TRANSACTION_KINDS.write, async tx => {
      await activateGraphProducer(tx, contract, binding);
      await publishGraphDrafts(tx, contract, { vertices: [
        { ...ref('first'), values: { size: 10, synonyms: ['shared'] }, validFrom: '2025-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1' },
        { ...ref('second'), values: { size: 20, synonyms: ['shared'] }, validFrom: '2020-01-01T00:00:00Z', producer: 'fixture', producerVersion: '1' },
        { ...ref('middle'), values: { size: 15, synonyms: [] }, producer: 'fixture', producerVersion: '1' },
        { ...ref('parent'), values: { synonyms: [] }, producer: 'fixture', producerVersion: '1' },
        { kind: 'code.blob', key: { digest }, values: { content: 'Merge evidence' }, producer: 'fixture', producerVersion: '1' },
      ], edges: ['first', 'second'].map(name => ({ kind: 'mentions', from: ref(name), to: ref('parent'), discriminator: 'shared', producer: 'fixture', producerVersion: '1' })), removals: [] });
    });
    const members = (await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, tx => readKindAssertions(tx, 'vertex', 'demo.repository', ['name'], { contract })))
      .filter(row => ['first', 'second'].includes(String(row.values['name'])));
    await owner.transaction(SQL_TRANSACTION_KINDS.write, async tx => {
      await activateGraphProducer(tx, contract, binding);
      await resolveDuplicate(tx, contract, binding, { members: members.map(row => ({ kind: 'demo.repository', key: {}, uid: row.uid })) as unknown as readonly [import('../src/graph/contract.js').EntityRefDraft, import('../src/graph/contract.js').EntityRefDraft],
        signals: { kind: 'demo.repository', name: 'name', synonyms: 'synonyms', edges: ['mentions'] }, decision: 'sure', reason: 'Checked common relation', evidence: [{ target: { kind: 'code.blob', key: { digest } } }] });
    });
    const answer = await executeGraphql(owner, { manifest, folder }, { query: `query($id: ID!) {
      entity(id: $id) { ... on KindDemoRepository { name size } }
      filtered: allDemoRepository(where: { size: { _eq: 10 } }) { totalCount edges { node { name size } } }
      ordered: allDemoRepository(where: { size: { _gte: 10 } }, orderBy: [{ field: size }]) { edges { node { name size } } }
      aggregate: allDemoRepositoryAggregate(where: { size: { _eq: 10 } }) {
        count
        groupBy(field: "size") { key count }
        histogram(field: "size", bounds: [15]) { from to count }
        topN(field: "size") { value node { label } }
      }
    }`, variables: { id: members.find(row => row.values['name'] === 'second')!.uid } });
    expect(answer.body.errors).toBeUndefined();
    expect(answer.body.data).toEqual({
      entity: { name: 'first', size: 10 },
      filtered: { totalCount: 1, edges: [{ node: { name: 'first', size: 10 } }] },
      ordered: { edges: [{ node: { name: 'first', size: 10 } }, { node: { name: 'middle', size: 15 } }] },
      aggregate: {
        count: 1,
        groupBy: [{ key: 10, count: 1 }],
        histogram: [{ from: null, to: 15, count: 1 }, { from: 15, to: null, count: 0 }],
        topN: [{ value: 10, node: { label: 'first' } }],
      },
    });
  } finally { await owner.close(); rmSync(folder, { recursive: true, force: true }); }
}, 30000);
