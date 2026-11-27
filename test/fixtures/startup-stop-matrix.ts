import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { Client } from 'pg';
import { join, dirname } from 'node:path';
import { ensurePostgresInstalled } from '../../src/adapters/postgres-install.js';
import { postgresInstallFolder } from '../../src/adapters/postgres-builds.js';
const store = process.argv[2]!;
const mode = process.argv[3]!;
const dataDir = join(store, 'pgdata');
const realFs = { ...fs };
const realChildProcess = { ...childProcess };
const descriptors = new Map<number, string>();
let active = false;
let procReads = 0;
let pidReads = 0;
let productPidReads = 0;
let startupWrites = 0;
let startupWriteBytes = 0;
const receipts: object[] = [];
let preReclaimConnects = 0;
let reclaimEntryObserved = false;
const nativeConnect = Client.prototype.connect;
Client.prototype.connect = function (this: Client, ...args: Parameters<typeof nativeConnect>) {
 if (active && mode === 'pre-reclaim') {
  preReclaimConnects++;
  if (preReclaimConnects === 1) {
   receipts.push({ initialAnswerForcedFailure: true });
   return Promise.reject(new Error('fixture first-answer failure'));
  }
 }
 return nativeConnect.apply(this, args);
} as typeof nativeConnect;
const nativeQuery = Client.prototype.query;
Client.prototype.query = function (this: Client, ...args: Parameters<typeof nativeQuery>) {
 const result = nativeQuery.apply(this, args);
 if (active && mode === 'pre-reclaim' && args[0] === 'SELECT 1' && reclaimEntryObserved) {
  return Promise.resolve(result).then(answer => { receipts.push({ reclaimActualAnswer: true }); return answer; });
 }
 return result;
} as typeof nativeQuery;
// Only the bounded observation reader uses readSync. Product reads and external
// observations retain their native filesystem calls.
mock.module('node:fs', () => ({ ...realFs,
 writeSync: (...args: Parameters<typeof fs.writeSync>) => {
  const value: string | NodeJS.ArrayBufferView = args[1] as string | NodeJS.ArrayBufferView;
  const text = typeof value === 'string' ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  if (args[0] === 2 && text.includes('"version":1') && text.includes('"phase":')) { startupWrites++; startupWriteBytes += Buffer.byteLength(text); }
  return realFs.writeSync(...args);
 },
 readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
  const text = realFs.readFileSync(...args);
  if (active && mode === 'pre-reclaim' && /^\/proc\/\d+\/cmdline$/.test(String(args[0]))) {
   reclaimEntryObserved = true;
   receipts.push({ reclaimCmdlineEntry: true, cmdlineNamesDataDir: String(text).includes(dataDir) });
  }
  if (active && mode === 'sync-holder-changed' && String(args[0]) === join(dataDir, 'postmaster.pid')) {
   productPidReads++;
   if (productPidReads === 2) return String(text).replace(/^\d+/, String(process.pid));
  }
  return text;
 },
 openSync: (...args: Parameters<typeof fs.openSync>) => {
  if (active && mode === 'appeared' && String(args[0]) === join(dataDir, 'postmaster.pid') && pidReads < 2) { pidReads++; throw Object.assign(new Error('fixture absent before'), { code: 'ENOENT' }); }
  const fd = realFs.openSync(...args); descriptors.set(fd, String(args[0])); return fd; },
 closeSync: (fd: number) => { descriptors.delete(fd); return realFs.closeSync(fd); },
 readSync: (...args: Parameters<typeof fs.readSync>) => {
  const path = descriptors.get(args[0]);
  const bytes = realFs.readSync(...args);
  if (!active) return bytes;
  const buffer = args[1] as Buffer;
  if (path === join(dataDir, 'postmaster.pid')) {
   pidReads++;
   if (mode === 'unstable-pidfile' && pidReads === 2) { receipts.push({ seam: mode, pidReads }); return buffer.write(String(process.pid) + '\n'); }
  }
  if (path?.startsWith('/proc/') && path.endsWith('/stat')) {
   procReads++;
   if (mode === 'after-unreadable' && procReads > 1) throw Object.assign(new Error('fixture unreadable proc'), { code: 'EACCES' });
   let text = buffer.toString('utf8', 0, bytes);
   const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
   if (mode.includes('missing-ticks')) fields[19] = 'unavailable';
   if (mode === 'pid-reuse' && procReads > 1 || mode === 'sync-changing-ticks' && procReads === 2) fields[19] = String(BigInt(fields[19]!) + 1n);
   text = text.slice(0, text.lastIndexOf(')') + 2) + fields.join(' ');
   if (mode.includes('missing-ticks') || mode === 'pid-reuse' || mode === 'sync-changing-ticks') { receipts.push({ seam: mode, procReads }); return buffer.write(text); }
  }
  return bytes;
 },
}));
mock.module('node:child_process', () => ({ ...realChildProcess,
 spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => {
  if (active && mode === 'sync-command-timeout' && String(args[0]).endsWith('/pg_ctl')) {
   receipts.push({ timeoutBoundary: 'controlled ETIMEDOUT, no elapsed-time claim', commandLaunched: false });
   return { pid: 0, output: [], stdout: null, stderr: null, status: null, signal: 'SIGTERM', error: Object.assign(new Error('fixture native timeout result'), { code: 'ETIMEDOUT' }) };
  }
  return realChildProcess.spawnSync(...args);
 },
}));
const { openCluster, clusterPaths, stopStoreForExit, stopDatabasesUnderSync } = await import('../../src/adapters/postgres-cluster.js');
const { startupEntry } = await import('../../src/obs/log.js');
startupEntry('fixture');
const paths = clusterPaths(store);
const install = await ensurePostgresInstalled({ env: process.env });
const originalTools = process.env['MADARCH_TOOLS'];
process.env['MADARCH_TOOLS'] = join(store, 'tools');
const bin = join(postgresInstallFolder(process.env), 'bin');
realFs.mkdirSync(bin, { recursive: true });
for (const program of ['initdb', 'postgres']) realFs.symlinkSync(join(install.bin, program), join(bin, program));
const probeReceipt = join(store, 'probe-receipt');
realFs.writeFileSync(join(bin, 'psql'), `#!/bin/sh\nprintf 'probe\\n' >> "${probeReceipt}"\nexec "${join(install.bin, 'psql')}" "$@"\n`, { mode: 0o755 });
const receipt = join(store, 'command-receipt');
const wrapper = join(store, 'pg-ctl.ts');
realFs.writeFileSync(wrapper, `import * as fs from 'node:fs';
const args = process.argv.slice(2);
const stop = args.includes('stop');
const mode = ${JSON.stringify(mode)};
const real = ${JSON.stringify(join(install.bin, 'pg_ctl'))};
const dataDir = ${JSON.stringify(dataDir)};
if (stop) fs.appendFileSync(${JSON.stringify(receipt)}, 'launched\\n');
let pid = 0; let ticks = '';
try { pid = Number(fs.readFileSync(dataDir + '/postmaster.pid', 'utf8').split('\\n')[0]); const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); ticks = s.slice(s.lastIndexOf(')') + 2).split(' ')[19]!; } catch {}
if (stop && mode.includes('command-signal')) { fs.appendFileSync(${JSON.stringify(receipt)}, 'wrapper-sigterm\\n'); process.kill(process.pid, 'SIGTERM'); await new Promise(() => {}); }
if (stop && mode === 'released') fs.renameSync(dataDir + '/postmaster.pid', dataDir + '/saved.pid');
const execute = !stop || mode.includes('gone') || mode === 'absent' || ['sync-positive', 'sync-fallback', 'reclaim', 'pre-reclaim'].includes(mode) && fs.existsSync(dataDir + '/matrix-action');
let code = execute ? Bun.spawnSync([real, ...args], { stdout: 'inherit', stderr: 'inherit', env: process.env }).exitCode : (mode.includes('zero') || mode === 'released' || mode === 'pid-reuse' ? 0 : 1);
if (stop && execute && pid) {
 let gone = false;
 for (let i = 0; i < 1000; i++) {
  try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); gone = f[19] !== ticks || f[0] === 'Z' || f[0] === 'X'; } catch { gone = true; }
  if (gone) break;
  Bun.sleepSync(10);
 }
 fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ gone, pid, ticks }) + '\\n');
 if (!gone) process.exit(93);
}
if (stop && mode.includes('gone-nonzero')) code = 7;
process.exit(code);
`);
realFs.writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`, { mode: 0o755 });
const cluster = await openCluster({ ...paths, bin });
const external = () => {
 const pid = Number(realFs.readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
 const stat = realFs.readFileSync(`/proc/${pid}/stat`, 'utf8');
 const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
 return { pid, ticks: fields[19], state: fields[0] };
};
const savedPidText = realFs.readFileSync(join(dataDir, 'postmaster.pid'), 'utf8');
const before = external();
console.log(JSON.stringify({ external: before }));
let stopped = false;
let lockChild: ReturnType<typeof Bun.spawn> | undefined;
try {
 if (mode === 'users-busy' || mode === 'start-busy') {
  const driver = join(store, 'lock.ts');
  realFs.writeFileSync(driver, `import { openSync } from 'node:fs'; import { dlopen, FFIType } from 'bun:ffi';
