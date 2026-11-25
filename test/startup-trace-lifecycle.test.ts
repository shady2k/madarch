import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { createFixtureOwner, launch, observed, port, saveBoundaryEvidence } from './startup-boundary-fixture.js';
import { records, fixtureRun } from './startup-lifecycle-fixture.js';
const fixture = createFixtureOwner();
test('S3 lifecycle lock records real contention, release and filesystem failure without changing stop behavior', async () => {
 const f = fixture(); const lock = join(f.home, '.madarch-daemon.lock');
 writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'external-holder' }));
 const busy = await launch(f, ['stop', '--home', f.home]).result();
 expect(busy.code).toBe(1); expect(records(busy.stderr).find(r => r.phase === 'daemon.lock' && r.edge === 'terminal')?.outcome, 'contested lifecycle lock must be busy').toBe('busy');
 expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('external-holder');
 const { unlinkSync } = await import('node:fs'); unlinkSync(lock);
 const acquired = await launch(f, ['stop', '--home', f.home]).result();
 expect(acquired.code).toBe(0); expect(records(acquired.stderr).find(r => r.phase === 'daemon.lock' && r.edge === 'terminal')?.outcome).toBe('acquired');
 expect(existsSync(lock)).toBe(false);
 const failed = fixture('lifecycle-error'); const error = await launch(failed, ['stop', '--home', failed.home]).result();
 expect(error.code).toBe(1); expect(error.stderr).toContain('another daemon lifecycle operation');
 expect(observed(failed).some(r => r.filesystemError === 'EACCES')).toBe(true);
 expect(records(error.stderr).find(r => r.phase === 'daemon.lock' && r.edge === 'terminal')?.outcome, 'filesystem error is not lock contention').toBe('error');
 saveBoundaryEvidence('lifecycle-locks', busy.stderr + acquired.stderr + error.stderr);
}, 60_000);
test('S3 rejected daemon spawn cannot report success or fabricate a child PID', async () => {
 const f = fixture('spawn-reject'); const p = await port();
 const result = await launch(f, ['start', '--home', f.home, '--port', String(p)]).result();
 expect(result.code).toBe(1);
 const attempts = records(result.stderr).filter(r => r.phase === 'daemon.spawn' && r.edge === 'terminal');
 expect(attempts).toHaveLength(1);
 expect(attempts[0]!.outcome, 'spawn rejection must be error').toBe('error');
 expect(attempts[0]!.childPid).toBeUndefined();
 expect(result.stdout).not.toContain('started:');
 saveBoundaryEvidence('lifecycle-spawn-reject', result.stderr);
}, 60_000);
test('S3 foreign HTTP 200 proof is rejected before a real verified proof', async () => {
 const f = fixture(); const result = await fixtureRun(f, 'proof');
 expect(result.facts).toEqual({ invalid: false, valid: true, requests: 2 });
 expect(result.records.filter(r => r.phase === 'daemon.proof' && r.edge === 'terminal').map(r => r.outcome), 'HTTP status is not daemon proof').toEqual(['error', 'ok']);
 saveBoundaryEvidence('lifecycle-proof', result.stderr);
}, 60_000);
test('S3 bind race keeps failed and retried daemon PIDs distinct from the verified child', async () => {
 const f = fixture();
 try {
  const result = await fixtureRun(f, 'retry'); const started = result.facts.result;
  expect(started.ok).toBe(true); expect(result.facts.picks).toHaveLength(2);
  const spawns = result.records.filter(r => r.phase === 'daemon.spawn' && r.edge === 'terminal');
  expect(spawns).toHaveLength(2);
  expect(spawns.every(r => r.outcome === 'ok' && Number.isInteger(r.childPid)), 'spawn success requires actual child PID').toBe(true);
  expect(spawns[0]!.childPid).not.toBe(spawns[1]!.childPid);
  expect(spawns[1]!.childPid).toBe(started.pid);
  const detached = collectStartup(readFileSync(join(f.home, '.madarch-daemon.log'), 'utf8')).records;
  const childPids = new Set(detached.filter(r => r.phase === 'role.daemon' && r.edge === 'begin').map(r => r.pid));
  expect(childPids.has(spawns[0]!.childPid!)).toBe(true); expect(childPids.has(started.pid)).toBe(true);
  const waits = result.records.filter(r => r.phase === 'daemon.wait' && r.edge === 'terminal');
  expect(waits.map(r => r.outcome)).toEqual(['error', 'ok']); expect(waits[1]!.childPid).toBe(started.pid);
  const proof = result.records.findLast(r => r.phase === 'daemon.proof' && r.edge === 'terminal' && r.outcome === 'ok')!;
  expect(proof.sequence).toBeLessThan(waits[1]!.sequence);
  expect(JSON.parse(readFileSync(join(f.home, '.madarch-daemon.json'), 'utf8')).pid).toBe(started.pid);
  saveBoundaryEvidence('lifecycle-retry', result.stderr);
 } finally { expect((await launch(f, ['stop', '--home', f.home]).result()).code).toBe(0); }
}, 60_000);
