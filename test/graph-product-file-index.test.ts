import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { listFiles, productFileIndex } from '../src/graph/records.js';

test('product file inventory keeps agreement and contested values without requiring full opinions', async () => {
  const owner = { transaction: async (_kind: string, work: (tx: unknown) => Promise<unknown>) => await work({ query: async () => ({ rows: [
    { path: 'a.ts', opinions: [{ mode: '100644', bytes: '20', form: 'text' }, { mode: '100644', bytes: '20', form: 'text' }] },
    { path: 'b.ts', opinions: [{ mode: '100644', bytes: '30', form: 'text' }, { mode: '120000', bytes: '40', form: 'binary' }] },
    { path: 'empty', opinions: null },
  ] }) }) } as unknown as DatabaseOwner;
  expect(await productFileIndex(owner, 'shop')).toEqual([
    { path: 'a.ts', mode: '100644', bytes: 20, form: 'text' },
    { path: 'b.ts', mode: null, bytes: null, form: null },
    { path: 'empty', mode: null, bytes: null, form: null },
  ]);
});


test('map projection preserves contested counts and every language claim with its source', async () => {
  let call = 0;
  const owner = { transaction: async (_kind: string, work: (tx: unknown) => Promise<unknown>) => await work({ query: async () => {
    call += 1;
    return call === 1 ? { rows: [{ node_id: '1' }] } : { rows: [{ path: 'a.ts', opinions: [
      { said_by: 'tree@1', bytes: '20', lines: '2' },
      { said_by: 'one@1', language: 'TypeScript' },
      { said_by: 'two@1', language: 'JavaScript', lines: '3' },
    ] }] };
  } }) } as unknown as DatabaseOwner;
  const page = await listFiles(owner, { repository: 'shop', limit: 10, projection: 'map' });
  expect(page.next).toBeNull();
  expect(page.rows[0]).toMatchObject({ path: 'a.ts', bytes: 20, lines: null, language: null });
  expect(page.rows[0]!.opinions!.filter((opinion) => opinion.values['language'] !== undefined).map((opinion) => [opinion.saidBy, opinion.values['language']]))
    .toEqual([['one@1', 'TypeScript'], ['two@1', 'JavaScript']]);
});
