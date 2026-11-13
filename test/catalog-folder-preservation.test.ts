import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { seedStarterSet, starterFilesFor, starterKindNames } from '../src/knowledge/seed.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import sourcesBefore from './fixtures/starter-catalog-sources.json';

// Captured from the integration baseline before its TypeScript tables were removed.
test('everything copies each whole declaration and preserves every baseline kind and source', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-preservation-'));
  try {
    const written = seedStarterSet(folder, 'everything');
    expect(existsSync(join(folder, 'madarch/kinds.yaml'))).toBe(false);
    expect(written.filter((path) => path.startsWith('madarch/kinds/')).length).toBe(Object.keys(sourcesBefore).length);
    for (const file of starterFilesFor({ id: 'everything', title: {en: '', ru: ''}, description: {en: '', ru: ''}, kinds: 'all' })) {
      if (file.path.startsWith('madarch/kinds/')) expect(file.content).toBe(CATALOG_FILES[file.path.slice('madarch/kinds/'.length)]!);
    }
    const read = readKinds(folder);
    if (!read.present || read.manifest.catalog === undefined) throw new Error('the everything product must declare its catalogue');
    expect(Object.fromEntries([...read.manifest.catalog.kinds].map(([name, row]) => [name, row.sources]))).toEqual(sourcesBefore);
    expect(read.manifest.findings.filter((finding) => !finding.message.startsWith('"documents.expect" names the kind'))).toEqual([]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);

test('a template selects folders as well as kinds and rejects unknown selectors', () => {
  const template = {id: 'custom', title: {en: '', ru: ''}, description: {en: '', ru: ''}, kinds: ['code']};
  const names = starterKindNames(template);
  expect(names.length).toBeGreaterThan(0);
  expect(starterFilesFor(template).filter((file) => file.path.startsWith('madarch/kinds/')).every((file) => file.path.startsWith('madarch/kinds/code/'))).toBe(true);
  expect(() => starterKindNames({...template, kinds: ['missing-folder']})).toThrow('unknown kind or folder');
});
