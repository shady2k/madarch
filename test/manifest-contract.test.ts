/**
 * The manifest's contract preflight (decision 0035, items 2 and 11): every field names its producer, an authoritative
 * field has one, the dependency graph is declared and acyclic, and a plugin reads only the closure of its earliest
 * output kind. A valid manifest passes; each refusal names the kind or field it is about.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/knowledge/kinds.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-contract-'));
mkdirSync(join(root, 'templates'), { recursive: true });
mkdirSync(join(root, 'plugins', 'git'), { recursive: true });
writeFileSync(join(root, 'templates', 'a.liquid'), '{% block lead %}{% endblock %}\n');
writeFileSync(join(root, 'plugins', 'git', 'plugin.yaml'), 'id: git\n');
writeFileSync(join(root, 'plugins', 'git', 'contract.yaml'), 'contract: git\n');
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
${KIND('a', '    fields:\n      - { name: name, type: text, role: authoritative, producers: [git] }', '    key: [name]', '    depends-on: []')}
${KIND('b', '    fields:\n      - { name: name, type: text, role: authoritative, producers: [git] }\n      - { name: note, type: text, role: claimed, producers: [agent] }', '    key: [name]', '    depends-on: [a]')}
plugins:
  - { id: git, version: 0.0.1, inputs: [a], outputs: [a, b], closure: [plugins/git/plugin.yaml] }
`;

const findings = (text: string): string[] => parseKinds(text, 'madarch/kinds.yaml', root).findings.map((finding) => finding.message);

describe('the manifest contract preflight', () => {
  test('a valid contract passes: every field has a producer, the key is authoritative and the plugin reads its closure', () => {
    expect(findings(VALID)).toEqual([]);
  });

  test('a field with no producer is refused, naming the kind and the field', () => {
    const text = VALID.replace("      - { name: note, type: text, role: claimed, producers: [agent] }", '      - { name: note, type: text, role: claimed }');
    expect(findings(text)).toContainEqual(expect.stringContaining('kind "b": field "note" names no producer'));
  });

  test('a second producer of an authoritative field is refused, naming the field', () => {
    const text = VALID.replace("producers: [git] }\n      - { name: note", "producers: [git, other] }\n      - { name: note");
    expect(findings(text)).toContainEqual(expect.stringContaining('kind "b": field "name" is authoritative and names 2 producers: an authoritative field has one producer'));
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

  test('a claimed field in the natural key is refused', () => {
    const text = VALID.replace('    key: [name]\n    depends-on: [a]', '    key: [note]\n    depends-on: [a]');
    // The second kind's key names its claimed note; the first kind keeps its own key.
    const found = findings(text);
    expect(found).toContainEqual(expect.stringContaining('kind "b": key field "note" is claimed: a key field is authoritative'));
  });
});
