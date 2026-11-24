import { startupEntry, startupBegin } from '../../src/obs/log.js';
import { startupChildEnv } from '../../src/obs/startup-context.js';
import { readFileSync } from 'node:fs';
startupEntry('fixture');
const mode = process.argv[2];
const input = Bun.stdin.stream().getReader();
async function receive(): Promise<void> { const result = await input.read(); if (result.done) throw new Error('release stream closed'); }
function receipt(what: string): void {
 const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
 console.log(JSON.stringify({ what, pid: process.pid, ticks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], uptime: readFileSync('/proc/uptime', 'utf8') }));
}
if (mode === 'parent') {
 const child = Bun.spawn([process.execPath, import.meta.path, 'mark'], { env: startupChildEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
 const reader = child.stdout.getReader();
 const ready = await reader.read(); process.stdout.write(ready.value!);
 receipt('parent-ready');
 await receive();
 const end = startupBegin('parent');
 receipt('parent-begin');
 child.stdin.write('release\n'); child.stdin.flush();
 const emitted = await reader.read(); process.stdout.write(emitted.value!);
 await child.exited;
 end('ok'); receipt('parent-terminal');
} else {
 receipt('ready'); await receive();
 const end = startupBegin(mode === 'older' ? 'parent' : 'child'); receipt('emitted');
 if (mode === 'older') await receive();
 end('ok');
}

await input.cancel();