const lib = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
const fd = openSync(process.argv[2]!, 'a+'); if (lib.symbols.flock(fd, 2 | 4) !== 0) process.exit(94); console.log('held'); await new Promise(() => {});`);
  // Users are first given back without touching the real server.
  await stopStoreForExit(store, { force: true });
  lockChild = Bun.spawn([process.execPath, driver, join(store, mode === 'users-busy' ? 'pgdata.users' : 'pgdata.lock')], { env: { ...process.env }, stdout: 'pipe', stderr: 'inherit' });
  const reader = (lockChild.stdout as ReadableStream<Uint8Array>).getReader();
  const ready = await reader.read(); if (new TextDecoder().decode(ready.value).trim() !== 'held') throw new Error('lock not acquired');
  reader.releaseLock();
 }

 if (mode.startsWith('sync-') || mode === 'reclaim' || mode === 'pre-reclaim') {
  // Give back the actual process lease using an untouched-server command.
  await stopStoreForExit(store, { force: true });
  if (mode === 'sync-unavailable') realFs.unlinkSync(join(bin, 'psql'));
  if (mode === 'sync-other') {
   realFs.unlinkSync(join(bin, 'psql'));
   realFs.writeFileSync(join(bin, 'psql'), `#!/bin/sh\n"${join(install.bin, 'psql')}" "$@" >/dev/null || exit $?\nprintf '/other/fixture/directory\\n'\n`, { mode: 0o755 });
  }
  if (mode === 'sync-fallback') {
   // `psql` is asked and does not answer; only the pid file's own identity can attest the postmaster.
   realFs.unlinkSync(join(bin, 'psql'));
   realFs.writeFileSync(join(bin, 'psql'), `#!/bin/sh\nprintf 'probe\\n' >> "${probeReceipt}"\nexit 1\n`, { mode: 0o755 });
  }
 }
 if (mode === 'reclaim') {
  realFs.renameSync(join(paths.socketDir, '.s.PGSQL.5432'), join(paths.socketDir, 'held-socket'));
 }
 if (mode === 'absent') { await stopStoreForExit(store, { force: true }); stopped = true; }
 if (mode.includes('sigstop')) {
  process.kill(before.pid, 'SIGSTOP');
  let observed = false;
  for (let i = 0; i < 1000; i++) { if (external().state === 'T') { observed = true; break; } await Bun.sleep(5); }
  if (!observed) throw new Error('SIGSTOP readiness not observed');
  console.log(JSON.stringify({ sigstopObserved: true }));
 }
 realFs.writeFileSync(join(dataDir, 'matrix-action'), 'ready');
 if (mode === 'corrupt-holder') realFs.writeFileSync(join(dataDir, 'postmaster.pid'), 'corrupt fixture holder\n');
 if (mode === 'sync-no-command' || mode === 'missing-command' || mode === 'launch-error') realFs.unlinkSync(join(bin, 'pg_ctl'));
 if (mode === 'launch-error') realFs.writeFileSync(join(bin, 'pg_ctl'), '#!/missing-fixture-interpreter\n', { mode: 0o755 });
 if (mode === 'non-linux-holder') Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
 active = true;
 console.log(JSON.stringify({ action: 'begin' }));
 if (mode === 'reclaim' || mode === 'pre-reclaim') {
  try { await openCluster({ ...paths, bin }); }
  catch (error) {
   if (mode !== 'pre-reclaim' || !reclaimEntryObserved || !receipts.some(fact => 'reclaimActualAnswer' in fact) || !(error instanceof Error) || !error.message.includes('another server might be running')) throw error;
   // The existing caller starts after reclaim's answering early return. Keep its
   // real pg_ctl refusal visible; the test concerns absence of a stop attempt.
   console.log(JSON.stringify({ existingStartRefusedLiveHolder: true }));
  }
  console.log(JSON.stringify(mode === 'pre-reclaim' ? { holderAfterReclaimReturn: external() } : { reopened: external() }));
 }
 else if (mode === 'in-process-owner') await stopStoreForExit(store);
 else if (mode === 'lease-release') { const other = await openCluster({ ...paths, bin }); await other.stop(); }
 else if (mode.startsWith('sync-') || mode === 'start-busy') stopDatabasesUnderSync(dirname(dirname(store)));
 else if (mode.startsWith('cluster-')) await cluster.stop();
 else { try { await stopStoreForExit(store, { force: true }); } catch (error) { if (mode !== 'launch-error') throw error; console.log(JSON.stringify({ launchFailed: true })); } }
 console.log(JSON.stringify({ action: 'end', procReads, pidReads }));
} finally {
 active = false;
 if (mode === 'non-linux-holder') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
 if (lockChild) { lockChild.kill(); await lockChild.exited; console.log(JSON.stringify({ lockReleased: true })); }
 if (mode.includes('sigstop')) { process.kill(before.pid, 'SIGCONT'); console.log(JSON.stringify({ resumed: true })); }
 for (const item of receipts) console.log(JSON.stringify(item));
 if (realFs.existsSync(probeReceipt)) console.log(JSON.stringify({ probes: realFs.readFileSync(probeReceipt, 'utf8').trim().split('\n').length }));
 if (realFs.existsSync(receipt)) console.log(JSON.stringify({ commands: realFs.readFileSync(receipt, 'utf8') }));
 try { console.log(JSON.stringify({ afterExternal: external() })); } catch { console.log(JSON.stringify({ afterExternal: null })); }
 if (mode === 'corrupt-holder') realFs.writeFileSync(join(dataDir, 'postmaster.pid'), savedPidText);
 const saved = join(dataDir, 'saved.pid'); if (realFs.existsSync(saved)) realFs.renameSync(saved, join(dataDir, 'postmaster.pid'));
 if (originalTools === undefined) delete process.env['MADARCH_TOOLS']; else process.env['MADARCH_TOOLS'] = originalTools;
 if (!stopped) await stopStoreForExit(store, { force: true });
 console.log(JSON.stringify({ startupWrites, startupWriteBytes, sampleProcReads: procReads, samplePidReads: pidReads }));

}
