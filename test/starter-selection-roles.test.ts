import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';

test('a selected catalogue keeps roles named by its kinds even when those roles lead no selected group', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-selected-roles-'));
  try {
    seedStarterSet(folder, 'fixture', [{ id: 'fixture', title: { en: 'Fixture', ru: 'Пример' }, description: { en: 'Fixture', ru: 'Пример' }, kinds: ['code.repository', 'code.directory', 'code.file'] }]);
    const read = readKinds(folder);
    expect(read.present).toBe(true);
    if (!read.present) throw new Error(`${folder}/madarch/catalog.yaml:1: missing selected catalogue`);
    const manifest = read.manifest;
    expect(manifest.findings).toEqual([]);
    expect(manifest.kinds.size).toBe(3);
    expect(manifest.roles.has('platform-devops')).toBe(true);
    expect(manifest.roles.get('platform-devops')?.lead).toEqual([]);
    expect(manifest.kinds.get('code.repository')?.audience).toContain('platform-devops');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
