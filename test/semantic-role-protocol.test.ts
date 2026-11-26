import { expect, test } from 'bun:test';
import { ROLE_BINDING_SCHEMA, checkRoleProperties, semanticRoleFields } from '../src/model/semantic-role-protocol.js';
import { Value } from 'typebox/value';

test('0037.1: the file role states no content, and the source role still does', () => {
  expect(semanticRoleFields('file')).not.toContain('content');
  expect(Value.Check(ROLE_BINDING_SCHEMA, { role: 'file', properties: { path: 'src/a.ts', content: 'export const a = 1;' } })).toBe(false);
  expect(() => checkRoleProperties('file', { path: 'src/a.ts', content: 'export const a = 1;' }, '/fixture/catalog.yaml:1')).toThrow();
  expect(semanticRoleFields('source')).toContain('content');
  expect(() => checkRoleProperties('source', { path: 'src/a.ts', content: 'export const a = 1;', repository: ['repo'] }, '/fixture/catalog.yaml:1')).not.toThrow();
});
