import { mock } from 'bun:test';
import * as fs from 'node:fs';
const records: any[] = []; const write = fs.writeSync;
mock.module('node:fs', () => ({ ...fs, writeSync: (...args: any[]) => {
 if (args[0] === 2 && typeof args[1] === 'string') { try { const r = JSON.parse(args[1]); if (r.version === 1 && r.phase) records.push(r); } catch {} }
 return (write as any)(...args);
} }));
const { startupEntry, startupBegin } = await import('../../src/obs/log.js');
const { withSpan, openTrace, runInTrace, closeTrace } = await import('../../src/obs/trace.js');
startupEntry('fixture');
await withSpan('foreign', {}, async () => { const terminal = startupBegin('fixture.foreign'); terminal('ok'); });
const outside = startupBegin('fixture.cross');
const run = openTrace({ store: process.argv[2]!, runId: 'fixture', console: false });
try { await runInTrace(run, async () => {
 await withSpan('parent', {}, async () => {
  outside('ok'); const terminal = startupBegin('fixture.owned');
  await withSpan('nested', {}, () => terminal('ok'));
 });
}); } finally { closeTrace(run); }
console.log(JSON.stringify(records));
