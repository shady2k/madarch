import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { fixture, launch, observed, ready, port, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
const mode: string = 'direct';
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
