import { expect, test } from 'bun:test';
import { problemFingerprint } from '../src/loop/problem-task.js';
import { canonicalJsonDigest } from '../src/model/canonical.js';

test('a finding fingerprint covers its diagnostic fields and actual about UID', () => {
  const diagnostic = { rule: 'rule', reason: 'reason', file: 'source.ts', line: 12 };
  const aboutUid = '019a0000-0000-7000-8000-000000000001';
  const fingerprint = problemFingerprint(diagnostic, aboutUid);
  expect(fingerprint).toBe(canonicalJsonDigest({ ...diagnostic, aboutUid }));
  for (const change of [{ rule: 'other' }, { reason: 'other' }, { file: 'other.ts' }, { line: 13 }]) expect(problemFingerprint({ ...diagnostic, ...change }, aboutUid)).not.toBe(fingerprint);
  expect(problemFingerprint(diagnostic, '019a0000-0000-7000-8000-000000000002')).not.toBe(fingerprint);
  expect(problemFingerprint(diagnostic, null)).not.toBe(fingerprint);
});
