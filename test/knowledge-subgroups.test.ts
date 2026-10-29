
/**
 * The sub-areas of the manifest's groups (madarch-m38l24): a group names a
 * parent, the kinds name the sub-area, and the starter set itself says which
 * kind belongs where. The engine holds no product's sub-areas.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES, STARTER_KINDS, GROUPS, starterManifest } from '../src/knowledge/seed.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-subgroups-'));
for (const starter of STARTER_FILES) {
  const file = join(folder, starter.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, starter.content);
}
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const parse = (text: string) => parseKinds(text, 'madarch/kinds.yaml', folder);
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
  });

  test('the starter set puts code in structure and analysis, and operations in its six sub-areas', () => {
    expect(GROUPS.filter((group) => group.parent === 'code').map((group) => group.name)).toEqual(['code.structure', 'code.analysis']);
    expect(GROUPS.filter((group) => group.parent === 'operations').map((group) => group.name)).toEqual([
      'operations.configuration', 'operations.dependencies', 'operations.build-deploy', 'operations.ci-cd', 'operations.runtime', 'operations.newcomer',
    ]);
    const byName = new Map(STARTER_KINDS.map((kind) => [kind.name, kind.group]));
    expect(byName.get('code.file')).toBe('code.structure');
    expect(byName.get('code.cycle')).toBe('code.analysis');
    expect(byName.get('code.env-var')).toBe('operations.configuration');
    expect(byName.get('code.dependency')).toBe('operations.dependencies');
    expect(byName.get('code.dockerfile')).toBe('operations.build-deploy');
    expect(byName.get('code.ci-workflow')).toBe('operations.ci-cd');
    expect(byName.get('code.process')).toBe('operations.runtime');
    expect(byName.get('code.newcomer-command')).toBe('operations.newcomer');
    const read = parse(starterManifest('ru'));
    expect(read.findings).toEqual([]);
    for (const group of GROUPS.filter((entry) => entry.parent !== undefined)) expect(read.groups.get(group.name)!.parent).toBe(group.parent);
    for (const kind of STARTER_KINDS) expect(read.kinds.get(kind.name)!.group).toBe(kind.group);
  });
});
