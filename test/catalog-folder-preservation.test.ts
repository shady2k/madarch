import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { seedStarterSet, starterFilesFor, starterKindNames } from '../src/knowledge/seed.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { CATALOG_KINDS, CATALOG_KIND_FILES } from '../src/knowledge/catalog-starter.js';
import { kindClosure } from '../src/knowledge/starter-templates.js';
import { byCodePoint } from '../src/model/order.js';
import sourcesBefore from './fixtures/starter-catalog-sources.json';

// Captured from the integration baseline before its TypeScript tables were removed.
test('everything copies each whole declaration and preserves every baseline kind and source', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-preservation-'));
  try {
    const written = seedStarterSet(folder, 'everything');
    expect(existsSync(join(folder, 'madarch/kinds.yaml'))).toBe(false);
    expect(written.filter((path) => path.startsWith('madarch/kinds/')).length).toBe(Object.keys(CATALOG_KIND_FILES).length);
    for (const file of starterFilesFor({ id: 'everything', title: {en: '', ru: ''}, description: {en: '', ru: ''}, kinds: 'all' })) {
      if (file.path.startsWith('madarch/kinds/')) expect(file.content).toBe(CATALOG_FILES[file.path.slice('madarch/kinds/'.length)]!);
    }
    const read = readKinds(folder);
    if (!read.present || read.manifest.catalog === undefined) throw new Error('the everything product must declare its catalogue');
    const expectedSources = {
      ...Object.fromEntries(Object.entries(sourcesBefore).filter(([name]) => name !== 'backlog-item')),
      "idea": ["https://www.omg.org/spec/BMM/"],
      "product-profile": ["https://backstage.io/docs/features/software-catalog/system-model/", "https://github.com/github-linguist/linguist"],
      "c4.component": ["https://c4model.com/abstractions/components"],
      "doc.term": ["https://www.w3.org/TR/skos-reference/", "https://www.iso.org/standard/79077.html"],
    };
    expect(Object.fromEntries([...read.manifest.catalog.kinds].map(([name, row]) => [name, row.sources]))).toEqual(expectedSources);
    expect(read.manifest.findings.filter((finding) => !finding.message.startsWith('"documents.expect" names the kind'))).toEqual([]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);

test('a template selects folders as well as kinds and rejects unknown selectors', () => {
  const template = {id: 'custom', title: {en: '', ru: ''}, description: {en: '', ru: ''}, kinds: ['code']};
  const names = starterKindNames(template);
  expect(names.length).toBeGreaterThan(0);
  // R1 (15e300356): a template that names a folder names what its kinds rest on too, so a folder's kinds are its own
  // files plus their `derives-from` closure — product-profile lives outside `kinds/code/` and is written with them. The
  // closure is the seed's own `kindClosure`, so this expectation cannot drift from it.
  const folderKinds = CATALOG_KINDS.filter((kind) => CATALOG_KIND_FILES[kind.name]?.startsWith('code/')).map((kind) => kind.name);
  const derivesFrom = new Map(CATALOG_KINDS.map((kind) => [kind.name, kind.derivesFrom ?? []]));
  const needed = new Set(kindClosure(folderKinds, (name) => derivesFrom.get(name)));
  const expected = CATALOG_KINDS.filter((kind) => needed.has(kind.name)).map((kind) => kind.name);
  expect([...names].sort(byCodePoint)).toEqual([...expected].sort(byCodePoint));
  // Every kind the expectation keeps has a catalogue file, so the written `madarch/kinds/…` paths are these kinds' files.
  const expectedFiles = expected.map((name) => {
    const file = CATALOG_KIND_FILES[name];
    if (file === undefined) throw new Error(`test/catalog-folder-preservation.test.ts:1: the catalogue holds no file for ${name}`);
    return file;
  });
  const written = starterFilesFor(template).filter((file) => file.path.startsWith('madarch/kinds/')).map((file) => file.path.slice('madarch/kinds/'.length));
  expect(written.sort(byCodePoint)).toEqual(expectedFiles.sort(byCodePoint));
  expect(() => starterKindNames({...template, kinds: ['missing-folder']})).toThrow('unknown kind or folder');
});
