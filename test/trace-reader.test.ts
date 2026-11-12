import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTraceRun, readTraceRunSummary, readTraceSpans, TraceSpanReader } from '../src/obs/trace-report.js';

const span = (id: string) => JSON.stringify({ traceId: 'run', spanId: id, parentSpanId: 'unfinished-parent', name: 'fill.unit', startTimeUnixNano: '1000000', endTimeUnixNano: '2000000', attributes: [] });

test('a live trace reader follows appends and resets on truncation or replacement', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trace-reader-'));
  mkdirSync(join(folder, 'traces'));
  const file = join(folder, 'traces', 'run.jsonl');
  const reader = new TraceSpanReader();
  try {
    writeFileSync(file, span('first') + '\n');
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    expect(readTraceRun({ store: folder, runId: 'run' }, reader)).toEqual(readTraceRun({ store: folder, runId: 'run' }));
    const full = readTraceRun({ store: folder, runId: 'run' });
    const { spanCount, wallMs, names, agentUsage } = full.report;
    expect(readTraceRunSummary({ store: folder, runId: 'run' }, reader)).toEqual({ ...full, report: { spanCount, wallMs, names, agentUsage } });
    const next = span('second');
    appendFileSync(file, next.slice(0, 20));
    expect(reader.read(file).map((one) => one.spanId)).toEqual(['first']);
    appendFileSync(file, next.slice(20) + '\n');
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    appendFileSync(file, span('third'));
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    appendFileSync(file, '\n');
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    writeFileSync(file, span('short') + '\n');
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    writeFileSync(join(folder, 'replacement'), span('other') + '\n');
    renameSync(join(folder, 'replacement'), file);
    expect(reader.read(file)).toEqual(readTraceSpans(file));
    appendFileSync(file, 'not JSON\n');
    expect(() => reader.read(file)).toThrow(`${file}:2:`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
