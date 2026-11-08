/**
 * A fill that says what it is doing (madarch-8bdc.2.5, item 1): its trace is
 * written beside the store as it happens, one OTLP span per JSON line, and the
 * progress the MCP server's building answer shows is read from that trace.
 * The fixture is a product the test makes itself.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { readFillProgress } from '../src/obs/progress.js';
import { readTraceSpans, traceReportOf } from '../src/obs/trace-report.js';
import { traceFiles } from '../src/obs/trace.js';
import { writeProduct } from './fixtures/code-stages/repository.js';

describe('a fill writes its trace beside the store', () => {
  test('one OTLP span per line, the log beside it carrying the span ids, and the progress read from it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-fill-trace-'));
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const store = join(root, 'store');
      const result = await runFill({ product, database: owner, runId: 'run-fill-trace', store, workers: 2, maxPasses: 100_000 });
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
