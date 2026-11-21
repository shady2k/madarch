import { expect, test } from 'bun:test';
import { scanMentions } from '../src/graph/mentions';

const perf = process.env['MADARCH_SKIP_PERF'] === '1' ? test.skip : test;
perf('plain catalogue content scans within 50 milliseconds', () => {
  const text = 'ordinary catalogue text '.repeat(60_000);
  const start = performance.now();
  expect(scanMentions(text, '/snapshot')).toEqual([]);
  expect(performance.now() - start).toBeLessThan(50);
});
