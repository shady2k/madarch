/**
 * The manifest's contract preflight (decision 0035, items 2 and 11): every field names its producer, an authoritative
 * field has one, the dependency graph is declared and acyclic, and a plugin reads only the closure of its earliest
 * output kind. A valid manifest passes; each refusal names the kind or field it is about.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-contract-'));
mkdirSync(join(root, 'templates'), { recursive: true });
mkdirSync(join(root, 'plugins', 'git'), { recursive: true });
mkdirSync(join(root, 'madarch'), { recursive: true });
writeFileSync(join(root, 'templates', 'a.liquid'), '{% block lead %}{% endblock %}\n');
// The plugin's own contract (decision 0035, items 3, 17 and 18): the fields its kinds declare, with their types.
const CONTRACT = {
  id: 'git',
  version: '1.0.0',
  outputs: {
    vertices: [
      { kind: 'a', key: ['name'], fields: [{ name: 'name', type: 'text', meaning: 'the name of a', example: 'one', required: true }, { name: 'tag', type: 'text', meaning: 'a tag', example: 'tag', required: true }] },
      { kind: 'b', key: ['name'], fields: [{ name: 'name', type: 'text', meaning: 'the name of b', example: 'two', required: true }, { name: 'note', type: 'text', meaning: 'a note', example: 'note', required: false }] },
    ],
    edges: [],
  },
};
writeFileSync(join(root, 'plugins', 'git', 'contract.json'), `${JSON.stringify(CONTRACT, null, 2)}\n`);
writeFileSync(join(root, 'madarch', 'plugins.lock'), `plugins:\n  - { id: git, version: 1.0.0, closure: ${'a'.repeat(64)}, path: plugins/git }\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const KIND = (name: string, fields: string, key: string, depends: string): string => `  ${name}:
    template: templates/a.liquid
    source: graph
    group: g
${fields}
${key}
${depends}`;

const VALID = `groups:
  g: { en: Group, ru: Группа, short: { en: Group, ru: Группа } }
kinds:
${KIND('a', '    fields:\n      - { name: name, type: text, producers: [git] }', '    key: [name]', '    depends-on: []')}
${KIND('b', '    fields:\n      - { name: name, type: text, producers: [git] }\n      - { name: note, type: text, producers: [agent] }', '    key: [name]', '    depends-on: [a]')}
plugins:
  - { id: git, version: 1, path: plugins/git, inputs: [a], outputs: [a, b], closure: [plugins/git/contract.json] }
`;

const findings = (text: string): string[] => parseKinds(text, 'madarch/catalog.yaml', root).findings.map((finding) => finding.message);

describe('the manifest contract preflight', () => {
  test('a valid contract passes: every field has a producer, the key is authoritative and the plugin reads its closure', () => {
    expect(findings(VALID)).toEqual([]);
  });

  test('a field that still says role is refused, naming the file and the line and saying the word is gone', () => {
    const text = VALID.replace("      - { name: note, type: text, producers: [agent] }", "      - { name: note, type: text, role: authoritative, producers: [agent] }");
    const read = parseKinds(text, 'madarch/catalog.yaml', root);
    const line = text.split('\n').findIndex((one) => one.includes('role: authoritative')) + 1;
    // The refusal names the file and the line the field stands on, and says the word is gone.
    expect(read.findings).toContainEqual({ file: 'madarch/catalog.yaml', line, message: expect.stringContaining('"role" is gone: no field is authoritative and none is claimed') });
  });

  test('a field with no producer is refused, naming the kind and the field', () => {
    const text = VALID.replace("      - { name: note, type: text, producers: [agent] }", '      - { name: note, type: text }');
    expect(findings(text)).toContainEqual(expect.stringContaining('kind "b": field "note" names no producer'));
  });

  test('a second producer of a field is accepted: no field is authoritative (A1)', () => {
    const text = VALID.replace("producers: [git] }\n      - { name: note", "producers: [git, other] }\n      - { name: note");
    expect(findings(text)).toEqual([]);
  });

  test('a dependency cycle is refused, naming the kinds', () => {
    const text = VALID.replace('    depends-on: []', '    depends-on: [b]');
    const found = findings(text);
    expect(found).toContainEqual(expect.stringContaining('the dependency cycle a -> b -> a is refused'));
  });

  test('a dependency on an undeclared kind is refused, naming it', () => {
    const text = VALID.replace('    depends-on: []', '    depends-on: [missing]');
    expect(findings(text)).toContainEqual(expect.stringContaining('kind "a": "depends-on" names the kind "missing", and the manifest declares no such kind'));
  });

  test('a plugin whose input lies outside the closure of its earliest output kind is refused', () => {
    const text = VALID.replace('inputs: [a], outputs: [a, b]', 'inputs: [a], outputs: [b]').replace('    depends-on: [a]', '    depends-on: []');
    expect(findings(text)).toContainEqual(expect.stringContaining('plugin "git": input "a" is outside the dependency closure of its earliest output kind "b"'));
  });

  test('any declared field may stand in the natural key: the key is the vertex\'s, and no field is authoritative', () => {
    const text = VALID.replace('    key: [name]\n    depends-on: [a]', '    key: [note]\n    depends-on: [a]');
    expect(findings(text)).toEqual([]);
  });
});

/**
 * The field bindings (decision 0035, items 17, 18 and 19): a field names its producer as `<plugin>@<major>.<field>`, the
 * table is built from the declarations, and the check refuses a binding to a field the plugin does not declare, a type
 * that differs from the plugin's and a required field the manifest leaves out — each with the manifest's file and line.
 */
