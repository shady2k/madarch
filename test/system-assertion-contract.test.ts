import { expect, test } from 'bun:test';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { SYSTEM_CONTRACT, withAssertionContract } from '../src/graph/system-contract.js';

test('assertion contracts retain prerequisite kinds and inherited extension fields', () => {
  const person = SYSTEM_CONTRACT.vertex.find(kind => kind.name === 'person')!;
  const contract = withAssertionContract({ ...EMPTY_CONTRACT, vertex: [{ ...person, fields: [...person.fields, { name: 'display_name', type: 'text', nullable: true }] }] });
  expect(contract.vertex.find(kind => kind.name === 'person')!.fields).toContainEqual({ name: 'display_name', type: 'text', nullable: true });
  expect(contract.vertex.find(kind => kind.name === 'system.operation')).toBeDefined();
  expect(contract.vertex.some(kind => ['system.source', 'system.person', 'system.plugin'].includes(kind.name))).toBe(false);
  expect(contract.vertex.find(kind => kind.name === 'question')).toBeDefined();
  expect(withAssertionContract(contract)).toEqual(contract);
  const operation = contract.vertex.find(kind => kind.name === 'system.operation')!;
  const extended = withAssertionContract({ ...contract, vertex: contract.vertex.map(kind => kind.name === operation.name ? { ...kind, fields: [...kind.fields, { name: 'note', type: 'text', nullable: true }] } : kind) });
  expect(extended.vertex.find(kind => kind.name === operation.name)!.fields).toContainEqual({ name: 'note', type: 'text', nullable: true });
  expect(() => withAssertionContract({ ...EMPTY_CONTRACT, vertex: [{ ...person, keyEdges: [{ role: 'owner', edge: 'owns', direction: 'from', onDelete: 'restrict' }] }] })).toThrow('identity or constraints');
  expect(() => withAssertionContract({ ...EMPTY_CONTRACT, vertex: [{ ...person, fields: [...person.fields, { name: 'required', type: 'text' }] }] })).toThrow('must be nullable');
  expect(() => withAssertionContract({ ...EMPTY_CONTRACT, vertex: [{ ...person, fields: [{ name: 'installation', type: 'integer' }] }] })).toThrow('protected field person.installation');
  expect(() => withAssertionContract({ ...EMPTY_CONTRACT, vertex: [{ ...person, key: ['installation'] }] })).toThrow('protected system');
});
