import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureOwner, observed, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
import { collectStartup } from './startup-trace-collector.js';
const fixture = createFixtureOwner();
const preload = join(import.meta.dir, 'fixtures/startup-correction-launch-preload.ts');
async function run(f: ReturnType<ReturnType<typeof createFixtureOwner>>, command: string) {
 const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../scripts/madarch.ts'), command, '--home', f.home, ...(command === 'start' ? ['--port', '0'] : [])], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 return { code, stdout, stderr, records: collectStartup(stderr).records };
}
test('lifecycle acquisition records the successful retry after a non-EEXIST write failure', async () => {
 const f = fixture('lifecycle-retry');
 writeFileSync(join(f.home, '.madarch-daemon.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
 const result = await run(f, 'stop');
 expect(result.code).toBe(0); expect(observed(f).some(r => r.firstWriteError === 'EACCES')).toBe(true);
 expect(result.records.filter(r => r.phase === 'daemon.lock' && r.edge === 'terminal').map(r => r.outcome), 'successful lifecycle retry must terminate acquired').toEqual(['acquired']);
 saveBoundaryEvidence('lifecycle-write-retry', result.stderr);
});
for (const mode of ['delegated', 'fallback', 'dollar']) test(`spawn and wait use only actual daemon PID evidence: ${mode}`, async () => {
 const f = fixture(mode);
 if (mode === 'dollar') {
  writeFileSync(join(f.folder, 'bin/systemd-run'), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fixtures/startup-correction-scope.ts')}' \"$@\"\n`, { mode: 0o700 });
 }
 let pid: number | undefined;
 try {
  const result = await run(f, 'start');
  const state = JSON.parse(readFileSync(join(f.home, '.madarch-daemon.json'), 'utf8')); pid = state.pid;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const log = join(f.home, '.madarch-daemon.log');
  await until(() => collectStartup(readFileSync(log, 'utf8')).records.some(r => r.phase === 'role.daemon' && r.edge === 'begin'), 'external daemon entry');
  const actual = collectStartup(readFileSync(log, 'utf8')).records.findLast(r => r.phase === 'role.daemon' && r.edge === 'begin')!.pid;
  const spawns = result.records.filter(r => r.phase === 'daemon.spawn' && r.edge === 'terminal');
  const wait = result.records.findLast(r => r.phase === 'daemon.wait' && r.edge === 'terminal')!;
  if (mode === 'dollar') {
   expect(spawns.map(r => [r.outcome, r.childPid]), 'dollar receipt cannot identify a daemon').toEqual([['unknown', undefined]]);
   expect(wait.childPid, 'wait must not attribute launcher PID to dollar receipt').toBeUndefined();
  } else {
   expect(spawns.at(-1)!.childPid, 'spawn PID must be external daemon PID').toBe(actual);
   expect(wait.childPid, 'wait PID must be external daemon PID').toBe(actual);
   expect(state.pid).toBe(actual);
   if (mode === 'fallback') expect(spawns[0]!.outcome).toBe('unknown');
   if (mode === 'fallback') expect(spawns[0]!.childPid).toBeUndefined();
   if (mode === 'delegated') expect(observed(f).find(r => r.command === 'systemd-run')!.externalChild).not.toBe(actual);
  }
  saveBoundaryEvidence(`pid-${mode}`, result.stderr);
 } finally {
  // The state PID is deliberately the launcher for an unreadable receipt. Stop through the unchanged product rule.
  await run(f, 'stop');
  if (pid !== undefined) await until(() => { try { return /^[ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!); } catch { return true; } }, `fixture PID ${pid} exited`);
 }
}, 30_000);
