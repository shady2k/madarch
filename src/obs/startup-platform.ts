/** Linux clock and process identity, shared by observation and storage. */
import { readFileSync, readlinkSync } from 'node:fs';
import { withSpanSync } from './trace.js';
import { createHash } from 'node:crypto';
export function processStartTicks(pid: number): string | undefined {
 if (process.platform !== 'linux') return undefined;
 try { const stat = withSpanSync('fs.read', { 'file.path': `/proc/${pid}/stat` }, () => readFileSync(`/proc/${pid}/stat`, 'utf8')); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return undefined; }
}
interface SharedClock { sample: () => bigint; domain: string; ticksPerSecond: bigint }
let shared: SharedClock | null | undefined;
function sharedClock(): SharedClock | null {
 if (shared !== undefined) return shared;
 shared = null;
 if (process.platform !== 'linux') return shared;
 try {
  const ffi = require('bun:ffi') as typeof import('bun:ffi');
  const library = ffi.dlopen('libc.so.6', {
   clock_gettime: { args: [ffi.FFIType.i32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
   sysconf: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i64 },
  });
  const { boot, namespace, offsets } = withSpanSync('fs.read', { 'file.path': '/proc/self' }, () => ({
   boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
   namespace: readlinkSync('/proc/self/ns/time'), offsets: readFileSync('/proc/self/timens_offsets', 'utf8'),
  }));
  if (boot === '' || namespace === '') return shared;
  const domain = createHash('sha256').update(`${boot}\n${namespace}\n${offsets}`).digest('hex');
  const ticksPerSecond = BigInt(library.symbols.sysconf(2));
  if (ticksPerSecond <= 0n) return shared;
  const buffer = new BigInt64Array(2);
  shared = { domain, ticksPerSecond, sample: () => {
   if (library.symbols.clock_gettime(7, ffi.ptr(buffer)) !== 0) throw new Error('shared clock unavailable');
   return buffer[0]! * 1_000_000_000n + buffer[1]!;
  } };
 } catch { shared = null; }
 return shared;
}
export function startupClock(): { clock: 'boottime' | 'process'; ns: string; domain?: string; ticksPerSecond?: string } {
 const clock = sharedClock();
 if (clock !== null) {
  try { return { clock: 'boottime', ns: clock.sample().toString(), domain: clock.domain, ticksPerSecond: clock.ticksPerSecond.toString() }; } catch { /* retain local ordering, not shared durations */ }
 }
 return { clock: 'process', ns: process.hrtime.bigint().toString() };
}
