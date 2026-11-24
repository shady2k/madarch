import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
const path = process.argv[2]!; mkdirSync(dirname(path), { recursive: true });
const { symbols: { flock } } = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
const fd = openSync(path, 'a+'); if (flock(fd, 2) !== 0) throw new Error('fixture lock failed');
console.log('locked'); const reader = Bun.stdin.stream().getReader(); await reader.read();
flock(fd, 8); closeSync(fd); await reader.cancel(); console.log('released');
