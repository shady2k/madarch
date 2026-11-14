/** The status poll's kind counts (madarch-64o5.68): a failed read is never remembered. */
import { expect, test } from 'bun:test';
import { KindCountsCache } from '../src/knowledge/kind-counts-cache.js';

test('a count read that failed is not remembered for the revision', async () => {
  const cache = new KindCountsCache();
  await expect(cache.counts(1, async () => { throw new Error('statement timeout'); })).rejects.toThrow('statement timeout');
  const counts = await cache.counts(1, async () => [{ kind: 'task', count: 3 }]);
  expect(counts).toEqual([{ kind: 'task', count: 3 }]);
});

test('a late answer for an older revision does not replace a newer revision', async () => {
  const cache = new KindCountsCache();
  let release: ((counts: { kind: string; count: number }[]) => void) | undefined;
  const older = cache.counts(1, () => new Promise((resolve) => { release = resolve; }));
  await cache.counts(2, async () => [{ kind: 'task', count: 7 }]);
  release?.([{ kind: 'task', count: 3 }]);
  expect(await older).toEqual([{ kind: 'task', count: 3 }]);
  expect(await cache.counts(2, async () => { throw new Error('a newer revision is already cached'); })).toEqual([{ kind: 'task', count: 7 }]);
});
