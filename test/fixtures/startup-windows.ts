import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
const [root, mode] = process.argv.slice(2) as [string, string];
const folder = join(root, 'store', 'pgdata');
fs.mkdirSync(folder, { recursive: true });
const pgCtl = join(root, 'pg_ctl.exe');
fs.writeFileSync(pgCtl, 'fixture');
const pidFile = join(folder, 'postmaster.pid');
const recorded = !['absent', 'corrupt', 'unreadable', 'null-error', 'undefined-error'].includes(mode);
if (recorded) fs.writeFileSync(pidFile, '4242\n');
let launches = 0; let callbacks = 0; let probes = 0;
const nativeRead = fs.readFileSync;
mock.module('node:fs', () => ({ ...fs, readFileSync: (...args: Parameters<typeof nativeRead>) => {
 if (args[0] !== pidFile) return Reflect.apply(nativeRead, fs, args);
 if (mode === 'null-error') throw null;
 if (mode === 'undefined-error') throw undefined;
 if (mode === 'absent' || mode === 'absent-command' || mode === 'unreadable') throw Object.assign(new Error('fixture read failure'), { code: mode === 'unreadable' ? 'EACCES' : 'ENOENT' });
 return mode === 'corrupt' ? 'not-a-pid\n' : '4242\n';
} }));
const nativeSpawn = childProcess.spawnSync;
mock.module('node:child_process', () => ({ ...childProcess, spawnSync: (program: string, args: string[], options: object) => {
 if (program !== pgCtl) return nativeSpawn(program, args, options);
 launches++;
 if (args.join(' ') !== ['-D', folder, '-m', 'fast', '-w', '-t', '60', 'stop'].join(' ')) throw new Error('unexpected command arguments');
 if (mode === 'throw') throw new Error('fixture launch throw');
 if (mode === 'timeout') return { status: null, signal: null, error: Object.assign(new Error('fixture launch timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
 if (mode === 'launch-error') return { status: null, signal: null, error: Object.assign(new Error('fixture launch failure'), { code: 'ENOENT' }), stdout: '', stderr: '' };
 if (mode === 'signal') return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
 if (mode === 'kill') return { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
 if (mode === 'exit-error') return { status: 7, signal: null, stdout: '', stderr: '' };
 fs.rmSync(pidFile);
 return { status: 0, signal: null, stdout: '', stderr: '' };
} }));
const { stopWindowsDaemon } = await import('../../src/product/windows-daemon-stop.js');
const ok = stopWindowsDaemon({ pid: 1, home: root }, {
 storesOnly: true, storeFolders: () => [folder], pgCtl,
 alive: () => { probes++; return false; },
 ...(mode === 'bypass' ? { stopStore: () => { callbacks++; fs.rmSync(pidFile); return true; } } : {}),
});
console.log(JSON.stringify({ ok, launches, callbacks, probes }));
