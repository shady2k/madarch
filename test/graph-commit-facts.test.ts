import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { commitFacts } from '../src/graph/records.js';

test('commit facts retain the git clock and parents without reading changed paths', async () => {
  let calls = 0;
  const owner = { transaction: async (_kind: string, work: (tx: unknown) => Promise<unknown>) => await work({ query: async () => {
    calls += 1;
    if (calls === 1) return { rows: [{ commit: 'abc', author_name: 'Ada', author_email: 'ada@example.test', opinions: [{
      id: '1', said_by: 'git@1', author_date: '2026-01-02T03:04:05', author_offset_min: 180,
      commit_date: '2026-01-03T04:05:06', commit_offset_min: -120, subject: 'Change',
    }] }] };
    if (calls === 2) return { rows: [{ hash: 'parent' }] };
    throw new Error('the pin read must not ask for changed paths');
  } }) } as unknown as DatabaseOwner;
  expect(await commitFacts(owner, 'shop', 'abc')).toMatchObject({
    hash: 'abc', parents: ['parent'], author: { name: 'Ada', email: 'ada@example.test' },
    authorDate: '2026-01-02T06:04:05+03:00', commitDate: '2026-01-03T02:05:06-02:00',
    authorOffsetMin: 180, commitOffsetMin: -120, subject: 'Change',
  });
  expect(calls).toBe(2);
});
