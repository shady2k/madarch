import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quarantineInventory } from '../scripts/check-quarantine.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture(source: string): string {
  root = mkdtempSync(join(tmpdir(), 'quarantine-inventory-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'sample.test.ts'), source);
  return root;
}

test('inventory expands a quarantined suite into leaf cases without executing its hook', () => {
  const root = fixture(`
    describe('outer', () => {
      quarantined('madarch-64o5.14', describe)('slow', () => {
        beforeAll(() => { throw new Error('never execute'); });
        test('first', () => {});
        describe('nested', () => { test('second', () => {}); });
      });
      test('normal', () => {});
    });
  `);
  expect(quarantineInventory(root).map(({ name, task }) => ({ name, task }))).toEqual([
    { name: 'outer slow first', task: 'madarch-64o5.14' },
    { name: 'outer slow nested second', task: 'madarch-64o5.14' },
  ]);
});

test('inventory rejects missing, malformed and computed repair ids', () => {
  for (const id of ["''", "'other-14'", "'madarch-'", "'madarch-id.bad'", 'undefined', 'repairTask']) {
    const root = fixture(`quarantined(${id}, test)('slow', () => {});`);
    expect(() => quarantineInventory(root)).toThrow('literal task');
    rmSync(root, { recursive: true, force: true });
  }
});
