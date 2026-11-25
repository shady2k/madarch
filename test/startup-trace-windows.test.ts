import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';
const root = mkdtempSync(join(tmpdir(), 'startup-windows-'));
chmodSync(root, 0o700);
const context = join(root, 'context');
writeFileSync(context, JSON.stringify({ version: 1, collection: randomUUID(), key: randomBytes(32).toString('hex') }), { mode: 0o600 });
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(mode: string, trace = 'on') {
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-windows.ts'), join(root, `${mode}-${trace}`), mode], {
  env: { ...process.env, MADARCH_TRACE: trace, MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 const parsed = collectStartup(stderr);
 const facts = stdout.trim() === '' ? undefined : JSON.parse(stdout.trim());
 const evidence = process.env['STARTUP_FIXTURE_EVIDENCE'] ?? process.env['STARTUP_BOUNDARY_EVIDENCE'];
 if (evidence) {
  mkdirSync(evidence, { recursive: true });
  const lines = stderr.split('\n').filter(line => line.startsWith('{'));
  writeFileSync(join(evidence, `windows-${mode}-${trace}.json`), JSON.stringify({ code, stdout, records: parsed.records, startupLines: lines.length, startupBytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line + '\n'), 0), synchronousStartupWrites: lines.length, facts }));
 }
 return { code, stdout, stderr, facts, ...parsed };
}
test('S2 Windows fake reader distinguishes absent records from corrupt and unreadable records', async () => {
 for (const mode of ['absent', 'corrupt', 'unreadable', 'null-error', 'undefined-error']) {
  const result = await run(mode);
  expect(result.code, result.stderr).toBe(0); expect(result.incomplete).toEqual([]);
  const stop = result.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal');
  expect(stop).toMatchObject({ outcome: mode === 'absent' ? 'absent' : 'unknown', holder: mode === 'absent' ? 'absent' : 'unreadable', command: 'none', probe: 'skipped' });
  expect(stop?.identity).toBe(mode === 'absent' ? undefined : 'unknown');
  expect(stop?.postmasterPid).toBeUndefined(); expect(stop?.postmasterTicks).toBeUndefined();
  expect(result.records.some(r => r.phase === 'cluster.stop.command')).toBe(false);
  expect(result.facts).toMatchObject({ ok: true, launches: 0 });
 }
});
test('S2 Windows command result records exit, signal and launch failure without claiming holder exit', async () => {
 for (const [mode, command, code, signal] of [['exit', 'exit', 0, 'none'], ['exit-error', 'exit', 7, 'none'], ['signal', 'signal', undefined, 'none'], ['kill', 'signal', undefined, 'none'], ['launch-error', 'launch-error', undefined, 'none'], ['timeout', 'timeout', undefined, 'none']] as const) {
  const result = await run(mode);
  expect(result.code, result.stderr).toBe(0); expect(result.incomplete).toEqual([]);
  const stop = result.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal');
  expect(stop).toMatchObject({ outcome: 'unknown', identity: 'unknown', holder: 'unreadable', probe: 'skipped', postmasterPid: 4242, command, signal });
  expect(stop?.postmasterTicks).toBeUndefined(); expect(stop?.code).toBe(code);
  const terminal = result.records.filter(r => r.phase === 'cluster.stop.command' && r.edge === 'terminal');
  expect(terminal).toHaveLength(1); expect(terminal[0]).toMatchObject({ outcome: mode === 'exit' ? 'ok' : 'error', command, signal }); expect(terminal[0]?.code).toBe(code);
  expect(result.facts).toMatchObject({ ok: mode === 'exit', launches: 1, callbacks: 0 });
 }
});
test('S2 Windows command with no recorded PID never fabricates identity', async () => {
 const result = await run('absent-command');
 expect(result.code, result.stderr).toBe(0); expect(result.incomplete).toEqual([]);
 expect(result.facts).toMatchObject({ ok: true, launches: 1, probes: 0 });
 for (const phase of ['cluster.stop', 'cluster.stop.command']) {
  const terminal = result.records.find(r => r.phase === phase && r.edge === 'terminal');
  expect(terminal).toMatchObject({ outcome: phase === 'cluster.stop' ? 'unknown' : 'ok', command: 'exit', code: 0, signal: 'none', probe: 'skipped' });
  // The capture found no record and the look taken before the command found one: the file appeared, so neither a holder
  // nor an identity is claimed, and the stop's outcome stays unknown (ALX-1604, item 3).
  expect(terminal?.holder, `${phase} names no holder of a record that appeared`).toBeUndefined();
  expect(terminal).not.toHaveProperty('holder');
  expect(terminal?.identity).toBeUndefined(); expect(terminal?.postmasterPid).toBeUndefined(); expect(terminal?.postmasterTicks).toBeUndefined();
 }
});
test('S2 Windows callback bypass emits no fictitious command and launch throw closes both pairs', async () => {
 const bypass = await run('bypass');
 expect(bypass.incomplete).toEqual([]); expect(bypass.facts).toMatchObject({ ok: true, launches: 0, callbacks: 1 });
 expect(bypass.records.some(r => r.phase === 'cluster.stop.command')).toBe(false);
 expect(bypass.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal')).toMatchObject({ outcome: 'unknown', identity: 'unknown', command: 'none', holder: 'unreadable' });
 const thrown = await run('throw'); expect(thrown.code).not.toBe(0); expect(thrown.incomplete).toEqual([]);
 expect(thrown.records.find(r => r.phase === 'cluster.stop.command' && r.edge === 'terminal')).toMatchObject({ outcome: 'error', command: 'launch-error' });
 expect(thrown.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal')).toMatchObject({ outcome: 'unknown', identity: 'unknown', command: 'launch-error' });
});
test('S2 Windows fake-reader trace off emits no startup records and keeps callback result', async () => {
 const on = await run('bypass'); const off = await run('bypass', 'off');
 expect(off.code).toBe(on.code); expect(off.stdout).toBe(on.stdout); expect(off.stderr).toBe(''); expect(off.records).toEqual([]);
});
test('S2 Windows stop looks at the pid record once, so a record appearing between two looks is never read as absent', async () => {
 // The fixture answers absent on the first look at the file and present on every look after it: a stop that looks twice
 // names a holder it never observed and runs a stop over a record the capture found absent.
 for (const trace of ['on', 'off']) {
  const result = await run('absent-once', trace);
  expect(result.code, result.stderr).toBe(0); expect(result.incomplete).toEqual([]);
  expect(result.facts, `trace ${trace}`).toEqual({ ok: true, launches: 0, callbacks: 0, probes: 0, existsCalls: 1 });
  expect(result.records.some(r => r.phase === 'cluster.stop.command')).toBe(false);
  if (trace === 'off') { expect(result.records).toEqual([]); continue; }
  const stop = result.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal');
  expect(stop).toMatchObject({ outcome: 'absent', holder: 'absent', command: 'none', probe: 'skipped' });
  expect(stop?.identity).toBeUndefined(); expect(stop?.postmasterPid).toBeUndefined(); expect(stop?.postmasterTicks).toBeUndefined();
 }
});
