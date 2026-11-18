import { describe, expect, test } from 'bun:test';
import { slowFindings, type Timings } from '../scripts/check-slow-tests.js';
import type { SlowList } from '../scripts/run-tests.js';

const all = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];

function list(files: SlowList['files']): SlowList {
  return { version: 1, measuredOn: '2026-11-18', files: files.map((entry) => ({owner:'madarch-x9a7',defect:'test defect',replacement:'replacement assertion',exit:'rewritten file',...entry})) };
}

const timings: Timings = { source: '.github/workflows/single-file-timings.json', files: { 'test/a.test.ts': 31_000, 'test/b.test.ts': 2_000, 'test/c.test.ts': 31_000 } };

describe('the slow-list check', () => {
  test('names a measured file over 30 s that the slow list does not carry', () => {
    const findings = slowFindings(all, list([{ path: 'test/c.test.ts', seconds: 31, reason: 'green-slow' }]), timings);
    expect(findings).toEqual([
      '.github/workflows/single-file-timings.json: test/a.test.ts took 31000 ms, more than 30 s, and is not in test/slow-files.json',
    ]);
  });

  test('accepts a measured file over 30 s when the slow list carries it', () => {
    const findings = slowFindings(all, list([{ path: 'test/a.test.ts', seconds: 31, reason: 'green-slow' }]), { ...timings, files: { ...timings.files, 'test/c.test.ts': 2_000 } });
    expect(findings).toEqual([]);
  });

  test('names a slow entry that does not reach the criterion', () => {
    const findings = slowFindings(all, list([{ path: 'test/c.test.ts', seconds: 20, reason: 'green-slow' }]), timings);
    expect(findings).toContain('test/slow-files.json: test/c.test.ts is listed with 20 s; the slow criterion is more than 30 s');
  });

  test('rejects a slow entry when its committed measurement understates the evidence', () => {
    const findings = slowFindings(all, list([{ path: 'test/a.test.ts', seconds: 31, reason: 'green-slow', result: 'green' }]), {source:'timings',files:{'test/a.test.ts':6200}});
    expect(findings.some((finding) => finding.includes('disagrees with the committed measurement'))).toBe(true);
  });
  test('flags new single-file measurements missing from the committed baseline', () => {
    const findings = slowFindings(all, list([]), {source:'single-file evidence',files:{'test/a.test.ts':35000}});
    expect(findings.some((finding) => finding.includes('no committed measurement'))).toBe(true);
    const growth = slowFindings(all, list([]), {source:'new single-file evidence',files:{'test/c.test.ts':35000}}, {source:'base timings',files:{'test/a.test.ts':1000}});
    expect(growth.some((finding) => finding.includes('new test/c.test.ts exceeds 30 s'))).toBe(true);
  });
  test('names a red entry with no owner task', () => {
    const findings = slowFindings(all, list([{ path: 'test/a.test.ts', seconds: 31, reason: 'waits-timeout', result: 'red' }]), timings);
    expect(findings.some((finding) => finding.includes('test/a.test.ts') && finding.includes('tracked owner'))).toBe(false);
  });
});
