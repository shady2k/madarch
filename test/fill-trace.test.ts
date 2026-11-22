import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * A fill that says what it is doing (madarch-8bdc.2.5, item 1): its trace is
 * written beside the store as it happens, one OTLP span per JSON line, and the
 * progress the MCP server's building answer shows is read from that trace.
 * The fixture is a product the test makes itself.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFill } from '../src/fill/run.js';
import { readFillProgress } from '../src/obs/progress.js';
import { readTraceSpans, traceReportOf, TraceSpanReader } from '../src/obs/trace-report.js';
import { traceFiles } from '../src/obs/trace.js';
import { writeProduct } from './fixtures/code-stages/repository.js';
import { createTestDatabaseOwner } from './test-database.js';

describe('a fill writes its trace beside the store', () => {
  test('one OTLP span per line, the log beside it carrying the span ids, and the progress read from it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-fill-trace-'));
    const owner = await createTestDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const store = join(root, 'store');
      await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
      const result = await runFill({ product, database: owner, runId: 'run-fill-trace', store, workers: 2, maxPasses: 100_000, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe('succeeded');

      const traces = traceFiles(store);
      expect(traces.map((one) => one.runId)).toEqual(['run-fill-trace']);
      const file = traces[0]!.file;
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
      expect(lines.length).toBeGreaterThan(4);
      for (const line of lines) {
        const held = JSON.parse(line) as Record<string, unknown>;
        expect(typeof held['traceId']).toBe('string');
        expect(typeof held['spanId']).toBe('string');
        expect(typeof held['name']).toBe('string');
        expect(typeof held['startTimeUnixNano']).toBe('string');
        expect(typeof held['endTimeUnixNano']).toBe('string');
        expect(Array.isArray(held['attributes'])).toBe(true);
      }
      const spans = readTraceSpans(file);
      // Every span states the process's memory at its start and its end, and its own duration is the two times.
      for (const span of spans) {
        expect(typeof span.attributes['process.rss.start']).toBe('number');
        expect(typeof span.attributes['process.rss.end']).toBe('number');
        expect(span.end).toBeGreaterThanOrEqual(span.start);
      }
      // The run, its steps, its units and their phases are all named.
      const names = new Set(spans.map((span) => span.name));
      expect(names.has('fill.run')).toBe(true);
      expect(names.has('fill.step')).toBe(true);
      expect(names.has('fill.unit')).toBe(true);
      for (const unit of spans.filter(span => span.name === 'fill.unit')) {
        expect(typeof unit.attributes['madarch.retriesLeft']).toBe('number');
      }
      expect(names.has('attempt.execute')).toBe(true);
      expect(names.has('db.transaction')).toBe(true);
      expect(names.has('process.git')).toBe(true);

      const progress = readFillProgress(file);
      expect(progress.published).toBeGreaterThan(0);
      expect(progress.failed).toBe(0);
      expect(Object.keys(progress.stages).length).toBeGreaterThan(0);
      expect(progress.pass).not.toBeNull();
      expect(progress.last).not.toBeNull();

      // The log beside the trace says the same run, and each line that has a span carries its trace and span id.
      const logFile = join(store, 'traces', 'run-fill-trace.log.jsonl');
      expect(existsSync(logFile)).toBe(true);
      const records = readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.some((record) => record['message'] === 'fill started')).toBe(true);
      expect(records.some((record) => record['message'] === 'fill ended')).toBe(true);
      for (const record of records) expect(typeof record['level']).toBe('string');

      // The report of the same file: the run is its wall clock, and a name's share is a part of it.
      const report = traceReportOf(spans, file);
      expect(report.wallMs).toBeGreaterThan(0);
      expect(report.names.length).toBeGreaterThan(0);
      expect(report.names[0]!.percent).toBeLessThanOrEqual(100.0001);
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);
});

describe('the progress a status poll reads', () => {
  const span = (id: string, unit: string): string => JSON.stringify({
    traceId: 'trace', spanId: id, name: 'fill.unit',
    startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000000000900',
    attributes: [
      { key: 'madarch.stage', value: { stringValue: 'repository-tree' } },
      { key: 'madarch.outcome', value: { stringValue: 'published' } },
      { key: 'madarch.unit', value: { stringValue: unit } },
    ],
  });

  test('a trace that did not grow answers the fold it answered before, and one that grew is folded again', () => {
    // The poll asks every few seconds, and a store's trace can hold 150 000 spans: folding it per poll cost 4 to 11 ms
    // here and 67 ms on a loaded CI runner, past the poll's own bound (madarch-64o5.81). The reader already keeps the
    // spans it parsed; the fold of them is kept beside it while no span lands.
    const root = mkdtempSync(join(tmpdir(), 'madarch-fill-progress-'));
    try {
      mkdirSync(join(root, 'traces'));
      const file = join(root, 'traces', 'fill-run-progress.jsonl');
      writeFileSync(file, `${span('s1', 'a')}\n`);
      const reader = new TraceSpanReader();
      const first = readFillProgress(file, reader);
      expect(first.spans).toBe(1);
      expect(first.published).toBe(1);
      // The same object, not one built again: the poll on a trace that did not move reads nothing.
      expect(readFillProgress(file, reader)).toBe(first);
      writeFileSync(file, `${span('s2', 'b')}\n`, { flag: 'a' });
      const grown = readFillProgress(file, reader);
      expect(grown).not.toBe(first);
      expect(grown.spans).toBe(2);
      expect(grown.published).toBe(2);
      expect(readFillProgress(file, reader)).toBe(grown);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
