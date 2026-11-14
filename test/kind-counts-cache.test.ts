/** The status poll's kind counts (madarch-64o5.68): a failed read is never remembered. */
import { expect, test } from 'bun:test';
import { KindCountsCache } from '../src/knowledge/kind-counts-cache.js';

test('a count read that failed is not remembered for the revision', async () => {
  const cache = new KindCountsCache();
  await expect(cache.counts(1, async () => { throw new Error('statement timeout'); })).rejects.toThrow('statement timeout');
  const counts = await cache.counts(1, async () => [{ kind: 'task', count: 3 }]);
  expect(counts).toEqual([{ kind: 'task', count: 3 }]);
});
