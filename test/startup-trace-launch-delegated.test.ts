import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { createFixtureOwner, launch, observed, ready, port, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
const fixture = createFixtureOwner();
const mode: string = 'delegated';
 test(`real launcher, ${mode} daemon attempts, API and fill retain entry context through detached close`, async () => {
  const f = fixture(mode); const p = await port();
  const log = join(f.home, '.madarch-daemon.log'); writeFileSync(log, 'old private log prefix\n');
  const offset = statSync(log).size;
  const stopped = await launch(f, ['stop', '--home', f.home]).result(); expect(stopped.code).toBe(0);
  const run = launch(f, ['start', '--home', f.home, '--port', String(p)]);
  let start: Awaited<ReturnType<typeof run.result>> | undefined;
  let finalStop: Awaited<ReturnType<typeof run.result>> | undefined;
  try {
   start = await run.result(); expect(start.code, start.stdout + start.stderr).toBe(0);
   await until(() => observed(f).some(r => r.fillSignalReady), 'fill installed real signal handler');
   expect(collectStartup(readFileSync(log).subarray(offset).toString()).records.some(r => r.role === 'fill' && r.edge === 'begin'), 'real fill entry must emit begin before its signal-ready receipt').toBe(true);
  } finally { finalStop = await launch(f, ['stop', '--home', f.home]).result(); expect(finalStop.code).toBe(0); }
  await until(() => {
   const parsed = collectStartup(readFileSync(log).subarray(offset).toString());
   return parsed.records.some(r => r.role === 'fill' && r.edge === 'terminal') && parsed.incomplete.length === 0;
  }, 'detached append stream balanced through terminal close');
  const detached = readFileSync(log).subarray(offset).toString();
  const foreground = stopped.stderr + start!.stderr + finalStop!.stderr;
  saveBoundaryEvidence(`launch-${mode}`, foreground + detached, offset);
  const parsed = collectStartup(foreground + detached, ['cli', 'launcher', 'daemon', 'api', 'fill']);
  expect(parsed.incomplete).toEqual([]); ready(parsed.records, f, ['cli', 'launcher', 'daemon', 'api', 'fill']);
  expect(parsed.records.filter(r => r.phase === 'command.stop')).toHaveLength(4);
  expect(parsed.records.filter(r => r.role === 'daemon' && r.phase === 'role.daemon' && r.edge === 'begin')).toHaveLength(mode === 'fallback' ? 2 : 1);
  const scope = observed(f).filter(r => r.delegatedAttempt); expect(scope).toHaveLength(mode === 'direct' ? 0 : 1);
  expect(scope.every(r => r.pathPresent)).toBe(true);
  for (const privateInput of [f.context, f.key]) expect(foreground + detached).not.toContain(privateInput);
 }, 60_000);
 test('a scope wrapper that cannot be written is a failed start with its reason, and leaves no partial file', async () => {
  const f = fixture(mode); const p = await port();
  const log = join(f.home, '.madarch-daemon.log'); writeFileSync(log, 'old private log prefix\n');
  // A folder where the wrapper file belongs: the partial file is written and its rename onto the folder fails, which is
  // the moment the start's own error path exists for. Nothing is spawned, so the daemon's log keeps what the test wrote.
  mkdirSync(join(f.home, '.madarch-daemon-scope.sh'));
  const result = await launch(f, ['start', '--home', f.home, '--port', String(p)]).result();
  expect(result.code).toBe(1);
  const said = result.stdout + result.stderr;
  expect(said).toContain(`the daemon did not start: the scope wrapper beside ${join(f.home, '.madarch-daemon-pid-')}`);
  expect(said).toContain('cannot be written');
  // A reason, never a stack from inside the spawn.
  expect(said).not.toMatch(/^\s+at /mu);
  expect(readdirSync(f.home).filter(name => name.startsWith('.madarch-daemon-scope.sh.'))).toEqual([]);
  expect(readFileSync(log, 'utf8')).toBe('old private log prefix\n');
  expect(observed(f).filter(r => r.delegatedAttempt)).toEqual([]);
 }, 60_000);
