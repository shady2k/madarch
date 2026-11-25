import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';

const scratch = mkdtempSync(join(tmpdir(), 'startup-counts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
type Span = { name: string; traceId: string; spanId: string; parentSpanId?: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: { stringValue?: string } }[] };
type Receipt = {
 answer: number;
 counts: {
  startup: { calls: number; bytes: number; bytesPerCall: number[] };
  normal: { calls: number; bytes: number; lines: number; batchLines: number[] };
  otel: { calls: number; bytes: number; lines: number; batchLines: number[] };
  otherAppendCalls: number;
 };
 metrics: Record<string, number>;
 startupText: string;
 spans: Span[];
 logs: { message: string; traceId: string; spanId: string }[];
};
function run(mode: 'timing-off' | 'timing-on' | 'trace-off') {
 const store = join(scratch, mode);
 const env: Record<string, string | undefined> = { ...process.env, MADARCH_TRACE: mode === 'trace-off' ? 'off' : 'on' };
 delete env.MADARCH_STARTUP_CONTEXT;
 delete env.MADARCH_STARTUP_TIMING;
 if (mode !== 'timing-off') env.MADARCH_STARTUP_TIMING = '1';
 const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures', 'startup-counted-trace.ts'), store], { env });
 expect(child.exitCode, child.stderr.toString()).toBe(0);
 const receipt = JSON.parse(child.stdout.toString()) as Receipt;
 expect(receipt.startupText).toBe(child.stderr.toString());
 const parsed = collectStartup(receipt.startupText);
 expect(parsed.incomplete).toEqual([]);
 expect(receipt.answer).toBe(42);
 expect(receipt.counts.otherAppendCalls).toBe(0);
 expect(receipt.counts.startup.calls).toBe(parsed.records.length);
 expect(receipt.counts.startup.bytes).toBe(Buffer.byteLength(child.stderr));
 expect(receipt.counts.startup.bytesPerCall).toEqual(receipt.startupText.split('\n').filter(Boolean).map(line => Buffer.byteLength(line + '\n')));
 for (const [kind, file] of [['normal', 'counted-startup.log.jsonl'], ['otel', 'counted-startup.jsonl']] as const) {
  const contents = readFileSync(join(store, 'traces', file), 'utf8');
  expect(receipt.counts[kind].bytes).toBe(Buffer.byteLength(contents));
  expect(receipt.counts[kind].lines).toBe(contents.split('\n').filter(Boolean).length);
  expect(receipt.counts[kind].batchLines.reduce((sum, n) => sum + n, 0)).toBe(receipt.counts[kind].lines);
 }
 for (const metric of Object.values(receipt.metrics)) { expect(Number.isFinite(metric)).toBe(true); expect(metric).toBeGreaterThanOrEqual(0); }
 const destination = process.env.STARTUP_FIXTURE_EVIDENCE;
 if (destination !== undefined) {
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, `${mode}.json`), JSON.stringify({ ...receipt, incomplete: parsed.incomplete }, null, 2), { mode: 0o600 });
 }
 return { ...receipt, records: parsed.records };
}

