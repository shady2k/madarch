/** The quarantine catalogue contract survives starter-manifest generation. */
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { CATALOG_GROUPS, CATALOG_KINDS, CATALOG_RELATIONS } from '../src/knowledge/starter-catalog.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';

const row = CATALOG_KINDS.find((kind) => kind.name === 'code.test-quarantine')!;
const manifest = parseYaml(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content);

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
    expect(STARTER_FILES.some((file) => file.path === `templates/${row.template}`)).toBe(true);
  });

  test('the manifest keeps the plugin fields, typed references, natural key and discovery dependencies', () => {
    const kind = manifest.kinds['code.test-quarantine'];
    expect(kind.key).toEqual(['repository', 'path', 'name']);
    expect(kind['derives-from']).toEqual(['code.file', 'code.test-case', 'code.commit', 'task']);
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
