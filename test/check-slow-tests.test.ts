import { describe, expect, test } from 'bun:test';
import { slowFindings, type Timings } from '../scripts/check-slow-tests.js';
import type { SlowList } from '../scripts/run-tests.js';

const all = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];

function list(files: SlowList['files']): SlowList {
  return { version: 1, measuredOn: '2026-11-18', files };
}

const timings: Timings = { source: '.github/workflows/test-timings.json', files: { 'test/a.test.ts': 31_000, 'test/b.test.ts': 2_000 } };

describe('the slow-list check', () => {
  test('names a measured file over 30 s that the slow list does not carry', () => {
    const findings = slowFindings(all, list([{ path: 'test/c.test.ts', seconds: 31, reason: 'green-slow' }]), timings);
    expect(findings).toEqual([
      '.github/workflows/test-timings.json: test/a.test.ts took 31000 ms, more than 30 s, and is not in test/slow-files.json',
    ]);
  });

  test('accepts a measured file over 30 s when the slow list carries it', () => {
    const findings = slowFindings(all, list([{ path: 'test/a.test.ts', seconds: 31, reason: 'green-slow' }]), timings);
    expect(findings).toEqual([]);
  });

  test('names a slow entry that does not reach the criterion', () => {
    const findings = slowFindings(all, list([{ path: 'test/c.test.ts', seconds: 20, reason: 'green-slow' }]), timings);
    expect(findings).toContain('test/slow-files.json: test/c.test.ts is listed with 20 s; the slow criterion is more than 30 s');
  });

  test('names a red entry with no owner task', () => {
    const findings = slowFindings(all, list([{ path: 'test/a.test.ts', seconds: 31, reason: 'waits-timeout', result: 'red' }]), timings);
    expect(findings).toContain('test/slow-files.json: test/a.test.ts is red and names no owner task');
  });
});
