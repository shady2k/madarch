import { starterManifestText } from './catalog-folder-fixture.js';
/** The quarantine catalogue contract survives starter-manifest generation. */
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { CATALOG_GROUPS, CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';
import { readFileSync } from 'node:fs';
import { parse as parseCatalogYaml } from 'yaml';
const CATALOG_RELATIONS = parseCatalogYaml(readFileSync(new URL('../catalog/catalog.yaml', import.meta.url), 'utf8')).catalog.relations as Record<string, string | null>;

const row = CATALOG_KINDS.find((kind) => kind.name === 'code.test-quarantine')!;
const manifest = parseYaml(starterManifestText());

describe('test quarantine in the starter catalogue', () => {
  test('a quarantine is a bilingual page in testing, not a second test case', () => {
    expect(row).toMatchObject({
      id: 'practice.test-quarantine', group: 'testing.case',
      policy: 'page', source: 'graph', origin: 'code',
      sources: ['https://docs.gitlab.com/development/testing_guide/quarantining_tests/', 'https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html'],
      acquisition: ['extractor test-quarantine'],
      en: ['Test quarantine', 'Test quarantines'], ru: ['Карантин теста', 'Тесты в карантине'],
    });
    expect(CATALOG_GROUPS.find((group) => group.name === row.group)?.parent).toBe('testing');
    expect(CATALOG_KINDS.find((kind) => kind.name === 'code.test-case')?.id).not.toBe(row.id);
  });

  test('the manifest keeps scalar facts and declares entity relations as edges', () => {
    const kind = manifest.kinds['code.test-quarantine'];
    expect(kind.key).toEqual(['path', 'name']);
    expect(kind['key-edges']).toEqual([{ role: 'code.test-quarantine-repository', edge: 'code.test-quarantine-repository', side: 'from' }]);
    expect(kind['derives-from']).toEqual(['code.file', 'code.test-case']);
    expect(kind.fields).toEqual([
      { name: 'path', type: 'path', binding: 'test-quarantine@1.path' },
      { name: 'name', type: 'text', binding: 'test-quarantine@1.name' },
      { name: 'quarantine_reason', type: 'text', binding: 'test-quarantine@1.quarantine_reason' },
    ]);
    for (const field of ['test', 'task', 'since', 'latest-result']) {
      expect(manifest.edges.find((edge: { name: string }) => edge.name === `code.test-quarantine-${field}`)).toBeDefined();
    }
    expect(kind['relation-constraints']).toEqual({ out: ['quarantines', 'fixedBy'], in: [] });
    for (const relation of row.out) expect(CATALOG_RELATIONS).toHaveProperty(relation);
  });
});
