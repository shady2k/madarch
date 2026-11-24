/** Disposable interception only: all product entries and child processes remain real. */
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as ffi from 'bun:ffi';
const configPath = process.env.STARTUP_BOUNDARY_CONFIG;
if (configPath !== undefined) {
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { context: string; key: string; receipts: string; mode: string };
 const append = fs.appendFileSync;
 const spawnSync = cp.spawnSync; const openSync = fs.openSync; const readFileSync = fs.readFileSync; const dlopen = ffi.dlopen; const fstatSync = fs.fstatSync;
 let contextFd: number | undefined;
 const receipt = (value: object): void => append(config.receipts, JSON.stringify(value) + '\n');
 const inspect = (kind: string, command: unknown, options: any): void => {
  const env = options?.env ?? process.env;
  const text = JSON.stringify({ command, env });
  receipt({ kind, pgctl: JSON.stringify(command).includes('pg_ctl'), unrelated: JSON.stringify(command).includes('process.stdout.write'), pathAbsent: !text.includes(config.context) && env.MADARCH_STARTUP_CONTEXT === undefined, keyAbsent: !text.includes(config.key) });
 };
 const originalSpawn = Bun.spawn.bind(Bun);
 (Bun as any).spawn = (...args: any[]) => { inspect('bun', args[0], args[1]); return (originalSpawn as any)(...args); };
 const originalSync = Bun.spawnSync.bind(Bun);
 (Bun as any).spawnSync = (...args: any[]) => { inspect('bun-sync', args[0], args[1]); return (originalSync as any)(...args); };
 mock.module('node:child_process', () => ({ ...cp,
  spawnSync: (...args: any[]) => { inspect('sync', [args[0], args[1]], args[2]); return (spawnSync as any)(...args); },
 }));
 mock.module('node:fs', () => ({ ...fs,
  openSync: (...args: any[]) => { const fd = (openSync as any)(...args); if (args[0] === config.context) { receipt({ contextOpened: true }); contextFd = fd; } return fd; },
  fstatSync: (...args: any[]) => { const stat = (fstatSync as any)(...args); if (config.mode === 'foreign-uid' && args[0] === contextFd) { receipt({ foreignUid: true, regular: stat.isFile(), privateMode: (stat.mode & 0o077) === 0 }); Object.defineProperty(stat, 'uid', { value: stat.uid + 1 }); } return stat; },
  readFileSync: (...args: any[]) => { if (args[0] === config.context) receipt({ contextRead: true }); return (readFileSync as any)(...args); },
 }));
 const ffiModule = require('bun:ffi');
 ffiModule.dlopen = (...args: any[]) => { receipt({ clockLoaded: true }); return (dlopen as any)(...args); };
 const on = process.on.bind(process);
 process.on = ((event: string, listener: (...args: any[]) => void) => { const result = on(event, listener); if (event === 'SIGTERM' && process.argv.includes('fill')) receipt({ fillSignalReady: true }); return result; }) as typeof process.on;
 const delegation = await import('../../src/plugin/sandbox-delegation.js');
 mock.module('../../src/plugin/sandbox-delegation.js', () => ({ ...delegation, canStartDelegatedScope: async () => config.mode !== 'direct' }));
 // The unrelated child is dispatched only after entry consumed its context.
 process.once('exit', () => {
  const answer = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write("unrelated")'], { env: { ...process.env } });
  receipt({ unrelatedRan: answer.exitCode === 0 });
 });
}
