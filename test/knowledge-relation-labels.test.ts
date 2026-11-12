import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { RELATION_LABELS, relationLabel } from '../src/knowledge/relation-labels.js';
import { CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { parseCatalogYaml } from '../src/product/manifest/kinds.js';
import { GIT_CONTRACT, GIT_MANIFEST_EDGES } from '../src/fill/stages/git-contract.js';
import dbSchema from '../plugins/db-schema/contract.json';

const CATALOG_RELATIONS = (parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as { catalog: { relations: Record<string, string | null> } }).catalog.relations;

test('both languages directly name every catalogue and declared built-in relation', () => {
  const templateRelations = [...readFileSync(new URL('../src/knowledge/seed.ts', import.meta.url), 'utf8').matchAll(/relation="([^"]+)"/gu)].flatMap((match) => match[1]!.split(','));
  const expected = new Set([...templateRelations, ...Object.keys(CATALOG_RELATIONS), ...CATALOG_KINDS.flatMap((kind) => [...kind.out, ...kind.into]), ...Object.keys(GIT_MANIFEST_EDGES), ...GIT_CONTRACT.edge.map((edge) => edge.name), ...dbSchema.outputs.edges.map((edge) => edge.kind)]);
  for (const labels of Object.values(RELATION_LABELS)) {
    for (const id of expected) {
      expect(Object.hasOwn(labels, id), id).toBe(true);
      expect(labels[id]!.trim().length, id).toBeGreaterThan(0);
    }
  }
});

test('qualified built-ins translate without treating arbitrary custom relations as built-ins', () => {
  expect(relationLabel('code.contains', 'ru')).toBe('содержит');
  expect(relationLabel('partOf', 'en')).toBe('part of');
  expect(relationLabel('custom.relates-to', 'ru')).toBe('custom.relates to');
  expect(relationLabel('code.custom-word', 'ru')).toBe('custom word');
});
