/**
 * The value-set kinds are the manifest's declaration, not an engine name (madarch-64o5.68): a product that renames the
 * kinds and their fields still publishes its sets, because the kind carries the roles the engine reads.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { readKindAssertions } from '../src/graph/records.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-value-set-markers-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MANIFEST = `
catalog:
  subgroup-kind-bound: 12
  attributes: [version]
  origin-marks: [conversation, document, not-implemented]
  extractor-mark: extractor
  template-policies: [page, member, none]
  relations: {}
groups:
  base: { en: "Base", ru: "База", short: { en: "Base", ru: "База" } }
  base.values: { en: "Values", ru: "Справочники", short: { en: "Values", ru: "Справочники" }, parent: base }
values:
  task-status:
    order: 10
    labels: { en: "Task status", ru: "Статус задачи" }
    entries:
      - { value: open, order: 10, labels: { en: Open, ru: Открыта }, description: Open. }
kinds:
  dictionary:
    source: graph
    group: base.values
    id: practice.dictionary
    definition: A named list of values a field may take.
    sources: ["https://example.test/dictionary"]
    acquisition: [conversation]
    relation-constraints: { out: [], in: [] }
    template-policy: page
    fields:
      - { name: name, type: text, producers: [person] }
      - { name: caption_en, type: text, producers: [person] }
      - { name: caption_ru, type: text, producers: [person] }
      - { name: note, type: text, nullable: true, producers: [person] }
      - { name: rank, type: integer, nullable: true, producers: [person] }
    key: [name]
    reference-set: { name: name, label-en: caption_en, label-ru: caption_ru, description: note, order: rank }
    labels: { en: { one: Dictionary, many: Dictionaries }, ru: { one: Справочник, many: Справочники } }
    description: { en: A dictionary., ru: Справочник. }
  dictionary-entry:
    source: graph
    group: base.values
    id: practice.dictionary-entry
    definition: One value of a named list.
    sources: ["https://example.test/dictionary"]
    acquisition: [conversation]
    relation-constraints: { out: [], in: [] }
    template-policy: page
    fields:
      - { name: value, type: text, producers: [person] }
      - { name: caption_en, type: text, producers: [person] }
      - { name: caption_ru, type: text, producers: [person] }
      - { name: note, type: text, nullable: true, producers: [person] }
      - { name: rank, type: integer, nullable: true, producers: [person] }
    key: [value]
    key-edges:
      - { role: dictionary-entry-set, edge: dictionary-entry-set, side: from }
    reference-set-entry: { set: dictionary-entry-set, value: value, label-en: caption_en, label-ru: caption_ru, description: note, order: rank }
    labels: { en: { one: Dictionary value, many: Dictionary values }, ru: { one: Значение, many: Значения } }
    description: { en: One value., ru: Одно значение. }
edges:
  - name: dictionary-entry-set
    from: [dictionary-entry]
    to: [dictionary]
    cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } }
    on-parent-delete: restrict
    labels: { en: { out: dictionary, in: entries }, ru: { out: справочник, in: значения } }
`;

test('a renamed value-set kind and its renamed fields still publish the starter sets', async () => {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFolderManifest(folder, MANIFEST);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  const read = validateProductManifests(folder);
  if (!read.ok) throw new Error(JSON.stringify(read.findings, null, 2));
  if (read.value === undefined) throw new Error('manifest absent');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(read.value.manifest)) });
  try {
    await createOneGraphSchema(owner, withManifestContract(graphContractOf(read.value.manifest)));
    await publishValidatedManifests(owner, read.value);
    const counts = async () => await owner.run(async tx => ({
      vertices: (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM assertion_vertex_subject s JOIN edge e ON e.id=s.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE k.name='dictionary-entry'`)).rows[0]!.count,
      edges: (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM assertion_edge_subject s JOIN edge e ON e.id=s.edge_id JOIN entity k ON k.id=e.entity_id WHERE k.name='dictionary-entry-set'`)).rows[0]!.count,
    }));
    const before = await counts();
    const repeated = await publishValidatedManifests(owner, read.value);
    const after = await counts();
    expect(repeated).toBe(0);
    expect(after).toEqual(before);
    const contract = graphContractOf(read.value.manifest);
    await owner.transaction('snapshot', async tx => {
      const sets = await readKindAssertions(tx, 'vertex', 'dictionary', ['caption_en', 'caption_ru'], { contract });
      expect(sets).toHaveLength(1);
      expect(sets[0]!.key).toEqual({ name: 'task-status' });
      expect(sets[0]!.values['caption_en']).toBe('Task status');
      const entries = await readKindAssertions(tx, 'vertex', 'dictionary-entry', ['caption_en', 'caption_ru'], { contract });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toEqual({ value: 'open' });
      expect(entries[0]!.values['caption_en']).toBe('Open');
      const parents = await readKindAssertions(tx, 'edge', 'dictionary-entry-set', [], { contract });
      expect(parents).toHaveLength(1);
      expect(parents[0]!.from).toBe(entries[0]!.id);
      expect(parents[0]!.to).toBe(sets[0]!.id);
    });
  } finally { await owner.close(); }
}, 60_000);


test('repeat publication adds value-set entries by key and parent before resolving existing endpoints', async () => {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFolderManifest(folder, MANIFEST);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  const first = validateProductManifests(folder);
  if (!first.ok || first.value === undefined) throw new Error(JSON.stringify(first));
  const contract = withManifestContract(graphContractOf(first.value.manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const readEntries = () => owner.transaction('snapshot', async tx => ({
    entries: await readKindAssertions(tx, 'vertex', 'dictionary-entry', ['caption_en'], { contract }),
    sets: await readKindAssertions(tx, 'vertex', 'dictionary', [], { contract }),
    parents: await readKindAssertions(tx, 'edge', 'dictionary-entry-set', [], { contract }),
  }));
  try {
    expect(await publishValidatedManifests(owner, first.value)).toBeGreaterThan(0);
    const before = await readEntries();
    expect(before.entries.map(row => row.key)).toEqual([{ value: 'open' }]);
    writeFolderManifest(folder, MANIFEST.replace('kinds:', `      - { value: closed, order: 20, labels: { en: Closed, ru: Закрыта }, description: Closed. }
  review-status:
    order: 20
    labels: { en: "Review status", ru: "Статус проверки" }
    entries:
      - { value: open, order: 10, labels: { en: Reviewing, ru: Проверяется }, description: Reviewing. }
kinds:`));
    const second = validateProductManifests(folder);
    if (!second.ok || second.value === undefined) throw new Error(JSON.stringify(second));
    expect(await publishValidatedManifests(owner, second.value)).toBeGreaterThan(0);
    const after = await readEntries();
    expect(after.entries).toHaveLength(3);
    expect(after.sets).toHaveLength(2);
    expect(after.parents).toHaveLength(3);
    const entry = (set: string, value: string) => {
      const parent = after.sets.find(row => row.key['name'] === set)!;
      return after.entries.find(row => row.key['value'] === value && after.parents.some(edge => edge.from === row.id && edge.to === parent.id))!;
    };
    expect(entry('task-status', 'open').uid).toBe(before.entries[0]!.uid);
    expect(entry('task-status', 'open').values['caption_en']).toBe('Open');
    expect(entry('task-status', 'closed').values['caption_en']).toBe('Closed');
    expect(entry('review-status', 'open').values['caption_en']).toBe('Reviewing');
    expect(entry('review-status', 'open').uid).not.toBe(before.entries[0]!.uid);
    const counts = () => owner.run(async tx => (await tx.query<{ nodes: string; edges: string; assertions: string }>(
      'SELECT (SELECT count(*)::text FROM node) AS nodes, (SELECT count(*)::text FROM edge) AS edges, (SELECT count(*)::text FROM assertion) AS assertions',
    )).rows[0]!);
    const published = await counts();
    // This third call checks the unchanged fingerprint shortcut, not entry matching.
    expect(await publishValidatedManifests(owner, second.value)).toBe(0);
    expect(await readEntries()).toEqual(after);
    expect(await counts()).toEqual(published);
  } finally { await owner.close(); }
}, 60_000);
