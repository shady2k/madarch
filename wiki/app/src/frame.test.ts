import { expect, test } from 'bun:test';
import { groupTree, productChoices } from './frame.js';

test('a loop kind is not a reading section, while an own-page kind with no other destination stays one', () => {
  const navigation = {
    product: 'probe', groups: [{ name: 'code', labels: { en: 'Code', ru: 'Код' }, short: null, open: false, parent: null }], purposes: [],
    kinds: [
      { kind: 'reading.kind', one: 'File', many: 'Files', definition: null, taken: true, group: 'code', nav: null, count: 2, entryId: 'e1', purpose: null, audience: null },
      { kind: 'own.kind', one: 'Task', many: 'Tasks', definition: null, taken: true, group: 'code', nav: 'own-page', count: 3, entryId: 'e2', purpose: null, audience: null },
      { kind: 'loop.kind', one: 'Value set', many: 'Value sets', definition: null, taken: true, group: 'code', nav: 'loop', count: 4, entryId: 'e3', purpose: null, audience: null },
    ],
  };
  const names = groupTree(navigation).flatMap((node) => [...node.kinds, ...node.subgroups.flatMap((subgroup) => [...subgroup.kinds])]).map((kind) => kind.kind);
  expect(names).toEqual(['reading.kind', 'own.kind']);
});

test('the product card offers each product at its own wiki address, the one in front marked', () => {
  const products = [{ name: 'Shop', folder: 'shop' }, { name: 'Docs', folder: 'docs', own: true as const }];
  // A products home serves each wiki under its folder, in the address the app is not mounted at.
  expect(productChoices('/products/shop', products, 'shop')).toEqual([
    { name: 'Shop', folder: 'shop', href: '/products/shop/', here: true },
    { name: 'Docs', folder: 'docs', href: '/products/docs/', here: false },
  ]);
  // A server that serves one product serves it at its root.
  expect(productChoices('', [{ name: 'Shop', folder: 'shop' }], 'shop')).toEqual([
    { name: 'Shop', folder: 'shop', href: '/', here: true },
  ]);
});
