import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-kind-agent-'));
mkdirSync(join(root, 'templates'));
writeFileSync(join(root, 'templates/a.liquid'), '{% block lead %}{% endblock %}');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const read = (config?: string) => parseKinds(`groups:
  g: { en: Group, ru: Группа, short: { en: Group, ru: Группа } }
kinds:
  a:
    template: templates/a.liquid
    source: graph
    group: g
    fields:
      - { name: description, type: text, producers: [agent] }
${config === undefined ? '' : `    agent: ${config}`}
`, 'madarch/kinds.yaml', root);

test('agent availability does not create kind-level participation configuration', () => {
  const manifest = read();
  expect(manifest.findings).toEqual([]);
  expect(manifest.kinds.get('a')?.agent).toBeUndefined();
});

test('explicit ordinary plugin identity and field-scoped refinement survive parsing', () => {
  const manifest = read('{ plugin: agent-fill, fields: [description], refines: [extractor] }');
  expect(manifest.findings).toEqual([]);
  expect(manifest.kinds.get('a')?.agent).toEqual({ plugin: 'agent-fill', fields: ['description'], refines: ['extractor'] });
  expect(read('{ plugin: agent-fill, fields: "*" }').kinds.get('a')?.agent).toEqual({ plugin: 'agent-fill', fields: '*' });
});

test('invalid kind agent configuration is refused at its source line', () => {
  for (const config of [
    'true',
    '{ fields: [description] }',
    '{ plugin: agent-fill }',
    '{ plugin: agent-fill, fields: description }',
    '{ plugin: agent-fill, fields: [1] }',
    '{ plugin: agent-fill, fields: [], refines: extractor }',
    '{ plugin: agent-fill, fields: [], unknown: true }',
  ]) {
    const manifest = read(config);
    expect(manifest.kinds.has('a')).toBe(false);
    expect(manifest.findings).toContainEqual(expect.objectContaining({ file: 'madarch/kinds.yaml', line: 10 }));
  }
});
