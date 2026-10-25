import { expect, test } from 'bun:test';
import type { HistoryEvidence } from '../src/knowledge/graph-read.js';
import { historyInstant, selectHistory, withHistoryLinks } from '../src/knowledge/temporal.js';

const evidence: HistoryEvidence = {
  entities: [
    ...['a', 'b', 'c'].map((key, index) => ({ key: `code.commit:${key}`, kind: 'code.commit', label: key, scope: '1', nodeIds: [], properties: { onFirstParent: true, effectiveAt: `2026-02-0${index + 1}T00:00:00.000000Z` } })),
    { key: 'code.snapshot:first-release', kind: 'code.snapshot', label: 'first-release', scope: '1', nodeIds: [], properties: { commit: 'a' } },
    { key: 'code.snapshot:unread-release', kind: 'code.snapshot', label: 'unread-release', scope: '1', nodeIds: [], properties: { commit: 'b' } },
  ],
  edges: ['b', 'c'].map((key, index) => ({ from: `code.commit:${key}`, to: `code.commit:${['a', 'b'][index]}`, relation: 'code.parent', properties: { position: 1 } })),
};
const read = (at: string, input = evidence) => selectHistory({ repo: 'sample', at }, input, new Set([1, 3]));

test('dates select the last first-parent effective instant, without extending a point through unread commits', () => {
  expect(read('2026-02-01')).toMatchObject({ coverage: 'covered', commit: 'a', until: '2026-02-02T00:00:00.000000Z' });
  expect(read('2026-02-02T00:00:00Z')).toMatchObject({ coverage: 'unfilled', commit: 'b' });
  expect(read('2026-02-03')).toMatchObject({ coverage: 'covered', commit: 'c', until: null });
  expect(read('2026-01-01').coverage).toBe('before');
});

test('a snapshot name alone never certifies coverage; a commit and its named point select the same tree', () => {
  expect(read('first-release')).toMatchObject({ coverage: 'covered', commit: 'a' });
  expect(read('a')).toMatchObject({ coverage: 'covered', commit: 'a' });
  expect(read('unread-release')).toMatchObject({ coverage: 'unfilled', commit: 'b' });
  expect(read('unknown-release').coverage).toBe('unknown');
  expect(read('a').points).toEqual([{ name: 'first-release', commit: 'a', covered: true }, { name: 'unread-release', commit: 'b', covered: false }]);
});

test('incomplete or cyclic ancestry refuses to certify a date', () => {
  expect(read('2026-02-03', { ...evidence, entities: evidence.entities.filter((one) => one.key !== 'code.commit:b') }).coverage).toBe('unknown');
  expect(read('2026-02-03', { ...evidence, edges: [...evidence.edges, { from: 'code.commit:a', to: 'code.commit:c', relation: 'code.parent', properties: { position: 1 } }] }).coverage).toBe('unknown');
});

test('ISO validation retains microseconds, treats date-only as UTC day-end and rejects invalid calendar values', () => {
  expect(historyInstant('2026-03-01T12:30:00.000001Z')).toBe('2026-03-01T12:30:00.000001Z');
  expect(historyInstant('2026-03-01')).toBe('2026-03-01T23:59:59.999999Z');
  expect(historyInstant('2026-02-30')).toBeUndefined();
  expect(historyInstant('yesterday')).toBeUndefined();
});

test('API links retain selected repository and date without changing external links or product prose', () => {
  const values = { links: [{ href: '/k/e/code.symbol%3Asrc%2Fpart.ts%23Part' }, { href: '/k/src?repo=sample&path=src%2Fpart.ts&line=3' }, { href: '/k/e/domain%3Asales' }, { href: 'https://example.test/source' }] };
  const linked = withHistoryLinks(values, { repo: 'sample', at: 'first-release' });
  expect(linked.links[0]!.href).toContain('at=first-release');
  expect(linked.links[1]!.href).toContain('path=src%2Fpart.ts&line=3&at=first-release');
  expect(linked.links[2]).toEqual(values.links[2]);
  expect(linked.links[3]).toEqual(values.links[3]);
  expect(values.links[0]!.href).not.toContain('at=');
});

test('landmark metadata uses completed publications rather than planned trees and exposes noncontinuous bounds', () => {
  const plan = { head: 'c', snapshots: { first: 'a', last: 'c', 'refs/tags/middle': 'b' }, points: ['a'], limit: 64, omitted: 1,
    diagnostics: [{ ref: 'refs/tags/branch', object: 'side', reason: 'outside first-parent ancestry' }] };
  const result = selectHistory({ repo: 'sample', at: '2026-02-02' }, evidence, new Set([3]), plan);
  expect(result).toMatchObject({ coverage: 'unfilled', commit: 'b', landmarks: { offered: 3, covered: 1, limit: 64, overflow: true, omitted: 1,
    first: '2026-02-03T00:00:00.000000Z', last: '2026-02-03T00:00:00.000000Z', diagnostics: plan.diagnostics } });
  expect(result.points.find((one) => one.name === 'first')!.covered).toBe(false);
  expect(result.points.find((one) => one.name === 'refs/tags/middle')!.covered).toBe(false);
  expect(selectHistory({ repo: 'sample', at: 'last' }, evidence, new Set([3]), plan).coverage).toBe('covered');
});
