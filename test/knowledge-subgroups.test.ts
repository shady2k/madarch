
/**
 * The sub-areas of the manifest's groups (madarch-m38l24): a group names a
 * parent, the kinds name the sub-area, and the starter set itself says which
 * kind belongs where. The engine holds no product's sub-areas.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { GROUPS } from './catalog-data-fixture.js';
import { starterKinds, starterManifestText } from './knowledge-fixture.js';
import { CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-subgroups-'));
for (const starter of STARTER_FILES) {
  const file = join(folder, starter.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, starter.content);
}
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const parse = (text: string) => parseKinds(text, 'madarch/catalog.yaml', folder);
const MANIFEST = [
  'groups:',
  '  code: { en: Code, ru: Код }',
  '  code.structure: { en: Structure, ru: Устройство, parent: code }',
  '  code.analysis: { en: Analysis, ru: Анализ, parent: code }',
  'kinds:',
  '  code.file: { template: templates/file.md, source: graph, group: code.structure }',
  '  code.cycle: { template: templates/item-plain.md, source: graph, group: code.analysis }',
  '',
].join('\n');

describe('sub-areas read from the manifest', () => {
  test('a group names its parent and a kind names the sub-area; neither is in the engine', () => {
    const read = parse(MANIFEST);
    expect(read.findings).toEqual([]);
    expect(read.groups.get('code')!.parent).toBeUndefined();
    expect(read.groups.get('code.structure')).toMatchObject({ labels: { en: 'Structure', ru: 'Устройство' }, parent: 'code' });
    expect(read.kinds.get('code.file')!.group).toBe('code.structure');
    expect(read.kinds.get('code.cycle')!.group).toBe('code.analysis');
  });

  test('a parent the manifest does not declare, itself, or one that is already a sub-area is a finding at its line', () => {
    const read = parse([
      'groups:',
      '  code: { en: Code }',
      '  code.structure: { en: Structure, parent: nowhere }',
      '  code.analysis: { en: Analysis, parent: code.structure }',
      '  self: { en: Self, parent: self }',
      'kinds: {}',
      '',
    ].join('\n'));
    expect(read.findings.map((finding) => finding.line)).toEqual([3, 4, 5]);
    expect(read.findings[0]!.message).toContain('"parent" names a group of "groups"');
    expect(read.findings[1]!.message).toContain('one level');
    expect(read.findings[2]!.message).toContain('itself');
    // Every invalid edge is discarded, so each of these groups is drawn at the top level instead of vanishing.
    for (const name of ['code.structure', 'code.analysis', 'self']) expect(read.groups.get(name)!.parent).toBeUndefined();
  });

  test('a cycle of parents is a finding at every edge, and both groups stand at the top level', () => {
    const read = parse([
      'groups:',
      '  a: { en: A, parent: b }',
      '  b: { en: B, parent: a }',
      'kinds: {}',
      '',
    ].join('\n'));
    expect(read.findings.map((finding) => finding.line)).toEqual([2, 3]);
    // The edge is invalid, so it is discarded: both groups are drawn at the top level, never hidden (the review).
    expect(read.groups.get('a')!.parent).toBeUndefined();
    expect(read.groups.get('b')!.parent).toBeUndefined();
  });

  test('a group may say it opens on the menu by itself, a field documented beside its labels and parent', () => {
    const read = parse([
      'groups:',
      '  product: { en: Product, ru: Продукт, open: true }',
      '  code: { en: Code }',
      'kinds: {}',
      '',
    ].join('\n'));
    expect(read.findings).toEqual([]);
    expect(read.groups.get('product')!.open).toBe(true);
    expect(read.groups.get('code')!.open).toBeUndefined();
    // The manifest's own comment block says what the group field means, beside `parent`, and its product group says it.
    const starter = parse(starterManifestText());
    expect(starter.findings).toEqual([]);
    expect(starter.groups.get('strategy')!.open).toBe(true);
    expect(starterManifestText()).toContain('`open: true`');
    const broken = parse([
      'groups:',
      '  product: { en: Product, open: yes }',
      'kinds: {}',
      '',
    ].join('\n'));
    expect(broken.findings.map((finding) => [finding.line, finding.message])).toEqual([[2, 'group "product": "open" is true or absent']]);
    expect(broken.groups.get('product')!.open).toBeUndefined();
  });

  test('the starter set puts every kind in a subgroup of an area, and neither is in the engine', () => {
    // The catalog's two levels: every kind names a subgroup, and every subgroup names an area the manifest declares.
    expect(GROUPS.filter((group) => group.parent === undefined).map((group) => group.name)).toContain('strategy');
    expect(GROUPS.filter((group) => group.parent === 'code').map((group) => group.name)).toEqual(['code.structure', 'code.analysis', 'contracts', 'code.schema']);
    expect(GROUPS.filter((group) => group.parent === 'operations').map((group) => group.name)).toEqual([
      'operations.slo', 'operations.observability', 'operations.runtime', 'operations.configuration',
      'operations.dependencies', 'operations.alerting', 'operations.incident', 'operations.jobs', 'operations.change',
    ]);
    const byName = new Map(CATALOG_KINDS.map((kind) => [kind.name, kind.group]));
    expect(byName.get('code.file')).toBe('code.structure');
    expect(byName.get('code.cycle')).toBe('code.analysis');
    expect(byName.get('code.env-var')).toBe('operations.configuration');
    expect(byName.get('code.dependency')).toBe('operations.dependencies');
    expect(byName.get('code.dockerfile')).toBe('delivery.build');
    expect(byName.get('code.ci-workflow')).toBe('delivery.pipeline');
    expect(byName.get('code.process')).toBe('infrastructure.compute');
    expect(byName.get('code.newcomer-command')).toBe('documentation.newcomer');
    const read = parse(starterManifestText('ru'));
    expect(read.findings).toEqual([]);
    for (const group of GROUPS.filter((entry) => entry.parent !== undefined)) expect(read.groups.get(group.name)!.parent).toBe(group.parent);
    for (const kind of starterKinds()) expect(read.kinds.get(kind.name)!.group).toBe(kind.group);
    for (const kind of read.catalog!.kinds.values()) expect(read.groups.get(kind.subgroup)!.parent).toBe(kind.area);
  });
});
