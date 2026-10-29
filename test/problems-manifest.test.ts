/**
 * The `problems:` block of a product's manifest (madarch-m38l.19): a product
 * switches a rule off or gives it another severity, and sets the thresholds a
 * rule reads. The engine never keeps these as constants of its own.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { DEFAULT_THRESHOLDS } from '../src/problems/types.js';
import { PROBLEM_RULES } from '../src/problems/rules.js';

const fresh = (): string => mkdtempSync(join(tmpdir(), 'madarch-problems-manifest-'));
const parse = (text: string) => parseKinds(text, 'madarch/kinds.yaml', fresh());

describe('the problems block of the manifest', () => {
  test('a rule is switched off and given another severity, and thresholds are set where the product wants them', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    dependency.cycle: { enabled: false }
    large-file: { severity: blocker }
  thresholds:
    largeFileLines: 900
    hotspotCommits: 20
`);
    expect(read.findings).toEqual([]);
    expect(read.problems).toEqual({
      rules: { 'dependency.cycle': { enabled: false }, 'large-file': { severity: 'blocker' } },
      thresholds: { ...DEFAULT_THRESHOLDS, largeFileLines: 900, hotspotCommits: 20 },
    });
  });

  test('an unknown rule, an unknown field, a bad severity and a bad threshold are findings with the line', () => {
    const read = parse(`kinds: {}
problems:
  rules:
    no.such-rule: { enabled: false }
    large-file: { severity: enormous, colour: red }
  thresholds:
    largeFileLines: 0
    enormity: 3
  extra: true
`);
    const messages = read.findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('"problems.rules" names the rule "no.such-rule"');
    expect(messages).toContain('rule "large-file": "severity" is one of blocker, critical, major, minor, info');
    expect(messages).toContain('rule "large-file": "colour" is not a field');
    expect(messages).toContain('"largeFileLines" is a positive whole number');
    expect(messages).toContain('"enormity" is not a threshold');
    expect(messages).toContain('"extra" is not a field of "problems"');
    expect(read.findings.every((finding) => finding.line > 0)).toBe(true);
    // What is still sound is kept: one bad rule does not throw the section away.
    expect(read.problems?.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  test('the starter manifest writes every rule and the default thresholds, and the engine reads them back', () => {
    const text = STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content;
    const read = parseKinds(text, 'madarch/kinds.yaml', fresh());
    const problems = read.findings.filter((finding) => finding.message.startsWith('"problems') || finding.message.startsWith('rule "'));
    expect(problems).toEqual([]);
    expect(Object.keys(read.problems!.rules).sort()).toEqual(PROBLEM_RULES.map((rule) => rule.id).sort());
    expect(read.problems!.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  test('a manifest without problems keeps the engine defaults', () => {
    const read = parse('kinds: {}\n');
    expect(read.findings).toEqual([]);
    expect(read.problems).toBeUndefined();
  });
});
