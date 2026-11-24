import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';
const root = mkdtempSync(join(tmpdir(), 'startup-trace-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const collection = randomUUID(); const key = randomBytes(32).toString('hex'); const context = join(root, 'context');
chmodSync(root, 0o700);
writeFileSync(context, JSON.stringify({ version: 1, collection, key }), { mode: 0o600 });
function run(path?: string, extra: Record<string, string> = {}, dataDir = join(root, 'missing', 'pgdata')) {
 const env: Record<string, string | undefined> = { ...process.env, MADARCH_STARTUP_TIMING: '1' };
 delete env.MADARCH_TRACE; delete env.MADARCH_STARTUP_CONTEXT;
 Object.assign(env, extra, path === undefined ? {} : { MADARCH_STARTUP_CONTEXT: path });
 const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures', 'startup-trace-child.ts'), dataDir], { env });
 const stderr = child.stderr.toString();
 expect(stderr).not.toContain('ASSERTION: typed startup entry and pairs are missing');
 expect(child.exitCode).toBe(0);
 return { ...collectStartup(stderr), stderr, stdout: child.stdout.toString() };
}
test('actual initdb/start and in-process cache have one store pair per call', async () => {
 const real = join(root, 'actual-cluster'); mkdirSync(real);
 const alias = join(root, 'cluster-alias'); symlinkSync(real, alias);
 const store = join(alias, 'nested', 'real-store');
 const before = run(context, {}, join(store, 'pgdata')).records[0]!.cluster;
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'startup-trace-child.ts'), store, 'cluster'], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code).toBe(0);
 const { records, incomplete } = collectStartup(stderr);
 expect(incomplete).toEqual([]);
 const opens = records.filter(r => r.phase === 'store.open');
 expect(opens).toHaveLength(6);
 expect(opens.filter(r => r.edge === 'terminal').map(r => r.outcome)).toEqual(['ok', 'reused', 'reused']);
 for (const phase of ['cluster.initdb', 'cluster.start']) {
  const pair = records.filter(r => r.phase === phase); expect(pair).toHaveLength(2); expect(pair[1]!.outcome).toBe('ok');
 }
 const digests = records.filter(r => ['store.open','cluster.initdb','cluster.start'].includes(r.phase)).map(r => r.cluster);
 expect(digests.every(d => d !== undefined && d === digests[0] && d === before)).toBe(true);
 expect(run(context, {}, join(real, 'nested', 'real-store', 'pgdata')).records[0]!.cluster).toBe(before);
 expect(stderr + stdout).not.toContain(key);
}, 120_000);

test('real initdb command failure keeps product output and balanced error outcomes', () => {
 const bin = join(root,'failed-bin'); mkdirSync(bin);
 writeFileSync(join(bin,'initdb'), '#!/bin/sh\necho COMMAND-STDOUT-SENTINEL\necho COMMAND-STDERR-SENTINEL >&2\nexit 23\n', {mode:0o755});
 const invoke = (trace:string) => Bun.spawnSync([process.execPath,join(import.meta.dir,'fixtures','startup-trace-child.ts'),join(root,'failed-store'),'failure',bin], {
  env:{...process.env,MADARCH_TRACE:trace,MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context},
 });
 const off=invoke('off'); const on=invoke('on'); expect(on.exitCode).toBe(off.exitCode); expect(on.stdout.toString()).toBe(off.stdout.toString());
 const collected=collectStartup(on.stderr.toString()); expect(collected.incomplete).toEqual([]);
 const withoutRecords=(text:string)=>text.split('\n').filter(line=>{try{return JSON.parse(line).version!==1;}catch{return true;}}).join('\n');
 expect(withoutRecords(on.stderr.toString())).toBe(off.stderr.toString());
 for(const phase of ['store.open','cluster.initdb']) expect(collected.records.find(r=>r.phase===phase && r.edge==='terminal')!.outcome).toBe('error');
 expect(on.stdout.toString()).toContain('EXPECTED-COMMAND-FAILURE'); expect(on.stderr.toString()).not.toContain(key);
});


test('another process reuses an already answering prepared cluster',async()=>{
 const store=join(root,'shared-store'); const env={...process.env,MADARCH_TRACE:'on',MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context};
 const fixture=join(import.meta.dir,'fixtures','startup-trace-child.ts');
 const holder=Bun.spawn([process.execPath,fixture,store,'hold'],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 const error=new Response(holder.stderr).text(); const reader=holder.stdout.getReader();
 try {
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');
  const peer=Bun.spawn([process.execPath,fixture,store,'reuse'],{env,stdout:'pipe',stderr:'pipe'});
  const [exit,out,err]=await Promise.all([peer.exited,new Response(peer.stdout).text(),new Response(peer.stderr).text()]);expect(exit,out+err).toBe(0);
  const result=collectStartup(err);expect(result.incomplete).toEqual([]);
  expect(result.records.filter(r=>r.phase==='cluster.initdb')).toEqual([]);
  expect(result.records.find(r=>r.phase==='cluster.start'&&r.edge==='terminal')!.outcome).toBe('reused');
  expect(result.records.filter(r=>r.phase==='store.open')).toHaveLength(2);
 }finally{holder.stdin.write('release\n');holder.stdin.end();await reader.cancel();expect(await holder.exited).toBe(0);}
 expect(collectStartup(await error).incomplete).toEqual([]);
},120_000);
