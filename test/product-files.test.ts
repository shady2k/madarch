import { expect, test } from 'bun:test';
import { snapshotFiles } from '../src/knowledge/product-files.js';

test('snapshot files read every requested blob once with bounded parallel reads', async () => {
  const paths = Array.from({ length: 19 }, (_, at) => `file-${at}.txt`);
  const read: string[] = [];
  let active = 0;
  let peak = 0;
  const files = await snapshotFiles({
    entries: () => [...paths.map((path) => ({ path, mode: '100644', form: 'blob' })), { path: 'linked', mode: '120000', form: 'blob' }],
    readText: async (path) => {
      read.push(path); active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      return `content:${path}`;
    },
  });
  await files.ensure([...paths, paths[0]!, 'missing', 'linked']);
  await files.ensure(paths);
  expect(read.sort()).toEqual([...paths].sort());
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  for (const path of paths) expect(files.text(path)).toBe(`content:${path}`);
  expect(files.text('missing')).toBeUndefined();
  expect(files.text('linked')).toBeUndefined();
});
