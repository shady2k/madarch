import { expect, test } from 'bun:test';
import { kindOfUnit } from '../src/knowledge/unit-kind.js';

test('a unit id names its graph kind before any scope', () => {
  expect(kindOfUnit('plugin-turns/disk:code.file')).toBe('code.file');
  expect(kindOfUnit('plugin-turns/disk:code.file@code.file:repo/src/a.ts')).toBe('code.file');
  expect(kindOfUnit('plugin-turns/disk:code.file:repo/src/a.ts')).toBe('code.file');
  expect(kindOfUnit('plugin-turns/disk:code.file#abc123')).toBe('code.file');
  expect(kindOfUnit('disk:code.file')).toBe('code.file');
});
