import { expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureOwner, observed, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
import { collectStartup } from './startup-trace-collector.js';
const fixture = createFixtureOwner();
async function cell(trace: 'off' | 'on') {
 const f = fixture(); const bin = join(f.folder, 'bin');
 unlinkSync(join(bin, 'systemd-run'));
 // No child preload is needed: the fixture home has no products or queued work.
 const { writeFileSync } = await import('node:fs');
 writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
 const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, 'fixtures/startup-enoent-preload.ts'), join(import.meta.dir, '../scripts/madarch.ts'), 'start', '--home', f.home, '--port', '0'], {
  env: { ...f.env, PATH: bin, MADARCH_TRACE: trace, ENOENT_RECEIPTS: f.receipts }, stdout: 'pipe', stderr: 'pipe',
 });
 let pid: number | undefined;
 try {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const state = JSON.parse(readFileSync(join(f.home, '.madarch-daemon.json'), 'utf8')); pid = state.pid;
  const external = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  expect(external).toContain('daemon-serve');
  expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).not.toBe('Z');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  expect(stdout.trim()).toBe(`started: http://127.0.0.1:${state.port} (pid ${pid})`);
  const attempts = observed(f); expect(attempts).toHaveLength(2);
  expect(attempts.map(a => a.command)).toEqual(['systemd-run', 'bun']);
  expect(attempts[0]!.immediatePidUndefined).toBe(true);
  expect(attempts[1]!.pid).toBe(pid);
  saveBoundaryEvidence(`enoent-${trace}`, stderr);
  return { code, signal: child.signalCode, stdout, stderr, pid, records: collectStartup(stderr).records };
 } finally {
  if (pid === undefined && existsSync(join(f.home, '.madarch-daemon.json'))) pid = JSON.parse(readFileSync(join(f.home, '.madarch-daemon.json'), 'utf8')).pid;
  if (pid !== undefined) {
   process.kill(pid, 'SIGTERM');
   await until(() => { try { return /^[ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!); } catch { return true; } }, `fixture daemon ${pid} exited`);
  }
  if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
 }
}
const cells = new Map<string, ReturnType<typeof cell>>();
function savedCell(trace: 'off' | 'on') {
 let result = cells.get(trace);
 if (result === undefined) { result = cell(trace); cells.set(trace, result); }
 return result;
}
for (const trace of ['off', 'on'] as const) {
 test(`delegated ENOENT preserves baseline behavior: ${trace}`, async () => {
  const r = await savedCell(trace);
  // madarch-kern: intentionally preserve exit 1 with a live direct daemon until its product fix.
  expect(r.code, 'unhandled delegated ENOENT must retain baseline exit 1').toBe(1);
  expect(r.signal).toBeNull();
  for (const part of ['Executable not found in $PATH: "systemd-run"', 'ENOENT', 'spawn systemd-run', 'spawnargs:', 'Delegate=yes', 'daemon-serve', 'at spawn (node:child_process:', 'at withSpanSync (', '/src/obs/trace.ts:', 'at start (', '/src/product/daemon.ts:', 'at startChild (', 'at async ensureDaemonUnderLock (', 'at async ensureDaemon (', 'at async startDaemon (', 'at async main (']) expect(r.stderr).toContain(part);
 }, 30_000);
 test(`delegated ENOENT records each actual attempt: ${trace}`, async () => {
  const r = await savedCell(trace);
  if (trace === 'off') { expect(r.records).toEqual([]); return; }
  const spawns = r.records.filter(x => x.phase === 'daemon.spawn');
  expect(spawns.map(x => x.edge)).toEqual(['begin', 'terminal', 'begin', 'terminal']);
  expect(spawns.filter(x => x.edge === 'terminal').map(x => [x.outcome, x.childPid])).toEqual([['error', undefined], ['ok', r.pid]]);
  expect(r.records.filter(x => x.phase === 'daemon.wait' && x.edge === 'terminal').map(x => [x.outcome, x.childPid])).toEqual([['ok', r.pid]]);
 }, 30_000);
}
