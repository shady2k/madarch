/**
 * Diagram relation words are the published catalogue's (owner's decision, 2026-11-15): the edge kind's own labels, or
 * the relation vocabulary's for a relation no edge kind carries — never a word the engine keeps and never a guess from
 * the key.
 */
import { expect, test } from 'bun:test';
import { publishedManifestOf, publishedRelationWords } from '../src/graphql/manifest.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MANIFEST = `catalog:
  subgroup-kind-bound: 2
  attributes: [version]
  origin-marks: [document, conversation, not-implemented]
  extractor-mark: extractor
  template-policies: [page, member, none]
  relations:
    manifest.depends-on: {"labels": {"en": {"out": "depends on", "in": "depended on by"}, "ru": {"out": "зависит от", "in": "от него зависят"}}}
    sample.powers: {"labels": {"en": {"out": "powers", "in": "powered by"}, "ru": {"out": "питает", "in": "питается от"}}}
groups:
  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }
  area.sub: { en: Sub, ru: Под, short: { en: Sub, ru: Под }, parent: area }
purposes:
  understand: { labels: { en: Understand, ru: Понять }, order: 10 }
roles:
  developer: { lead: [area], open: [] }
properties: {}
documents: { exclude: [], expect: [] }
kinds:
  sample:
    id: "sample.thing"
    group: area.sub
    purpose: understand
    definition: "A thing of the sample product."
    sources: ["https://example.test/thing"]
    acquisition: ["conversation"]
    relation-constraints: { out: [sample.powers], in: [] }
    template-policy: page
    source: graph
    origin: person
    labels:
      en: { one: Thing, many: Things }
      ru: { one: Вещь, many: Вещи }
    description:
      en: A thing of the sample product.
      ru: Вещь образца.
    key: []
edges:
  - name: sample.powers
    role: reference
    direction: out
    from: [sample]
    to: [sample]
    cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }
    labels:
      en: { out: powers, in: powered by }
      ru: { out: питает, in: питается от }
`;

test('relation words follow the reader language, from the published catalogue alone', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-diagram-language-'));
  try {
    const manifest = parseKinds(MANIFEST, 'madarch/catalog.yaml', folder);
    expect(manifest.findings).toEqual([]);
    const published = publishedManifestOf(manifest);
    // An edge kind names its own words in both directions.
    expect(publishedRelationWords(published, 'sample.powers', 'en', false)).toBe('powers');
    expect(publishedRelationWords(published, 'sample.powers', 'en', true)).toBe('powered by');
    expect(publishedRelationWords(published, 'sample.powers', 'ru', false)).toBe('питает');
    expect(publishedRelationWords(published, 'sample.powers', 'ru-RU', true)).toBe('питается от');
    // A relation no edge kind carries reads the vocabulary's words, in both languages.
    expect(publishedRelationWords(published, 'manifest.depends-on', 'en', false)).toBe('depends on');
    expect(publishedRelationWords(published, 'manifest.depends-on', 'ru', false)).toBe('зависит от');
    // A relation the catalogue names no words for has none: no key stands in its place.
    expect(publishedRelationWords(published, 'sample.untranslated', 'ru', true)).toBe('');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
