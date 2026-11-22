import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorText } from '../src/model/error-text.js';
import { closeTrace, openTrace, runInTrace, withSpan, withSpanSync } from '../src/obs/trace.js';

test.each([
  ['null prototype', false], ['null prototype', true],
  ['throwing Proxy', false], ['throwing Proxy', true],
] as const)('span wrapper preserves the same thrown %s (sync: %s) and records its text', async (shape, sync) => {
  const thrown: unknown = shape === 'null prototype' ? Object.create(null)
    : new Proxy({}, new Proxy({}, { get() { return () => { throw new Error('trap failed'); }; } }));
  const folder = mkdtempSync(join(tmpdir(), 'madarch-trace-throw-'));
  const traced = openTrace({ store: folder, runId: 'stage-throw' });
  try {
    await runInTrace(traced, async () => {
      let caught: unknown;
      try {
        if (sync) withSpanSync('throw.sync', {}, () => { throw thrown; });
        else await withSpan('throw.async', {}, () => { throw thrown; });
      } catch (error) { caught = error; }
      expect(caught).toBe(thrown);
    });
    closeTrace(traced);
    const spans = readFileSync(traced.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const span = spans.find(span => span.name === (sync ? 'throw.sync' : 'throw.async'));
    expect(span.status).toEqual({ code: 'STATUS_CODE_ERROR', message: errorText(thrown).slice(0, 200) });
  } finally {
    closeTrace(traced);
    rmSync(folder, { recursive: true, force: true });
  }
});
