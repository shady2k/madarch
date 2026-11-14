import { expect, test } from 'bun:test';
import { readCatalogSchema } from '../src/knowledge/catalog.js';
import { relationWords } from '../src/knowledge/relation-labels.js';

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

test('the engine supplies no words for product relations', () => {
  expect(relationWords('code.imports', 'ru', false)).toBe('code.imports');
  expect(relationWords('c4.uses', 'en', false)).toBe('c4.uses');
  expect(relationWords('sample.untranslated', 'ru', true)).toBe('sample.untranslated');
});
