/** Disposable interception only: all product entries and child processes remain real. */
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as ffi from 'bun:ffi';
const configPath = process.env.STARTUP_BOUNDARY_CONFIG;
if (configPath !== undefined) {
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { context: string; key: string; receipts: string; mode: string };
 const append = fs.appendFileSync;
 const spawn = cp.spawn; const writeFileSync = fs.writeFileSync;
 const spawnSync = cp.spawnSync; const openSync = fs.openSync; const readFileSync = fs.readFileSync; const dlopen = ffi.dlopen; const fstatSync = fs.fstatSync;
 let contextFd: number | undefined;
 const receipt = (value: object): void => append(config.receipts, JSON.stringify(value) + '\n');
 const wrapper = new URL('./startup-private-child.ts', import.meta.url).pathname;
 const wrap = (kind: string, command: string[]): string[] => [process.execPath, wrapper, kind, ...command];
 const isPgctl = (command: string[]): boolean => command[0]?.endsWith('/pg_ctl') === true;
 const originalSpawn = Bun.spawn.bind(Bun);
 (Bun as any).spawn = (command: string[], options: any) => originalSpawn(isPgctl(command) ? wrap('bun', command) : command, options);
 mock.module('node:child_process', () => ({ ...cp,
  spawn: (command: string, args: string[], options: any) => spawn(config.mode === 'spawn-reject' && args.includes('daemon-serve') ? '/nonexistent-startup-daemon-fixture' : command, args, options),
  spawnSync: (command: string, args: string[], options: any) => isPgctl([command])
   ? spawnSync(process.execPath, [wrapper, 'sync', command, ...args], options)
   : spawnSync(command, args, options),
 }));
 mock.module('node:fs', () => ({ ...fs,
  writeFileSync: (...args: any[]) => {
   if (config.mode === 'lifecycle-error' && String(args[0]).endsWith('.madarch-daemon.lock')) {
    receipt({ filesystemError: 'EACCES' });
    throw Object.assign(new Error('fixture lifecycle write denied'), { code: 'EACCES' });
   }
   return (writeFileSync as any)(...args);
  },
  openSync: (...args: any[]) => {
   const suffix = config.mode.includes('users') ? 'pgdata.users' : 'pgdata.lock';
   if (config.mode.startsWith('lock-') && String(args[0]).endsWith(suffix)) {
    if (config.mode.includes('error')) {
     receipt({ lockFilesystemError: true, kind: suffix });
     throw Object.assign(new Error('fixture lock filesystem failure'), { code: 'EACCES' });
    }
    try { fs.closeSync(0); } catch { /* stdin already closed */ }
    const fd = (openSync as any)(...args); receipt({ descriptor: fd, kind: suffix }); return fd;
   }
   const fd = (openSync as any)(...args); if (args[0] === config.context) { receipt({ contextOpened: true }); contextFd = fd; } return fd;
  },
  fstatSync: (...args: any[]) => { const stat = (fstatSync as any)(...args); if (config.mode === 'foreign-uid' && args[0] === contextFd) { receipt({ foreignUid: true, regular: stat.isFile(), privateMode: (stat.mode & 0o077) === 0 }); Object.defineProperty(stat, 'uid', { value: stat.uid + 1 }); } return stat; },
  readFileSync: (...args: any[]) => { if (args[0] === config.context) receipt({ contextRead: true }); return (readFileSync as any)(...args); },
 }));
 const ffiModule = require('bun:ffi');
 ffiModule.dlopen = (...args: any[]) => { receipt({ clockLoaded: true }); return (dlopen as any)(...args); };
 // A pipe receipt, not the console writer's return, releases address completion.
 if (config.mode === 'address') {
  const log = console.log.bind(console);
  console.log = (...args: unknown[]) => {
   log(...args);
   if (args.some(value => typeof value === 'string' && /http:\/\/127\.0\.0\.1:\d+\/products\//.test(value))) {
    receipt({ addressWritten: true });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(config.receipts + '.pipe-ack')) {
     if (Date.now() > deadline) throw new Error(`${import.meta.path}:1: pipe reader did not acknowledge address`);
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    receipt({ pipeReceiptReleased: true });
   }
  };
 }
 const on = process.on.bind(process);
 process.on = ((event: string, listener: (...args: any[]) => void) => { const result = on(event, listener); if (event === 'SIGTERM' && process.argv.includes('fill')) receipt({ fillSignalReady: true }); return result; }) as typeof process.on;
 const delegation = await import('../../src/plugin/sandbox-delegation.js');
 mock.module('../../src/plugin/sandbox-delegation.js', () => ({ ...delegation, canStartDelegatedScope: async () => ['delegated', 'fallback'].includes(config.mode) }));
 // The unrelated child is dispatched only after entry consumed its context.
 process.once('exit', () => {
  const answer = Bun.spawnSync(wrap('unrelated', [process.execPath, '-e', 'process.stdout.write("unrelated")']), { env: { ...process.env } });
  receipt({ unrelatedRan: answer.exitCode === 0 });
 });
}
