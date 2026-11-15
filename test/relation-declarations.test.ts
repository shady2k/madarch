import { expect, test } from 'bun:test';
import { readCatalogSchema } from '../src/knowledge/catalog.js';
import { relationKey, relationWords } from '../src/knowledge/relation-labels.js';

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

test('a product relation without a declaration still reads as words, never the raw key', () => {
  expect(relationWords('code.imports', 'ru', false)).toBe('imports');
  expect(relationWords('c4.uses', 'en', false)).toBe('uses');
  expect(relationWords('sample.untranslated', 'ru', true)).toBe('untranslated');
});

test('an engine relation keeps its words when a row carries the field name instead of the edge kind', () => {
  // A relation row names the edge by its GraphQL field (`manifestDependsOn`); the shared vocabulary names the kind
  // (`manifest.depends-on`), so the heading reads words, never the raw key (madarch-64o5.96).
  expect(relationKey('manifestDependsOn')).toBe('manifest.depends-on');
  expect(relationKey('manifest.depends-on')).toBe('manifest.depends-on');
  expect(relationWords('manifestDependsOn', 'en', false)).toBe('depends on');
  expect(relationWords('manifestDependsOn', 'ru', false)).toBe('зависит от');
  expect(relationWords('manifestDependsOn', 'ru', true)).toBe('от него зависят');
  // A product relation the engine knows nothing of reads its last segment as words.
  expect(relationWords('codeImports', 'ru', false)).toBe('imports');
});
