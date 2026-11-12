import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { RELATION_LABELS, relationLabel } from '../src/knowledge/relation-labels.js';
import { CATALOG_KINDS, CATALOG_RELATIONS } from '../src/knowledge/starter-catalog.js';
import gitContract from '../plugins/git/contract.json';
import diskContract from '../plugins/disk/contract.json';
import dbSchema from '../plugins/db-schema/contract.json';

test('both languages directly name every catalogue and declared built-in relation', () => {
  const templateRelations = [...readFileSync(new URL('../src/knowledge/seed.ts', import.meta.url), 'utf8').matchAll(/relation="([^"]+)"/gu)].flatMap((match) => match[1]!.split(','));
  const expected = new Set([...templateRelations, ...Object.keys(CATALOG_RELATIONS), ...CATALOG_KINDS.flatMap((kind) => [...kind.out, ...kind.into]), ...gitContract.outputs.edges.map((edge) => edge.kind), ...diskContract.outputs.edges.map((edge) => edge.kind), ...dbSchema.outputs.edges.map((edge) => edge.kind)]);
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
