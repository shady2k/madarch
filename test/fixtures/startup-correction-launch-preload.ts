import { mock } from 'bun:test';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
const spawn = cp.spawn; const write = fs.writeFileSync;
await import('./startup-boundary-preload.js');
const config = JSON.parse(fs.readFileSync(process.env.STARTUP_BOUNDARY_CONFIG!, 'utf8'));
let failed = false;
mock.module('node:child_process', () => ({ ...cp, spawn: (command: string, args: string[], options: any) => {
 const child = spawn(command, args, options);
 fs.appendFileSync(config.receipts, JSON.stringify({ externalChild: child.pid, command }) + '\n');
 return child;
} }));
mock.module('node:fs', () => ({ ...fs, writeFileSync: (...args: any[]) => {
 if (config.mode === 'lifecycle-retry' && String(args[0]).endsWith('.madarch-daemon.lock') && !failed) {
  failed = true; fs.appendFileSync(config.receipts, JSON.stringify({ firstWriteError: 'EACCES' }) + '\n');
  throw Object.assign(new Error('fixture first write denied'), { code: 'EACCES' });
 }
 return (write as any)(...args);
} }));
const delegation = await import('../../src/plugin/sandbox-delegation.js');
mock.module('../../src/plugin/sandbox-delegation.js', () => ({ ...delegation, canStartDelegatedScope: async () => ['delegated', 'fallback', 'dollar'].includes(config.mode) }));
