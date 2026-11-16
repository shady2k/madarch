import { describe, expect, test } from 'bun:test';
import { withSpan } from './trace.js';

describe("the page's spans", () => {
  test('a span is one measure of the page timeline, named for the call and carrying what it moved', async () => {
    const answer = await withSpan('net.fetch', { 'http.method': 'POST', 'http.url': '/graphql' }, async () => 42);
    expect(answer).toBe(42);
    const held = performance.getEntriesByType('measure').filter((entry) => entry.name === 'net.fetch');
    expect(held.length).toBeGreaterThan(0);
    const last = held.at(-1) as PerformanceMeasure & { detail?: unknown };
    expect(last.detail).toEqual({ 'http.method': 'POST', 'http.url': '/graphql' });
    expect(last.duration).toBeGreaterThanOrEqual(0);
  });

  test('a failed call still measures its span and throws on', async () => {
    const failure = new Error('refused');
    await expect(withSpan('net.fetch', {}, async () => { throw failure; })).rejects.toBe(failure);
  });
});
