import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { validateProductManifests, publishValidatedManifests, type ValidatedManifests } from '../src/graph/manifest-publication.js';
import { MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE, withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { publicationCounts } from './publication-counts.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { sha256Hex } from '../src/graph/digest.js';

import { seedRepositoryPlugins } from './enabled-plugins-fixture.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';

function validated(folder: string): ValidatedManifests {
  const read = validateProductManifests(folder);
  if (!read.ok) throw new Error(read.findings.map(one => `${one.file}:${one.line}: ${one.message}`).join('\n'));
  if (read.value === undefined) throw new Error(`${folder}:1: no manifest`);
  return read.value;
}

function fullStarter(home: string): string {
  const draft = createDraft({ home, name: 'catalogue-growth', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  return draft.folder;
}

test('repository extraction closes with product interpretation and a product profile', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-repository-closure-'));
  try {
    seedRepositoryPlugins(folder);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}:1: no manifest`);
    const plan = planManifestFill(read.manifest, folder, ['code.repository', 'code.blob']);
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.selectedKinds).toContain('code.repository');
    expect(plan.selectedKinds).toContain('code.blob');
    expect(plan.selectedKinds).toContain('product');
    expect(plan.selectedKinds).toContain('product-profile');
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);

const universal = ['mentions', 'linksTo', 'grounds', 'ownedBy'];
const about = ['question-about', 'correction-about'];

function expectUniversalDeclarations(read: ValidatedManifests): void {
  for (const name of universal) {
    expect(read.manifest.edges!.get(name)).toMatchObject({ from: ['any'], to: ['any'] });
  }
  for (const name of about) expect(read.manifest.edges!.get(name)?.to).toEqual(['any']);
  for (const name of [...universal, ...about]) {
    const relation = read.vertices.find(one => one.kind === 'manifest.relation' && one.key['name'] === JSON.stringify(['edge', name]));
    expect(relation).toBeDefined();
    expect(JSON.parse(String(relation!.values!['declaration'])).to).toEqual(['any']);
    expect(read.edges.filter(one => one.discriminator === name)).toEqual([]);
  }
}

test('adding one kind to the full starter publishes only its own field, relation and real endpoint pair', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-catalog-any-growth-'));
  try {
    const folder = fullStarter(root);
    const before = validated(folder);
    expectUniversalDeclarations(before);
    const expectedPairs = new Set<string>();
    for (const [name, edge] of before.manifest.edges ?? []) {
      for (const from of edge.from) for (const to of edge.to) {
        if (from !== 'any' && to !== 'any') expectedPairs.add(JSON.stringify([MANIFEST_RELATION_EDGE, from, to, name]));
      }
    }
    for (const [name, kind] of before.manifest.kinds) {
      for (const relation of kind.relations) expectedPairs.add(JSON.stringify([MANIFEST_RELATION_EDGE, name, relation.to.split(':')[0], relation.type]));
      for (const dependency of kind.derivesFrom ?? []) expectedPairs.add(JSON.stringify([MANIFEST_DEPENDS_ON, name, dependency, '']));
    }
    for (const [name, kind] of before.manifest.catalog?.kinds ?? []) {
      if (!before.manifest.kinds.has(name)) for (const dependency of kind.derivesFrom ?? []) {
        expectedPairs.add(JSON.stringify([MANIFEST_DEPENDS_ON, name, dependency, '']));
      }
    }
    // Whole catalogue dependencies, concrete edge endpoints, a declared relation, and the six work kinds at both
    // ends of work.depends-on.
    expect(expectedPairs.size).toBe(813 + 185 + 1 + 36);
    expect(new Set(before.edges.map(one => JSON.stringify([one.kind, one.from.key['name'], one.to.key['name'], one.discriminator ?? ''])))).toEqual(expectedPairs);
    expect(before.edges).toHaveLength(expectedPairs.size);

    // Keep every starter declaration. Add a product-owned kind in an existing catalogue group.
    const base = parse(readFileSync(join(folder, 'madarch/kinds/common/schema/responsibility.yaml'), 'utf8'));
    const file = join(folder, 'madarch/kinds/common/schema/fixture.growth.yaml');
    writeFileSync(file, stringify({ ...base, id: 'fixture.growth', 'derives-from': [],
      labels: { en: { one: 'Growth fixture', many: 'Growth fixtures' }, ru: { one: 'Пример роста', many: 'Примеры роста' } },
      fields: [{ name: 'summary', type: 'text', nullable: true, producers: ['fixture'] }],
      relations: [{ type: 'mentions', to: 'code.file:example.ts' }],
    }));
    const after = validated(folder);
    expectUniversalDeclarations({ ...after, edges: after.edges.filter(one => one.from.key['name'] !== 'fixture.growth') });
    expect(after.manifest.kinds.size - before.manifest.kinds.size).toBe(1);
    expect(after.manifest.edges).toEqual(before.manifest.edges);
    expect(after.vertices.length - before.vertices.length).toBe(3);
    expect(after.edges.length - before.edges.length).toBe(1);
    expect(after.starterValues).toEqual(before.starterValues);
    const identity = (one: ValidatedManifests['vertices'][number]) => JSON.stringify([one.kind, one.key, one.keyEdges ?? {}]);
    const original = new Set(before.vertices.map(identity));
    expect(after.vertices.filter(one => !original.has(identity(one))).map(one => [one.kind, one.key['name']])).toEqual([
      ['manifest.field', JSON.stringify(['fixture.growth', 'summary'])],
      ['manifest.kind', 'fixture.growth'],
      ['manifest.relation', JSON.stringify(['fixture.growth', 0])],
    ]);
    // The aggregate catalogue changes, but all prior individual declarations and endpoint pairs remain identical.
    expect(after.vertices.filter(one => original.has(identity(one)) && one.kind !== 'manifest.catalogue'))
      .toEqual(before.vertices.filter(one => one.kind !== 'manifest.catalogue'));
    expect(after.edges.filter(one => one.from.key['name'] !== 'fixture.growth')).toEqual([...before.edges]);
    expect(after.edges.filter(one => one.from.key['name'] === 'fixture.growth')).toMatchObject([
      { kind: MANIFEST_RELATION_EDGE, from: { key: { name: 'fixture.growth' } }, to: { key: { name: 'code.file' } }, discriminator: 'mentions' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000); // Measured 14.86 s on 2026-11-16 with the complete starter catalogue.

test('publishing the same full starter catalogue again writes no declarations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-catalog-any-repeat-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const folder = fullStarter(root);
    const first = validated(folder);
    expectUniversalDeclarations(first);
    owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(first.manifest)) });
    expect(await publishValidatedManifests(owner, first)).toBeGreaterThan(0);
    const repeat = validated(folder);
    const counts = await publicationCounts(owner, measured => publishValidatedManifests(measured, repeat));
    console.log('ALX-132 starter repeat', JSON.stringify(counts));
    expect(counts.result).toBe(0);
    expect(counts.after).toEqual(counts.before);
    expect(counts.writes).toBe(0);
    expect(counts.constraints).toBe(0);
    expect(counts.statements).toBeLessThanOrEqual(3);
    expect(counts.reads).toBeLessThanOrEqual(200);
    await owner.transaction('write', async tx => {
      const { contract } = await startupBinding(tx, withManifestContract(graphContractOf(first.manifest)), 'foreign');
      await publishGraphDrafts(tx, contract, { vertices: Array.from({ length: 200 }, (_, i) => {
        const content = `foreign snapshot ${i}`;
        return { kind: 'system.content-snapshot', key: { digest: sha256Hex(new TextEncoder().encode(content)) }, values: { content }, producer: 'foreign', producerVersion: '1' };
      }), removals: [] });
    });
    const larger = await publicationCounts(owner, measured => publishValidatedManifests(measured, repeat));
    console.log('ALX-174 larger starter repeat', JSON.stringify(larger));
    expect(larger.result).toBe(0);
    expect(larger.after).toEqual(larger.before);
    expect(larger.before.nodes).toBeGreaterThan(counts.before.nodes);
    expect(larger.writes).toBe(0);
    expect(larger.constraints).toBe(0);
    expect(larger.statements).toBeLessThanOrEqual(3);
    // Tuple-read counts vary with query plans; added snapshots must not cause proportional reads.
    expect(larger.reads - counts.reads).toBeLessThan(larger.before.nodes - counts.before.nodes);
  } finally { await owner?.close(); rmSync(root, { recursive: true, force: true }); }
}, 300_000); // Observed 232.67–281.17 s on this box through the plugin sandbox; worst observed headroom under 300 s is 18.83 s.

function endpointFixture(folder: string, from: string, to: string): string {
  mkdirSync(join(folder, 'madarch'));
  writeFolderManifest(folder, `edges: []
kinds:
  alpha:
    source: document
    terms: ["docs/*.md"]
`);
  const file = join(folder, 'madarch/catalog.yaml');
  const metadata = readFileSync(file, 'utf8').replace('edges: []', `edges:
  - name: connects
    from: ${from}
    to: ${to}
    repeats: false
    cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }
    labels:
      en: { out: connects, in: connected by }
      ru: { out: связывает, in: связан с }`);
  writeFileSync(file, metadata);
  return file;
}

for (const [from, to] of [['[any]', '[any]'], ['[any]', '[alpha]'], ['[alpha]', '[any]']]) {
  test(`a standalone any endpoint is valid for ${from} to ${to} without concrete catalogue pairs`, () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-any-endpoint-'));
    try {
      endpointFixture(folder, from!, to!);
      const read = validateProductManifests(folder, undefined, 'a'.repeat(40));
      if (!read.ok) throw new Error(read.findings.map(one => `${one.file}:${one.line}: ${one.message}`).join('\n'));
      expect(read.value!.manifest.edges!.get('connects')).toMatchObject({ from: parse(from!), to: parse(to!) });
      expect(read.value!.vertices.filter(one => one.kind === 'manifest.relation')).toHaveLength(1);
      expect(read.value!.edges.filter(one => one.kind === MANIFEST_RELATION_EDGE)).toEqual([]);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}

for (const direction of ['from', 'to'] as const) {
  test(`any cannot be mixed with a named ${direction} endpoint and reports its exact source location`, () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-any-mixed-'));
    try {
      const file = endpointFixture(folder, direction === 'from' ? '[any, alpha]' : '[alpha]', direction === 'to' ? '[any, alpha]' : '[alpha]');
      const line = readFileSync(file, 'utf8').split('\n').findIndex(one => one.includes(`${direction}: [any, alpha]`)) + 1;
      const read = validateProductManifests(folder, undefined, 'a'.repeat(40));
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error(`${file}:${line}: mixed any accepted`);
      expect(read.findings.map(one => ({ file: one.file, line: one.line }))).toEqual([{ file, line }]);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}