test('startup timing counts actual synchronous writes separately from logs and OTEL batches', () => {
 const off = run('timing-off');
 const on = run('timing-on');
 expect(off.records).toEqual([]);
 expect(off.counts.startup).toEqual({ calls: 0, bytes: 0, bytesPerCall: [] });
 expect(on.counts.startup.calls).toBe(4);
 expect(on.counts.startup.bytes).toBeGreaterThan(0);
 const fixtureNames = (spans: Span[]) => spans.filter(span => span.name.startsWith('fixture.')).map(span => span.name).sort();
 expect(fixtureNames(off.spans)).toEqual(['fixture.nested', 'fixture.work']);
 expect(fixtureNames(on.spans)).toEqual(['fixture.nested', 'fixture.prepare', 'fixture.startup', 'fixture.work']);
 expect(off.spans.filter(span => !span.name.startsWith('fixture.'))).toEqual([]);
 const platformReads = on.spans.filter(span => !span.name.startsWith('fixture.'));
 if (process.platform === 'linux') {
  // Startup clock/domain discovery reads /proc/self once, then each edge reads its process identity.
  expect(platformReads).toHaveLength(5);
  const paths = platformReads.map(span => {
   expect(span.name).toBe('fs.read');
   return span.attributes.find(attribute => attribute.key === 'file.path')?.value.stringValue;
  });
  expect(paths.filter(path => path === '/proc/self')).toHaveLength(1);
  expect(paths.filter(path => path === `/proc/${on.records[0]!.pid}/stat`)).toHaveLength(4);
 } else expect(platformReads).toEqual([]);
 for (const result of [off, on]) {
  expect(result.counts.normal.calls).toBe(2);
  expect(result.counts.normal.lines).toBe(2);
  expect(result.counts.normal.batchLines).toEqual([1, 1]);
  expect(result.counts.otel.lines).toBe(result.spans.length);
  // Flush timers may fire while a slow host runs the fixture. Count batches, not an assumed timer schedule.
  expect(result.counts.otel.calls).toBeGreaterThan(0);
  expect(result.counts.otel.calls).toBeLessThanOrEqual(result.spans.length);
  for (const span of result.spans) expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBeGreaterThanOrEqual(0n);
  for (const line of result.logs) {
   const matches = result.spans.filter(span => span.traceId === line.traceId && span.spanId === line.spanId);
   expect(matches).toHaveLength(1);
   expect(matches[0]!.name).toBe(line.message === 'fixture outer work' ? 'fixture.work' : 'fixture.nested');
  }
  const outer = result.spans.find(span => span.name === 'fixture.work')!;
  const nested = result.spans.find(span => span.name === 'fixture.nested')!;
  expect(nested.parentSpanId).toBe(outer.spanId);
  expect(nested.traceId).toBe(outer.traceId);
  expect(BigInt(nested.startTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(outer.startTimeUnixNano));
  expect(BigInt(nested.endTimeUnixNano)).toBeLessThanOrEqual(BigInt(outer.endTimeUnixNano));
  // These are overlapping windows. Their durations are deliberately never summed.
 }
 for (const phase of ['fixture.startup', 'fixture.prepare']) {
  const edges = on.records.filter(record => record.phase === phase);
  expect(edges).toHaveLength(2);
  const [begin, terminal] = edges;
  expect(begin!.edge).toBe('begin');
  expect(terminal).toMatchObject({ edge: 'terminal', outcome: 'ok', pair: begin!.pair, traceId: begin!.traceId, spanId: begin!.spanId });
  expect(BigInt(terminal!.ns) - BigInt(begin!.ns)).toBeGreaterThanOrEqual(0n);
  const spans = on.spans.filter(span => span.name === phase && span.traceId === begin!.traceId && span.spanId === begin!.spanId);
  expect(spans).toHaveLength(1);
  expect(spans[0]!.attributes).toContainEqual({ key: 'startup.pair', value: { stringValue: begin!.pair } });
 }
 const disabled = run('trace-off');
 expect(disabled.records).toEqual([]);
 expect(disabled.spans).toEqual([]);
 expect(disabled.logs).toEqual([]);
 expect(disabled.counts.startup.calls).toBe(0);
 expect(disabled.counts.normal.calls).toBe(0);
 expect(disabled.counts.otel.calls).toBe(0);
}, 30_000);

test('counted real edges retain incomplete-stream diagnostics', () => {
 const { records } = run('timing-on');
 const lines = records.map(record => JSON.stringify(record));
 expect(collectStartup(lines[0] + '\n').incomplete).toContain('unmatched begin');
 expect(collectStartup(lines.slice(1).join('\n') + '\n').incomplete).toContain('missing begin');
 expect(collectStartup(lines.slice(1).join('\n') + '\n').incomplete).toContain('sequence gap');
 expect(collectStartup(lines.join('\n')).incomplete).toContain('partial line');
 expect(collectStartup(lines.join('\n') + '\n', ['fixture', 'api']).incomplete).toContain('missing child stream: api');
}, 30_000);