describe('a manifest field names its producer explicitly', () => {
  const BOUND = (fields: string, key = '    key: [name]'): string => `groups:
  g: { en: Group, ru: Группа, short: { en: Group, ru: Группа } }
kinds:
  a:
    template: templates/a.liquid
    source: graph
    group: g
    fields:
${fields}
${key}
    depends-on: []
plugins:
  - { id: git, version: 1, path: plugins/git, inputs: [a], outputs: [a], closure: [plugins/git/contract.json] }
`;

  test('a valid manifest binds the key to the plugin field it declares, and passes', () => {
    const text = BOUND('      - { name: name, type: text, binding: "git@1.name" }\n      - { name: tag, type: text, binding: "git@1.tag" }');
    expect(findings(text)).toEqual([]);
    const read = parseKinds(text, 'madarch/catalog.yaml', root);
    const field = read.kinds.get('a')?.fields?.[0];
    expect(field?.binding).toEqual({ kind: 'plugin', plugin: 'git', major: '1', field: 'name' });
    expect(field?.line).toBeGreaterThan(1);
  });

  test('a binding to a field the plugin does not declare is refused, naming the file and the line', () => {
    const text = BOUND('      - { name: name, type: text, binding: "git@1.surname" }\n      - { name: tag, type: text, binding: "git@1.tag" }');
    const read = parseKinds(text, 'madarch/catalog.yaml', root);
    const finding = read.findings.find((one) => one.message.includes('declares no field "surname"'));
    expect(finding?.file).toBe('madarch/catalog.yaml');
    expect(finding?.line).toBeGreaterThan(1);
    expect(finding?.message).toContain('kind "a": field "name" binds to git@1.surname');
  });

  test('a type that differs from the plugin field is refused, naming both types', () => {
    const text = BOUND('      - { name: name, type: integer, binding: "git@1.name" }\n      - { name: tag, type: text, binding: "git@1.tag" }');
    expect(findings(text)).toContainEqual(expect.stringContaining('kind "a": field "name" is integer, and the plugin\'s field git@1.name is text'));
  });

  test('a required field the manifest leaves out is refused, naming the field and the binding to add', () => {
    const text = BOUND('      - { name: name, type: text, binding: "git@1.name" }');
    const found = findings(text);
    expect(found).toContainEqual(expect.stringContaining('the plugin "git" requires the field "tag"'));
    expect(found).toContainEqual(expect.stringContaining('binding: "git@1.tag"'));
  });

  test('a binding to a plugin the manifest does not declare is refused, naming the plugin', () => {
    const text = BOUND('      - { name: name, type: text, binding: "other@1.name" }\n      - { name: tag, type: text, binding: "git@1.tag" }');
    expect(findings(text)).toContainEqual(expect.stringContaining('the manifest declares no plugin "other"'));
  });
});
