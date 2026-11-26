import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { KindCountsCache } from '../src/knowledge/kind-counts-cache.js';
import { parseKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { closeTrace, openTrace, runInTrace } from '../src/obs/trace.js';

// Isolate the status count boundary: store opening and graph reads have their own integration tests.
function product(): { kindCounts(manifest: KindsManifest, seq: number): Promise<{ kind: string; count: number }[]> } {
  return Object.assign(Object.create(KnowledgeProduct.prototype), {
    open: async () => ({}), validAt: () => new Date().toISOString(), kindCountsCache: new KindCountsCache(),
  });
}

test('status count telemetry distinguishes cached answers and records a swallowed read failure', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'kind-count-trace-'));
  const run = openTrace({ store: folder, runId: 'kind-counts', console: false });
  const read = spyOn(GraphReader.prototype, 'kindCounts');
  const failure = new Error('count read unavailable');
  try {
    const manifest = parseKinds('{}', '/fixture/madarch/catalog.yaml', '/fixture');
    const subject = product();
    read.mockRejectedValueOnce(failure).mockResolvedValue([{ kind: 'example', count: 3 }]);
    await runInTrace(run, async () => {
      await subject.kindCounts(manifest, 1);
      await subject.kindCounts(manifest, 1);
      await subject.kindCounts(manifest, 1);
    });
    closeTrace(run);
    const spans = readFileSync(run.file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(span => span.name === 'knowledge.kindCounts');
    const attrs = spans.map(span => Object.fromEntries(span.attributes.map((attr: { key: string; value: Record<string, unknown> }) => [attr.key, Object.values(attr.value)[0]])));
    expect(attrs).toHaveLength(3);
    expect(attrs.map(row => row['knowledge.cache.hit'])).toEqual([false, false, true]);
    expect(attrs[0]!['error.message']).toBe(failure.message);
    expect(attrs[0]!['error.stack']).toBe(failure.stack);
    expect(attrs[1]!['knowledge.seq']).toBe('1');
    expect(JSON.parse(attrs[1]!['knowledge.counts'] as string)).toBeArray();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    closeTrace(run);
    rmSync(folder, { recursive: true, force: true });
  }
});
