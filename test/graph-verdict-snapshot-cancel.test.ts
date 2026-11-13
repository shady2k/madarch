import { expect, test } from 'bun:test';
import type { GraphReader } from '../src/knowledge/graph-read.js';
import { loadGraphSnapshot } from '../src/knowledge/graph-verdict-store.js';

test('an aborted snapshot waits for its current read but never starts another page', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const reader = {
    async list() { reads += 1; await gate; return { rows: [] }; },
    async relationEdges() { throw new Error('an aborted snapshot read an edge page'); },
  } as unknown as GraphReader;
  const snapshot = loadGraphSnapshot(reader, controller.signal);
  const outcome = snapshot.then(() => undefined, (error: unknown) => error);
  controller.abort();
  expect(reads).toBe(1);
  release();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(reads).toBe(1);
});
