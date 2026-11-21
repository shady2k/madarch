import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../src/obs/log.js';
import { closeTrace, openTrace, runInTrace, withSpan, withSpanSync } from '../src/obs/trace.js';

const lines = (file: string): Record<string, any>[] => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('opt-in output mirrors live spans and unit reasons, and closes with run query totals', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trace-output-'));
  const previous = process.env['MADARCH_TRACE_OUTPUT'];
  process.env['MADARCH_TRACE_OUTPUT'] = join(folder, 'evidence');
  const run = openTrace({ store: join(folder, 'store'), runId: 'fill-output' });
  try {
    await runInTrace(run, async () => await withSpan('fill.unit', { 'madarch.unit': 'unit-a' }, async () => {
      withSpanSync('db.statement', { 'db.operation': 'SELECT' }, () => {});
      withSpanSync('db.statement', { 'db.operation': 'INSERT' }, () => {});
      log.warn('unit refused', { reason: 'missing dependency', unit: 'unit-a' });
    }));
    await Bun.sleep(40);
    const traceFile = join(folder, 'evidence', 'fill-output.jsonl');
    const logFile = join(folder, 'evidence', 'fill-output.log.jsonl');
    const live = lines(traceFile);
    const unit = live.find(span => span.name === 'fill.unit')!;
    expect(live.filter(span => span.name === 'db.statement')).toHaveLength(2);
    expect(live.filter(span => span.name === 'db.statement').every(span => span.parentSpanId === unit.spanId)).toBe(true);
    expect(lines(logFile)[0]).toMatchObject({ message: 'unit refused', reason: 'missing dependency', spanId: unit.spanId });
    closeTrace(run);
    expect(readFileSync(traceFile, 'utf8')).toBe(readFileSync(run.file, 'utf8'));
    expect(readFileSync(logFile, 'utf8')).toBe(readFileSync(run.logFile, 'utf8'));
    const summary = lines(traceFile).find(span => span.name === 'trace.summary')!;
    const attributes = Object.fromEntries(summary.attributes.map((attribute: any) => [attribute.key, attribute.value]));
    expect(attributes['db.statement.count']).toEqual({ intValue: '2' });
    expect(Number(attributes['madarch.elapsed_ms'].doubleValue ?? attributes['madarch.elapsed_ms'].intValue)).toBeGreaterThanOrEqual(0);
  } finally {
    closeTrace(run);
    if (previous === undefined) delete process.env['MADARCH_TRACE_OUTPUT']; else process.env['MADARCH_TRACE_OUTPUT'] = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an unset or unwritable output keeps the store trace and log working', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trace-output-local-'));
  const previous = process.env['MADARCH_TRACE_OUTPUT'];
  try {
    for (const output of [undefined, join(folder, 'not-a-directory')]) {
      if (output === undefined) delete process.env['MADARCH_TRACE_OUTPUT'];
      else { writeFileSync(output, 'file'); process.env['MADARCH_TRACE_OUTPUT'] = output; }
      const run = openTrace({ store: join(folder, 'store'), runId: output === undefined ? 'local' : 'unwritable' });
      await runInTrace(run, async () => withSpanSync('db.statement', {}, () => log.info('still running')));
      closeTrace(run);
      closeTrace(run);
      expect(lines(run.file).filter(span => span.name === 'trace.summary')).toHaveLength(1);
      expect(lines(run.file).some(span => span.name === 'db.statement')).toBe(true);
      expect(lines(run.logFile)[0]).toMatchObject({ message: 'still running' });
      expect(run.outputFile).toBeUndefined();
    }
    expect(existsSync(join(folder, 'evidence'))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env['MADARCH_TRACE_OUTPUT']; else process.env['MADARCH_TRACE_OUTPUT'] = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
