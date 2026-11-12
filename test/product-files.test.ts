import { expect, test } from 'bun:test';
import { snapshotFiles } from '../src/plugin/product-files.js';

test('snapshot files batch only new blobs in code point order and hold every result', async () => {
  const calls: (readonly string[])[] = [];
  const files = await snapshotFiles({
    entries: () => [
      ...['z.json', 'a.json', '😀.json', '\uE000.json'].map((path) => ({ path, mode: '100644', form: 'blob' })),
      { path: 'sub', mode: '160000', form: 'commit' },
      { path: 'link', mode: '120000', form: 'link' },
    ],
    readTexts: async (paths) => { calls.push(paths); return paths.map((path) => `bytes:${path}`); },
  });
  await files.ensure(['😀.json', 'z.json', 'a.json', '\uE000.json', 'sub', 'link', 'missing', 'z.json']);
  expect(calls).toEqual([['a.json', 'z.json', '😀.json', '\uE000.json']]);
  for (const path of calls[0]!) expect(files.text(path)).toBe(`bytes:${path}`);
  for (const path of ['sub', 'link', 'missing']) expect(files.text(path)).toBeUndefined();
  await files.ensure(['a.json']);
  expect(calls).toHaveLength(1);
});

test('snapshot files refuse an incomplete batch instead of caching missing text', async () => {
  const files = await snapshotFiles({
    entries: () => [{ path: 'nested/declaration.json', mode: '100644', form: 'blob' }],
    readTexts: async () => [],
  });
  await expect(files.ensure(['nested/declaration.json'])).rejects.toThrow('nested/declaration.json');
  expect(() => files.text('nested/declaration.json')).toThrow('not read');
});
