import { plugin } from 'bun';
import { readFileSync, writeFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { startupClock } from '../../src/obs/startup-platform.js';
const [folder, kind, mode] = process.argv.slice(2) as [string, 'users' | 'start', string];
const path = join(folder, kind === 'users' ? 'pgdata.users' : 'pgdata.lock');
mkdirSync(folder, { recursive: true });
plugin({ name: 'test private lock boundaries', setup(build) {
 build.onLoad({ filter: /postgres-cluster\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { holdLock, tryClusterLock };', loader: 'ts' }));
} });
const mod = await import('../../src/adapters/postgres-cluster.js') as any;
const { startupEntry } = await import('../../src/obs/log.js'); startupEntry('fixture');
const ffi = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
const receipt = (value: object) => console.log(JSON.stringify(value));
let holder: Bun.Subprocess<'pipe', 'pipe', 'inherit'> | undefined;
let fd: number | undefined;
try {
 if (mode !== 'zero') {
  holder = Bun.spawn([process.execPath, new URL('./startup-trace-lock.ts', import.meta.url).pathname, path], { env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  const reader = holder.stdout.getReader(); const held = await reader.read(); reader.releaseLock();
  if (new TextDecoder().decode(held.value).trim() !== 'locked') throw new Error('external holder not ready');
 }
 if (mode === 'try' || mode === 'zero') {
  if (mode === 'zero') { try { closeSync(0); } catch {} }
  fd = openSync(path, 'a+'); receipt({ descriptor: fd });
  const first = mod.tryClusterLock(fd, join(folder, 'pgdata'), kind); receipt({ first });
  if (holder) { holder.stdin.write('release'); holder.stdin.end(); await holder.exited; holder = undefined;
   receipt({ released: startupClock() }); receipt({ second: mod.tryClusterLock(fd, join(folder, 'pgdata'), kind) }); }
 } else {
  let rejected = false;
  const now = Date.now; let clock = now();
  if (mode === 'deadline') Date.now = () => { const answer = clock; clock += 200_000; return answer; };
  const waiting = mod.holdLock(path, 2, { what: 'fixture lock wait', deadlineMs: 90_000 });
  // The actual failed nonblocking flock precedes holdLock's first sleep.
  const probe = openSync(path, 'a+'); const refused = ffi.symbols.flock(probe, 2 | 4); closeSync(probe);
  receipt({ externalRefused: refused !== 0, clock: startupClock() });
  if (mode !== 'deadline') { await Bun.sleep(40); writeFileSync(join(folder, 'waiting'), 'ready');
   await new Promise<void>(resolve => { const timer = setInterval(() => { try { readFileSync(join(folder, 'release')); clearInterval(timer); resolve(); } catch {} }, 5); });
   receipt({ released: startupClock() }); holder!.stdin.write('release'); holder!.stdin.end(); await holder!.exited; holder = undefined; }
  try { fd = await waiting; } catch (error) { rejected = String(error).includes('lock is still held'); }
  finally { Date.now = now; }
  receipt({ rejected, acquired: fd !== undefined });
 }
} finally {
 if (fd !== undefined) { ffi.symbols.flock(fd, 8); closeSync(fd); }
 if (holder) { holder.stdin.write('release'); holder.stdin.end(); await holder.exited; receipt({ holderExited: true }); }
}
