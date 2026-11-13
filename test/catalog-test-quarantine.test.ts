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
      id: 'practice.test-quarantine', group: 'testing.case', status: 'implemented',
      policy: 'page', source: 'graph', origin: 'code', template: 'test-quarantine.liquid',
      acquisition: ['extractor test-quarantine'],
      en: ['Test quarantine', 'Test quarantines'], ru: ['Карантин теста', 'Тесты в карантине'],
    });
    expect(CATALOG_GROUPS.find((group) => group.name === row.group)?.parent).toBe('testing');
    expect(CATALOG_KINDS.find((kind) => kind.name === 'code.test-case')?.id).not.toBe(row.id);
  });

  test('the manifest keeps the plugin fields, typed references, natural key and discovery dependencies', () => {
    const kind = manifest.kinds['code.test-quarantine'];
    expect(kind.key).toEqual(['repository', 'path', 'name']);
    expect(kind['derives-from']).toEqual(['code.file']);
    expect(kind.fields).toEqual([
      { name: 'repository', type: 'text', binding: 'test-quarantine@1.repository' },
      { name: 'path', type: 'text', binding: 'test-quarantine@1.path' },
      { name: 'name', type: 'text', binding: 'test-quarantine@1.name' },
      { name: 'test', type: 'json', reference: 'code.test-case', binding: 'test-quarantine@1.test' },
      { name: 'task', type: 'text', reference: 'task', binding: 'test-quarantine@1.task' },
      { name: 'quarantine_reason', type: 'text', binding: 'test-quarantine@1.quarantine_reason' },
      { name: 'since', type: 'text', reference: 'code.commit', binding: 'test-quarantine@1.since' },
      { name: 'latest_result', type: 'json', nullable: true, binding: 'test-quarantine@1.latest_result' },
    ]);
    expect(kind['relation-constraints']).toEqual({ out: ['quarantines', 'fixedBy'], in: [] });
    for (const relation of row.out) expect(CATALOG_RELATIONS).toHaveProperty(relation);
  });
});
