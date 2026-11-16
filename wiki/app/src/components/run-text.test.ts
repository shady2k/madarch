import { expect, test } from 'bun:test';
import { causeTextOf, runCauseOf } from './run.js';

test('failure classes retain their order and Unicode case-insensitive keywords', () => {
  expect(runCauseOf('PLUGIN SANDBOX timeout')).toBe('sandbox');
  expect(runCauseOf('CLOſURE tokens')).toBe('plugin');
  expect(runCauseOf('toKens agent')).toBe('cap');
  expect(runCauseOf('ACP dependency')).toBe('agent');
  expect(runCauseOf('wait for a dependency timeout')).toBe('dependency');
  expect(runCauseOf('HEARTBEAT')).toBe('timeout');
  expect(runCauseOf('unclassified')).toBe('unknown');
});

test('failure text keeps the last place, exact whitespace, retry suffix and bound', () => {
  expect(causeTextOf('outer.ts:1: nested inner.json:22: bad; THE ATTEMPT IS RETRIED at noon')).toBe('inner.json:22: bad');
  expect(causeTextOf('outer.ts:1: nested\tinner.json:22: bad')).toBe('\tinner.json:22: bad');
  expect(causeTextOf('a.ts:1: bad; \n the attempt is retried at noon')).toBe('a.ts:1: bad');
  expect(causeTextOf('a.ts:1: bad; the attempt is retried at noon\nnext')).toBe('a.ts:1: bad; the attempt is retried at noon\nnext');
  expect(causeTextOf('bad.json:xx: nope')).toBe('bad.json:xx: nope');
  expect(causeTextOf('x'.repeat(301))).toBe('x'.repeat(300) + '…');
});
