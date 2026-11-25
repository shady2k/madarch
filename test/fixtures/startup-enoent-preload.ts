/** Observe real Bun spawn without adding child listeners. */
import { mock } from 'bun:test';
import * as cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
const spawn = cp.spawn;
mock.module('node:child_process', () => ({ ...cp, spawn: (command: string, args: string[], options: any) => {
 const child = spawn(command, args, options);
 appendFileSync(process.env.ENOENT_RECEIPTS!, JSON.stringify({ command, args, pid: child.pid, immediatePidUndefined: child.pid === undefined }) + '\n');
 return child;
} }));
const path = process.cwd() + '/src/plugin/sandbox-delegation.ts';
const delegation = await import(path);
mock.module(path, () => ({ ...delegation, canStartDelegatedScope: async () => true }));
