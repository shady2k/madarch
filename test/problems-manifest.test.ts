/**
 * The `problems:` block of a product's manifest (madarch-m38l.19): the manifest declares every rule
 * the page runs — its predicate, kind, Sonar kind, severity, section, action, label and parameters —
 * and the thresholds the size rules read. The engine keeps only the predicates, so the engine has no
 * rule of its own to fall back to and a declaration that misses a field is a finding at its line.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES, STARTER_PROBLEM_RULES } from '../src/knowledge/seed.js';
import { DEFAULT_THRESHOLDS } from '../src/problems/types.js';

const fresh = (): string => mkdtempSync(join(tmpdir(), 'madarch-problems-manifest-'));
const parse = (text: string) => parseKinds(text, 'madarch/kinds.yaml', fresh());
const rule = (severity = 'minor', patch = ''): string => `{ predicate: large-file, kind: large-file, sonar: code-smell, severity: ${severity}, section: code, action: task, label: { en: "Large file", ru: "Большой файл" }${patch} }`;

describe('the problems block of the manifest', () => {
  test('a rule is declared in full, switched off and given another severity where the product wants it', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    dependency.cycle: { predicate: dependency-cycle, kind: dependency-cycle, sonar: bug, severity: major, section: code, action: task, enabled: false, label: { en: "Dependency cycle", ru: "Цикл зависимостей" } }
    large-file: ${rule('blocker')}
  thresholds:
    largeFileLines: 900
    hotspotCommits: 20
`);
    expect(read.findings).toEqual([]);
    expect(read.problems).toEqual({
      rules: {
        'dependency.cycle': { predicate: 'dependency-cycle', kind: 'dependency-cycle', sonar: 'bug', severity: 'major', section: 'code', action: 'task', enabled: false, label: { en: 'Dependency cycle', ru: 'Цикл зависимостей' } },
        'large-file': { predicate: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'blocker', section: 'code', action: 'task', label: { en: 'Large file', ru: 'Большой файл' } },
      },
      thresholds: { ...DEFAULT_THRESHOLDS, largeFileLines: 900, hotspotCommits: 20 },
    });
  });

  test('a rule id is the product\'s: a rule of its own with a predicate the engine implements runs, and the engine has no list to refuse it', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    house.style: { predicate: large-file, kind: house-large-file, sonar: code-smell, severity: info, section: code, action: task, label: { en: "A file past the house line", ru: "Файл длиннее домашней границы" } }
`);
    expect(read.findings).toEqual([]);
    expect(read.problems!.rules['house.style']).toMatchObject({ predicate: 'large-file', kind: 'house-large-file', severity: 'info' });
  });

  test('an unknown predicate, an unknown field, a bad severity and a bad threshold are findings with the line', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    no.such-rule: ${rule('major').replace('large-file,', 'no-such-predicate,')}
    large-file: ${rule('enormous', ', colour: red')}
  thresholds:
    largeFileLines: 0
    enormity: 3
  extra: true
`);
    const messages = read.findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('rule "no.such-rule": "predicate" is one the engine implements');
    expect(messages).toContain('rule "large-file": "severity" is one of blocker, critical, major, minor, info');
    expect(messages).toContain('rule "large-file": "colour" is not a field');
    expect(messages).toContain('"largeFileLines" is a positive whole number');
    expect(messages).toContain('"enormity" is not a threshold');
    expect(messages).toContain('"extra" is not a field of "problems"');
    expect(read.findings.every((finding) => finding.line > 0)).toBe(true);
    // What is still sound is kept: one bad rule does not throw the section away.
    expect(read.problems?.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(read.problems?.rules).toEqual({});
  });

  test('a rule missing a field is a finding and is not run; the rest of the section is kept', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    old.format: { enabled: false, severity: major }
`);
    expect(read.problems?.rules).toEqual({});
    const messages = read.findings.map((finding) => finding.message).join('\n');
    for (const field of ['predicate', 'kind', 'sonar', 'section', 'action', 'label']) expect(messages).toContain(`rule "old.format":`);
    expect(read.findings.every((finding) => finding.line > 0)).toBe(true);
  });

  test('the starter manifest writes every rule and the default thresholds, and the engine reads them back', () => {
    const text = STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content;
    const read = parseKinds(text, 'madarch/kinds.yaml', fresh());
    const problems = read.findings.filter((finding) => finding.message.startsWith('"problems') || finding.message.startsWith('rule "'));
    expect(problems).toEqual([]);
    expect(Object.keys(read.problems!.rules).sort()).toEqual(STARTER_PROBLEM_RULES.map((rule) => rule.id).sort());
    expect(read.problems!.thresholds).toEqual(DEFAULT_THRESHOLDS);
    const declared = read.problems!.rules['debt.todo']!;
    expect(declared).toMatchObject({ predicate: 'debt', kind: 'debt-todo', params: { marker: 'TODO' }, enabled: true });
  });

  test('a manifest without problems declares no rule', () => {
    const read = parse('kinds: {}\n');
    expect(read.findings).toEqual([]);
    expect(read.problems).toBeUndefined();
  });
});
