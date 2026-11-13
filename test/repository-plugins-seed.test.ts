import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { seedRepositoryPlugins } from './enabled-plugins-fixture.js';
import { restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { readFolderManifestText } from './catalog-folder-fixture.js';

test('repository-only fixture writes every disk/git closure byte and no unrelated plugin', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-repository-plugins-'));
  try {
    seedRepositoryPlugins(folder);
    restrictRepositoryDeclarations(folder);
    expect(readdirSync(join(folder, 'plugins')).sort()).toEqual(['disk', 'git']);
    const expected = STARTER_FILES.filter(file => file.path.startsWith('plugins/disk/') || file.path.startsWith('plugins/git/'));
    const actual = readdirSync(join(folder, 'plugins'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1)).sort();
    expect(actual).toEqual(expected.map(file => file.path).sort());
    for (const file of expected) {
      expect(readFileSync(join(folder, file.path))).toEqual(Buffer.from(file.bytes ?? file.content));
    }
    const lock = parse(readFileSync(join(folder, 'madarch/plugins.lock'), 'utf8'));
    const starterLock = parse(STARTER_FILES.find(file => file.path === 'madarch/plugins.lock')!.content);
    expect(lock.plugins).toEqual(starterLock.plugins.filter((plugin: { id: string }) => ['disk', 'git'].includes(plugin.id)));
    const manifest = parse(readFolderManifestText(folder));
    expect(manifest.plugins.map((plugin: { id: string }) => plugin.id).sort()).toEqual(['disk', 'git']);
    for (const plugin of manifest.plugins) {
      expect(plugin.closure.slice().sort()).toEqual(expected.filter(file => file.path.startsWith(`plugins/${plugin.id}/`)).map(file => file.path).sort());
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 10_000);
