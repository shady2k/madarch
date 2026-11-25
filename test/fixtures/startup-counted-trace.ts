import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';

// Install the forwarding counters before either product module binds its fs imports.
const actual = { ...fs };
const startupWrites: { bytes: number; text: string }[] = [];
const appends: { file: string; bytes: number; lines: number }[] = [];
mock.module('node:fs', () => ({
 ...actual,
 writeSync: (...args: Parameters<typeof fs.writeSync>) => {
  if (args[0] === 2 && typeof args[1] === 'string') {
   const text = args[1];
   startupWrites.push({ bytes: Buffer.byteLength(text), text });
  }
  return Reflect.apply(actual.writeSync, actual, args);
 },
 appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
  const text = typeof args[1] === 'string' ? args[1] : Buffer.from(args[1]).toString('utf8');
  appends.push({ file: String(args[0]), bytes: Buffer.byteLength(text), lines: text.split('\n').length - 1 });
  return Reflect.apply(actual.appendFileSync, actual, args);
 },
}));
const { openTrace, runInTrace, withSpan, closeTrace } = await import('../../src/obs/trace.js');
const logging = await import('../../src/obs/log.js');
const { log, startupEntry, startupBegin } = logging;
const store = process.argv[2]!;
// The exact-base overlay lacks preparation scope APIs. Keep its workload runnable so phase-span assertions,
// not an import/setup error, expose the missing product instrumentation. Candidate runs use both real APIs.
const withStartupPreparation = (logging as Partial<typeof logging>).withStartupPreparation ?? (<T>(_dataDir: string, work: () => T): T => work());
const startupPreparation = (logging as Partial<typeof logging>).startupPreparation ?? (() => join(store, 'pgdata'));
const before = { elapsed: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage() };
startupEntry('fixture');
const run = openTrace({ store, runId: 'counted-startup', console: false });
let answer = 0;
try {
 await runInTrace(run, () => withSpan('fixture.work', {}, async () => {
  const terminal = startupBegin('fixture.startup');
  try {
   log.info('fixture outer work', { step: 1 });
   await withSpan('fixture.nested', {}, () => withStartupPreparation(join(store, 'pgdata'), () => {
    if (startupPreparation() !== join(store, 'pgdata')) throw new Error('preparation scope missing');
    const prepared = startupBegin('fixture.prepare', startupPreparation());
    try { log.info('fixture nested work', { step: 2 }); answer = 42; }
    finally { prepared('ok'); }
   }));
  } finally { terminal('ok'); }
 }));
} finally { closeTrace(run); }
const cpu = process.cpuUsage(before.cpu);
const after = process.memoryUsage();
const readLines = (file: string): any[] => actual.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const normal = appends.filter(call => call.file === run.logFile);
const otel = appends.filter(call => call.file === run.file);
const summarize = (calls: typeof appends) => ({ calls: calls.length, bytes: calls.reduce((sum, call) => sum + call.bytes, 0), lines: calls.reduce((sum, call) => sum + call.lines, 0), batchLines: calls.map(call => call.lines) });
console.log(JSON.stringify({
 answer,
 counts: {
  startup: { calls: startupWrites.length, bytes: startupWrites.reduce((sum, call) => sum + call.bytes, 0), bytesPerCall: startupWrites.map(call => call.bytes) },
  normal: summarize(normal), otel: summarize(otel), otherAppendCalls: appends.length - normal.length - otel.length,
 },
 metrics: { elapsedMs: performance.now() - before.elapsed, cpuUserUs: cpu.user, cpuSystemUs: cpu.system, rssBefore: before.memory.rss, rssAfter: after.rss, heapBefore: before.memory.heapUsed, heapAfter: after.heapUsed },
 startupText: startupWrites.map(call => call.text).join(''),
 spans: readLines(run.file), logs: readLines(run.logFile),
}));
