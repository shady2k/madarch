import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupClock } from '../src/obs/startup-platform.js';
import { collectStartup, comparableTime } from './startup-trace-collector.js';
import { createFixtureOwner, preload, observed, ready, port, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
const fixture = createFixtureOwner();
const handoverPreload = join(import.meta.dir, 'fixtures', 'startup-handover-preload.ts');
const source = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
function pair(pid: number): { pid: number; ticks: string; state: string } | undefined {
 try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return { pid, ticks: fields[19]!, state: fields[0]! }; } catch { return undefined; }
}
async function settledDaemonLog(log: string, daemon: { pid: number; ticks: string }, evidence?: string): Promise<string> {
 const writers = new Map<number, string>([[daemon.pid, daemon.ticks]]);
 let stable: string | undefined;
 let settled = '';
 const samples: { bytes: number; live: number[] }[] = [];
 await until(() => {
  const text = readFileSync(log, 'utf8');
  for (const record of collectStartup(text).records) {
   if (record.startTicks !== undefined) writers.set(record.pid, record.startTicks);
  }
  const live = [...writers].filter(([pid, ticks]) => {
   const current = pair(pid);
   return current !== undefined && current.ticks === ticks && !['Z', 'X'].includes(current.state);
  }).map(([pid]) => pid);
  samples.push({ bytes: Buffer.byteLength(text), live });
  if (live.length > 0) { stable = undefined; return false; }
  if (stable !== text) { stable = text; return false; }
  settled = text;
  return true;
 }, 'old daemon log writers exited and EOF is stable');
 if (evidence !== undefined) writeFileSync(join(evidence, 'handover-log-settlement.json'), JSON.stringify({ writers: [...writers].map(([pid, ticks]) => ({ pid, ticks })), samples, complete: collectStartup(settled).incomplete }, null, 2));
 return settled;
}
test('S2 independent daemon stop precedes fresh serve of the same scratch cluster', async () => {
 const f = fixture(); const p = await port();
 const store = join(f.home, '.madarch', 'knowledge', 'handover', 'graph');
 const configuration = join(f.folder, 'handover-config');
 writeFileSync(configuration, JSON.stringify({ store, receipts: f.receipts, fillRoot: join(f.folder, 'empty-fill-root') }), { mode: 0o600 });
 const env = { ...f.env, STARTUP_HANDOVER_CONFIG: configuration };
 const contextBefore = readFileSync(f.context, 'utf8');
 const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
 writeFileSync(join(f.folder, 'bin', 'bun'), `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(preload)} --preload ${quote(handoverPreload)} "$@"\n`, { mode: 0o700 });
 const run = (args: string[]) => {
  const child = Bun.spawn([process.execPath, '--preload', preload, '--preload', handoverPreload, source, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
  return { child, result: async () => ({ code: await child.exited, stdout: await stdout, stderr: await stderr }) };
 };
 const log = join(f.home, '.madarch-daemon.log');
 let fresh: ReturnType<typeof run> | undefined;
 try {
  const start = await run(['start', '--home', f.home, '--port', String(p)]).result(); expect(start.code, start.stdout + start.stderr + (existsSync(log) ? readFileSync(log, 'utf8') : '\nmissing daemon log')).toBe(0);
  await until(() => observed(f).some(r => r.event === 'api-cluster-open'), 'actual daemon API owns scratch cluster');
  await until(() => observed(f).some(r => r.fillSignalReady), 'daemon fill signal handler');
  expect(observed(f).some(r => r.event === 'fill-catalogue-isolated')).toBe(true);
  const daemonState = JSON.parse(readFileSync(join(f.home, '.madarch-daemon.json'), 'utf8')) as { pid: number };
  const daemonPair = pair(daemonState.pid)!; expect(daemonPair).toBeDefined();
  const pid = Number(readFileSync(join(store, 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[0]);
  const old = pair(pid)!; expect(old).toBeDefined(); expect(old.state).not.toBe('Z');
  let lastSeen = startupClock(); let firstGone: ReturnType<typeof startupClock> | undefined;
  const procBounds: { before: ReturnType<typeof startupClock>; uptime: string; after: ReturnType<typeof startupClock> }[] = [];
  const sample = () => { const before = startupClock(); const uptime = readFileSync('/proc/uptime', 'utf8').split(' ')[0]!; const after = startupClock(); procBounds.push({ before, uptime, after }); return { before, after }; };
  let watching = true;
  const observer = (async () => { while (watching) { const clock = sample(); const current = pair(old.pid); const after = startupClock(); if (current === undefined || current.ticks !== old.ticks || ['Z', 'X'].includes(current.state)) { firstGone = after; return; } lastSeen = clock.before; await Bun.sleep(2); } })();
  const stop = await run(['stop', '--home', f.home]).result();
  await until(() => firstGone !== undefined, 'external old postmaster departure'); watching = false; await observer;
  expect(stop.code, stop.stdout + stop.stderr).toBe(0);
  expect(firstGone).toBeDefined();
  const departure = { event: 'departure-observed', old, lastSeen, firstGone };
  appendFileSync(f.receipts, JSON.stringify(departure) + '\n');
  const oldText = await settledDaemonLog(log, daemonPair, process.env.STARTUP_BOUNDARY_EVIDENCE);
  const diagnosticDirectory = process.env.STARTUP_BOUNDARY_EVIDENCE;
  if (diagnosticDirectory !== undefined) {
   writeFileSync(join(diagnosticDirectory, 'handover-old-before-assertion.txt'), oldText);
   writeFileSync(join(diagnosticDirectory, 'handover-old-before-assertion.json'), JSON.stringify(collectStartup(oldText, ['daemon', 'launcher', 'api', 'fill']), null, 2));
  }
  const oldParsed = collectStartup(oldText, ['daemon', 'launcher', 'api', 'fill']); const stopParsed = collectStartup(stop.stderr, ['cli']);
  expect(oldParsed.incomplete).toEqual([]); expect(stopParsed.incomplete).toEqual([]);
  ready([...oldParsed.records, ...stopParsed.records], f, ['daemon', 'launcher', 'api', 'fill', 'cli']);
  const stopped = oldParsed.records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal' && r.postmasterPid === old.pid && r.postmasterTicks === old.ticks)!;
  expect(stopped, 'missing daemon async stop for externally read old pair').toBeDefined();
  expect(stopped.identity).toBe('observed');
  expect(stopped.signal).toBe('none');
  expect((stopped.outcome === 'stopped' && stopped.holder === 'gone') || (stopped.outcome === 'unknown' && stopped.holder === 'released'), 'successful stop requires the old holder gone').toBe(true);
  expect(observed(f).some(r => r.event === 'api-cluster-close')).toBe(true);
  // No matching stop command in the independent CLI means its sweep did not stop the old server.
  expect(stopParsed.records.some(r => r.phase === 'cluster.stop.command')).toBe(false);
  const sweep = stopParsed.records.filter(r => r.phase === 'cluster.stop' && r.edge === 'terminal');
  // The independent CLI sweeps exactly the one store of this home, and its sweep is what these records are read for: a
  // missing record would let every check below pass on nothing (ALX-1604, item 2).
  expect(sweep, 'one sweep terminal for the store the CLI stop did not open').toHaveLength(1);
  expect(sweep.every(r => r.outcome === 'absent')).toBe(true);
  expect(sweep.every(r => r.postmasterPid === undefined && r.postmasterTicks === undefined && r.identity === undefined)).toBe(true);
  const release = startupClock(); appendFileSync(f.receipts, JSON.stringify({ event: 'fresh-serve-release', ...release }) + '\n');
  expect(observed(f).findIndex(r => r.event === 'departure-observed')).toBeLessThan(observed(f).findIndex(r => r.event === 'fresh-serve-release'));
  expect(lastSeen.clock).toBe('boottime'); expect(firstGone!.clock).toBe('boottime'); expect(release.clock).toBe('boottime');
  expect(lastSeen.domain).toBe(firstGone!.domain); expect(release.domain).toBe(firstGone!.domain);
  for (const bound of procBounds) {
   expect(bound.before.clock).toBe('boottime'); expect(bound.before.domain).toBe(release.domain); expect(bound.after.domain).toBe(release.domain);
   const uptimeNs = BigInt(Math.round(Number(bound.uptime) * 100)) * 10_000_000n;
   expect(BigInt(bound.before.ns)).toBeLessThanOrEqual(uptimeNs + 10_000_000n); expect(BigInt(bound.after.ns)).toBeGreaterThanOrEqual(uptimeNs);
  }
  expect(BigInt(lastSeen.ns)).toBeLessThanOrEqual(BigInt(firstGone!.ns)); expect(BigInt(firstGone!.ns)).toBeLessThanOrEqual(BigInt(release.ns));
  fresh = run(['serve', '--product', f.home, '--port', String(p), '--no-open']);
  await until(async () => {
   if (fresh!.child.exitCode !== null) { const result = await fresh!.result(); throw new Error(`${import.meta.path}:1: fresh serve exited ${result.code}: ${result.stdout}\n${result.stderr}`); }
   return observed(f).filter(r => r.event === 'api-cluster-open').length === 2;
  }, 'fresh real serve opened same cluster');
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${p}/api/products`)).ok; } catch { return false; } }, 'fresh serve API response');
  await until(() => observed(f).filter(r => r.fillSignalReady).length === 2, 'fresh fill signal handler');
  const newPid = Number(readFileSync(join(store, 'pgdata', 'postmaster.pid'), 'utf8').split('\n')[0]); const current = pair(newPid)!;
  expect(current).toBeDefined(); expect(current.state).not.toBe('Z'); expect(`${current.pid}:${current.ticks}`).not.toBe(`${old.pid}:${old.ticks}`);
  fresh.child.kill('SIGTERM'); const freshResult = await fresh.result(); fresh = undefined;
  const parsed = collectStartup(freshResult.stderr, ['cli', 'launcher', 'api', 'fill']);
  expect(parsed.incomplete).toEqual([]); ready(parsed.records, f, ['cli', 'launcher', 'api', 'fill']);
  const opened = parsed.records.find(r => r.phase === 'cluster.start' && r.edge === 'terminal' && r.postmasterPid === current.pid && r.postmasterTicks === current.ticks)!;
  expect(opened, 'fresh cluster open must carry independent new process pair').toBeDefined(); expect(opened.identity).toBe('observed');
  expect(opened.cluster).toBe(stopped.cluster); expect(opened.cluster).toBeDefined(); expect(opened.keyId).toBe(stopped.keyId); expect(opened.collection).toBe(stopped.collection);
  expect(comparableTime(stopped, opened)).toBe(true); expect(opened.domain).toBe(release.domain); expect(BigInt(opened.ns)).toBeGreaterThanOrEqual(BigInt(release.ns));
  expect(readFileSync(f.context, 'utf8') === contextBefore, 'controller context must remain unchanged').toBe(true);
  saveBoundaryEvidence('handover-daemon', oldText); saveBoundaryEvidence('handover-stop', stop.stderr); saveBoundaryEvidence('handover-fresh-serve', freshResult.stderr);
  const destination = process.env.STARTUP_BOUNDARY_EVIDENCE;
  if (destination !== undefined) writeFileSync(join(destination, 'handover-controller.json'), JSON.stringify({ old, current, lastSeen, firstGone, release, procBounds, departureBeforeRelease: true, receipts: observed(f).filter(r => r.event !== undefined), start: { code: start.code }, stop: { code: stop.code }, freshServe: { code: freshResult.code } }, null, 2), { mode: 0o600 });
 } finally {
  if (fresh !== undefined) {
   fresh.child.kill('SIGTERM'); const result = await fresh.result();
   saveBoundaryEvidence('handover-fresh-serve-failure', result.stderr);
   console.error(`fresh serve cleanup exit ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  if (existsSync(join(f.home, '.madarch-daemon.json'))) await run(['stop', '--home', f.home]).result();
 }
}, 90_000);
