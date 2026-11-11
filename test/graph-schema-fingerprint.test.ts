import { expect, test } from 'bun:test';
import type { GraphContract } from '../src/graph/contract.js';
import { graphSchemaStamp } from '../src/adapters/schemas/graph-definition.js';

const contract: GraphContract = {
  vertex: [{ name: 'item', table: 'unused', capability: 'fixture', fields: [{ name: 'title', type: 'text' }], key: ['title'] }],
  edge: [{ name: 'link', from: ['item'], to: ['item'], repeats: false, capability: 'fixture', fields: [] }],
  dictionary: [{ name: 'label', fields: [{ name: 'text', type: 'text' }], key: ['text'] }],
};

test('every contract property changes the readiness fingerprint', () => {
  const original = graphSchemaStamp(contract);
  const variants: GraphContract[] = [
    { ...contract, vertex: [{ ...contract.vertex[0]!, checks: ['length(title) > 0'] }] },
    { ...contract, vertex: [{ ...contract.vertex[0]!, indexes: [{ name: 'title_lookup', columns: ['title'] }] }] },
    { ...contract, vertex: [{ ...contract.vertex[0]!, capability: 'other' }] },
    { ...contract, vertex: [{ ...contract.vertex[0]!, key: [] }] },
    { ...contract, vertex: [{ ...contract.vertex[0]!, fields: [{ name: 'title', type: 'text', nullable: true }] }] },
    { ...contract, edge: [{ ...contract.edge[0]!, from: ['other'] }] },
    { ...contract, edge: [{ ...contract.edge[0]!, to: ['other'] }] },
    { ...contract, edge: [{ ...contract.edge[0]!, repeats: true, discriminator: 'order' }] },
    { ...contract, dictionary: [{ ...contract.dictionary[0]!, checks: ['length(text) > 0'] }] },
    { ...contract, dictionary: [{ ...contract.dictionary[0]!, indexes: [{ name: 'label_lookup', columns: ['text'] }] }] },
  ];
  for (const variant of variants) expect(graphSchemaStamp(variant)).not.toBe(original);
});

test('object property order does not change the readiness fingerprint', () => {
  const reordered = {
    dictionary: contract.dictionary,
    edge: contract.edge,
    vertex: [{ key: ['title'], fields: [{ type: 'text' as const, name: 'title' }], capability: 'fixture', table: 'unused', name: 'item' }],
  };
  expect(graphSchemaStamp(reordered)).toBe(graphSchemaStamp(contract));
});
