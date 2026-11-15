import { expect, test } from 'bun:test';
import { groupTree } from './frame.js';

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

