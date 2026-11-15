/**
 * Relation words are the product's declaration (owner's decision, 2026-11-15): every edge kind names both ends in each
 * interface language, the reader publishes those words with the catalogue, and the engine holds none of its own and
 * derives none from a key.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCatalogSchema } from '../src/knowledge/catalog.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';

test('a product declares arbitrary relation words independently of the starter set', () => {
  const result = readCatalogSchema({
    'subgroup-kind-bound': 12, attributes: ['version'], 'origin-marks': ['document'],
    'extractor-mark': 'extractor', 'template-policies': ['none'],
    relations: { 'sample.powers': { source: 'https://example.test/powers', labels: {
      en: { out: 'powers', in: 'powered by' }, ru: { out: 'питает', in: 'питается от' },
    } } },
  }, () => 7, '/product/madarch/catalog.yaml');
  expect(result.findings).toEqual([]);
  expect(result.schema?.relations.get('sample.powers')).toBe('https://example.test/powers');
  expect(result.schema?.relationLabels.get('sample.powers')).toEqual({
    en: { out: 'powers', in: 'powered by' }, ru: { out: 'питает', in: 'питается от' },
  });
});

/** A minimal catalogued manifest with one kind and one edge kind; the edge's labels are what a test changes. */
function manifest(edgeLabels: string | null): string {
  return [
    'catalog:',
    '  subgroup-kind-bound: 2',
    '  attributes: [version]',
    '  origin-marks: [document, conversation, not-implemented]',
    '  extractor-mark: extractor',
    '  template-policies: [page, member, none]',
    '  relations:',
    '    sample.covers: {"labels": {"en": {"out": "covers", "in": "covered by"}, "ru": {"out": "покрывает", "in": "покрыт"}}}',
    'groups:',
    '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }',
    '  area.sub: { en: Sub, ru: Под, short: { en: Sub, ru: Под }, parent: area }',
    'purposes:',
    '  understand: { labels: { en: Understand, ru: Понять }, order: 10 }',
    'roles:',
    '  developer: { lead: [area], open: [] }',
    'properties: {}',
    'documents: { exclude: [], expect: [] }',
    'kinds:',
    '  item:',
    '    id: "sample.item"',
    '    group: area.sub',
    '    purpose: understand',
    '    definition: "An item of the sample product."',
    '    sources: ["https://example.test/item"]',
    '    acquisition: ["conversation"]',
    '    relation-constraints: { out: [sample.covers], in: [] }',
    '    template-policy: page',
    '    source: graph',
    '    origin: person',
    '    labels:',
    '      en: { one: Item, many: Items }',
    '      ru: { one: Элемент, many: Элементы }',
    '    description:',
    '      en: An item of the sample product.',
    '      ru: Элемент образца.',
    '    key: []',
    'edges:',
    '  - name: sample.covers',
    '    from: [item]',
    '    to: [item]',
    ...(edgeLabels === null ? [] : [edgeLabels]),
  ].join('\n') + '\n';
}

const LABELS = [
  '    labels:',
  '      en: { out: covers, in: covered by }',
  '      ru: { out: покрывает, in: покрыт }',
];

function read(text: string) {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-relation-'));
  try {
    return parseKinds(text, 'madarch/catalog.yaml', folder);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('an edge kind\'s words are read and published for both directions and both languages', () => {
  const parsed = read(manifest(LABELS.join('\n')));
  expect(parsed.findings).toEqual([]);
  const edge = parsed.edges?.get('sample.covers');
  expect(edge?.labels).toEqual({ en: { out: 'covers', in: 'covered by' }, ru: { out: 'покрывает', in: 'покрыт' } });
  const published = publishedManifestOf(parsed);
  expect(published.edges.find((one) => one.name === 'sample.covers')?.labels).toEqual(edge?.labels);
  expect(published.relations.find((one) => one.name === 'sample.covers')?.labels).toEqual(edge?.labels);
});

test('an edge kind without both languages of words is refused, naming the file, the line and the edge', () => {
  const missing = read(manifest(null));
  expect(missing.edges?.has('sample.covers')).not.toBe(true);
  const finding = missing.findings.find((one) => one.message.includes('edge "sample.covers"'));
  expect(finding?.message).toContain('"labels" names the words the edge reads as at each end');
  expect(finding?.line).toBeGreaterThan(0);
  const englishOnly = read(manifest(['    labels:', '      en: { out: covers, in: covered by }'].join('\n')));
  expect(englishOnly.findings.map((one) => one.message)).toContainEqual(expect.stringContaining('the edge declares no words in "ru"'));
});
