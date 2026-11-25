import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup, comparableCluster, comparableTime } from './startup-trace-collector.js';
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
test('ready context emits balanced ordered records without private inputs', () => {
 const result = run(context); expect(result.incomplete).toEqual([]); expect(result.records).toHaveLength(2);
 const [a, b] = result.records;
 expect(a).toMatchObject({ version: 1, context: 'ready', role: 'fixture', sequence: 1, collection, edge: 'begin' });
 expect(b).toMatchObject({ sequence: 2, edge: 'terminal', outcome: 'ok', pair: a!.pair });
 expect(BigInt(a!.ns)).toBeLessThanOrEqual(BigInt(b!.ns));
 for (const secret of [key, context, root]) expect(result.stderr).not.toContain(secret);
});
test('Linux timestamp lies inside an independent uptime bracket', () => {
 const before = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]); const { records } = run(context);
 const after = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
 expect(records[0]!.clock).toBe('boottime');
 for (const record of records) {
  expect(BigInt(record.ns) >= BigInt(Math.floor((before - 0.01) * 1e9))).toBe(true);
  expect(BigInt(record.ns) <= BigInt(Math.ceil((after + 0.01) * 1e9))).toBe(true);
  expect(record.startTicks).toMatch(/^\d+$/);
 }
});
test('independent processes agree on context and missing cluster identity', () => {
 const a = run(context).records[0]!; const b = run(context).records[0]!;
 expect(a.pid).not.toBe(b.pid); expect(a.instance).not.toBe(b.instance);
 expect(comparableTime(a,b)).toBe(true); expect(comparableCluster(a,b)).toBe(true); expect(a.cluster).toBe(b.cluster);
});
test('same collection with different keys refuses cluster comparison', () => {
 const other = join(root, 'other'); writeFileSync(other, JSON.stringify({ version: 1, collection, key: randomBytes(32).toString('hex') }), { mode: 0o600 });
 const a = run(context).records[0]!; const b = run(other).records[0]!;
 expect(a.collection).toBe(b.collection); expect(a.keyId).not.toBe(b.keyId); expect(comparableCluster(a,b)).toBe(false);
});
test('unset context has no generated identifiers', () => {
 for (const r of run().records) { expect(r.context).toBe('absent'); expect(r.collection).toBeUndefined(); expect(r.keyId).toBeUndefined(); expect(r.cluster).toBeUndefined(); }
});
for (const variant of ['missing', 'relative', 'symlink', 'permissions', 'oversized', 'malformed', 'version', 'uuid', 'key']) {
 test(`context validation refuses ${variant}`, () => {
  const path = join(root, variant);
  if (variant === 'symlink') symlinkSync(context, path);
  else if (variant !== 'missing' && variant !== 'relative') {
   const contents = variant === 'oversized' ? 'x'.repeat(4097) : variant === 'malformed' ? '{' : JSON.stringify({ version: variant === 'version' ? 2 : 1, collection: variant === 'uuid' ? 'bad' : collection, key: variant === 'key' ? 'bad' : key });
   writeFileSync(path, contents, { mode: variant === 'permissions' ? 0o644 : 0o600 });
  }
  for (const r of run(variant === 'relative' ? 'relative' : path).records) {
   expect(r.context).toBe('invalid'); expect(r.collection).toBeUndefined(); expect(r.keyId).toBeUndefined(); expect(r.cluster).toBeUndefined();
  }
 });
}
test('trace off takes precedence', () => { const result = run(context, { MADARCH_TRACE: 'off' }); expect(result.stderr).toBe(''); expect(result.records).toEqual([]); });
test('symlink ancestor identity agrees before and after creation', () => {
 const actual = join(root, 'actual'); mkdirSync(actual); const link = join(root, 'link'); symlinkSync(actual, link);
 const nested = join(link, 'nested', 'pgdata'); const a = run(context, {}, nested).records[0]!;
 mkdirSync(nested, { recursive: true }); const b = run(context, {}, nested).records[0]!; const c = run(context, {}, join(actual, 'nested', 'pgdata')).records[0]!;
 expect(a.cluster).toBeDefined(); expect(a.cluster).toBe(b.cluster); expect(a.cluster).toBe(c.cluster);
});
test('collector reports incomplete streams and refuses differing scales', () => {
 const { records } = run(context); const a = records[0]!; const b = records[1]!;
 expect(collectStartup(JSON.stringify(a)+'\n').incomplete).toContain('unmatched begin');
 expect(collectStartup([a,b].map(x=>JSON.stringify(x)).join('\n')).incomplete).toContain('partial line');
 expect(collectStartup([a,a,b].map(x=>JSON.stringify(x)).join('\n')+'\n').incomplete).toContain('duplicate begin');
 expect(comparableCluster({...a, collection:undefined, keyId:undefined}, {...b, collection:undefined, keyId:undefined})).toBe(false);
 expect(collectStartup('{"version":1').incomplete).toContain('partial line');
 expect(collectStartup(JSON.stringify({...a, sequence: 2})+'\n').incomplete).toContain('sequence gap');
 expect(collectStartup([a,{...b,clock:'process'}].map(x => JSON.stringify(x)).join('\n')).incomplete).toContain('clock changed');
 expect(comparableTime(a,{...b,instance:'other',clock:'process'})).toBe(false);
});


async function receiptReader(stream: ReadableStream<Uint8Array>) {
 const reader = stream.getReader(); let pending = '';
 return async (): Promise<Record<string, string | number>> => {
  for (;;) {
   const at = pending.indexOf('\n');
   if (at !== -1) { const line = pending.slice(0, at); pending = pending.slice(at + 1); return JSON.parse(line); }
   const chunk = await reader.read(); if (chunk.done) throw new Error(`missing causal receipt: ${pending}`);
   pending += new TextDecoder().decode(chunk.value);
  }
 };
}
function causal(mode: string) {
 return Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'startup-trace-causal.ts'), mode], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
 });
}
function release(child: ReturnType<typeof causal>) { child.stdin.write('release\n'); child.stdin.flush(); }
function assertCausal(records: ReturnType<typeof collectStartup>['records']) {
 const begin = records.find(r => r.phase === 'parent' && r.edge === 'begin')!;
 const end = records.find(r => r.phase === 'parent' && r.edge === 'terminal')!;
 const child = records.find(r => r.phase === 'child' && r.edge === 'begin')!;
 expect(comparableTime(begin, child)).toBe(true); expect(comparableTime(child, end)).toBe(true);
 expect(BigInt(begin.ns)).toBeLessThanOrEqual(BigInt(child.ns)); expect(BigInt(child.ns)).toBeLessThanOrEqual(BigInt(end.ns));
}
test('real parent and child use causal begin and emission barriers', async () => {
 const parent = causal('parent'); const stderr = new Response(parent.stderr).text(); const next = await receiptReader(parent.stdout);
 const childReady = await next(); expect(childReady.what).toBe('ready');
 expect((await next()).what).toBe('parent-ready'); release(parent);
 expect((await next()).what).toBe('parent-begin'); const emitted = await next(); expect(emitted.what).toBe('emitted');
 expect((await next()).what).toBe('parent-terminal'); expect(await parent.exited).toBe(0);
 const result = collectStartup(await stderr); expect(result.incomplete).toEqual([]); assertCausal(result.records);
 const child = result.records.find(r => r.phase === 'child')!; expect(child.startTicks).toBe(String(emitted.ticks));
 expect(BigInt(child.startTicks!) * 1_000_000_000n / BigInt((child as unknown as { ticksPerSecond: string }).ticksPerSecond)).toBeLessThanOrEqual(BigInt(child.ns));
}, 120_000);
test('independent processes use controller-owned emission and terminal barriers', async () => {
 const older = causal('older'); const olderr = new Response(older.stderr).text(); const oldnext = await receiptReader(older.stdout); await oldnext();
 const younger = causal('mark'); const youngerr = new Response(younger.stderr).text(); const youngnext = await receiptReader(younger.stdout); await youngnext();
 release(older); const oldmark = await oldnext(); expect(oldmark.what).toBe('emitted');
 release(younger); const youngmark = await youngnext(); expect(youngmark.what).toBe('emitted'); expect(await younger.exited).toBe(0);
 release(older); expect(await older.exited).toBe(0);
 const a = collectStartup(await olderr); const b = collectStartup(await youngerr); expect(a.incomplete).toEqual([]); expect(b.incomplete).toEqual([]);
 assertCausal([...a.records,...b.records]);
 expect(a.records[0]!.startTicks).toBe(String(oldmark.ticks)); expect(b.records[0]!.startTicks).toBe(String(youngmark.ticks));
 for (const record of [a.records[0]!,b.records[0]!]) expect(BigInt(record.startTicks!) * 1_000_000_000n / BigInt((record as unknown as {ticksPerSecond:string}).ticksPerSecond)).toBeLessThanOrEqual(BigInt(record.ns));
}, 120_000);

test('init diagnostic preserves failing exit and separately names both sentinel streams', () => {
 const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures', 'init-language-diagnostic.ts')], { env: { ...process.env } });
 const err = child.stderr.toString(); expect(child.exitCode).not.toBe(0);
 expect(err).toContain('status=7'); expect(err).toContain('init child stdout:\nSTDOUT-SENTINEL');
 expect(err).toContain('init child stderr:\nSTDERR-SENTINEL'); expect(err).toContain('original status assertion');
});

test('authenticated independent RPC preserves distinct operations and refuses mismatched context correlation', async () => {
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'startup-trace-rpc.ts'), join(root, 'rpc-store')], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(exit).toBe(0); const receipts = stdout.trim().split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
 const { records, incomplete } = collectStartup(stderr); expect(incomplete).toEqual([]);
 const owners = records.filter(r=>r.phase==='schema.prepare' && r.edge==='terminal'); expect(owners).toHaveLength(3);
 expect(records.filter(r=>r.phase==='store.open')).toHaveLength(2);
 expect(owners.map(r=>r.outcome)).toEqual(['ok','reused','reused']);
 for (const receipt of receipts.slice(0,2)) {
  const matched = records.filter(r=>(r as unknown as {operation:string}).operation === receipt.operation);
  expect(matched.some(r=>r.phase==='client.prepare')).toBe(true); expect(matched.some(r=>r.phase==='schema.prepare')).toBe(true);
  expect(new Set(matched.map(r=>r.cluster)).size).toBe(1); expect(matched.every(r=>r.collection===collection)).toBe(true);
 }
 expect(receipts[0].operation).not.toBe(receipts[1].operation);
 expect(receipts[2].status).toBe(204);
 expect(records.some(r=>(r as unknown as {operation:string}).operation === receipts[2].mismatch)).toBe(false);
 expect(owners[2]!.context).toBe('ready');
 expect(stderr).not.toContain(key); expect(stderr).not.toContain(context);
}, 120_000);

test('actual independent stop and serve entries receive the same context before early refusal', async () => {
 const home = join(root, 'entry-home'); mkdirSync(home);
 const app = join(root, 'entry-app'); mkdirSync(app); writeFileSync(join(app,'index.html'), '<title>fixture</title>');
 const env = { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context, MADARCH_HOME: home, MADARCH_APP_DIST: app, MADARCH_OWN_WIKI: 'off' };
 const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
 const stop = Bun.spawnSync([process.execPath, cli, 'stop', '--home', home], { env });
 expect(stop.exitCode).toBe(0);
 const serve = Bun.spawnSync([process.execPath, cli, 'serve', '--home', home, '--product', join(root,'not-a-product'), '--port','0'], { env });
 const a = collectStartup(stop.stderr.toString()).records.filter(r=>r.phase==='command.stop');
 const b = collectStartup(serve.stderr.toString()).records.filter(r=>r.phase==='command.serve');
 expect(a).toHaveLength(2); expect(b).toHaveLength(2);
 expect(a[0]).toMatchObject({ context:'ready', collection }); expect(b[0]).toMatchObject({ context:'ready', collection, keyId:a[0]!.keyId });
}, 120_000);
test('actual idle fill role reports context and emits begin before it is stopped', async () => {
 const home = join(root,'idle-fill'); mkdirSync(home);
 const child = Bun.spawn([process.execPath, join(import.meta.dir,'..','scripts','madarch.ts'),'--role','fill','--home',home], {
  env: { ...process.env, MADARCH_TRACE:'on', MADARCH_STARTUP_TIMING:'1', MADARCH_STARTUP_CONTEXT:context, MADARCH_HOME:home, MADARCH_OWN_WIKI:'off' }, stdout:'pipe',stderr:'pipe',
 });
 let text = ''; const reader = child.stderr.getReader();
 while (!collectStartup(text).records.some(r=>r.phase==='role.fill' && r.edge==='begin')) {
  const chunk = await reader.read(); if (chunk.done) throw new Error(`fill missing begin: ${text}`); text+=new TextDecoder().decode(chunk.value);
 }
 expect(collectStartup(text).records[0]).toMatchObject({ role:'fill', context:'ready', collection });
 child.kill('SIGTERM');
 for (;;) { const chunk=await reader.read(); if(chunk.done) break; text+=new TextDecoder().decode(chunk.value); }
 await child.exited; await new Response(child.stdout).text();
 expect(collectStartup(text,['fill','api']).incomplete).toContain('missing child stream: api');
},120_000);

test('FIFO validation completes without a writer and foreign UID file is invalid', () => {
 const fifo=join(root,'fifo'); expect(Bun.spawnSync(['mkfifo',fifo],{env:{...process.env}}).exitCode).toBe(0);
 expect(run(fifo).records[0]!.context).toBe('invalid');
 expect(run('/etc/passwd').records[0]!.context).toBe('invalid');
});
test('Windows file boundary reports unavailable without identifiers', () => {
 const child=Bun.spawnSync([process.execPath,join(import.meta.dir,'fixtures','startup-trace-child.ts'),'unused','windows'],{
  env:{...process.env,MADARCH_TRACE:'on',MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context},
 });
 expect(child.exitCode).toBe(0); const records=collectStartup(child.stderr.toString()).records;
 expect(records).toHaveLength(2); expect(records[0]).toMatchObject({context:'unavailable',clock:'process'}); expect(records[0]!.collection).toBeUndefined();
});

test('overlapping operations retain their own operation and trace identities', async () => {
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures','startup-trace-overlap.ts'),join(root,'overlap')],{
  env:{...process.env,MADARCH_TRACE:'on',MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context},stdout:'pipe',stderr:'pipe',
 });
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]); expect(exit).toBe(0);
 const ids=JSON.parse(out);const result=collectStartup(err);expect(result.incomplete).toEqual([]);expect(result.records).toHaveLength(4);
 const records=result.records as (typeof result.records[number] & {operation:string;traceId:string;spanId:string})[];
 expect(records.map(r=>r.operation)).toEqual([ids.a,ids.b,ids.b,ids.a]);
 expect(records[0]!.traceId).toBe(records[3]!.traceId);expect(records[1]!.traceId).toBe(records[2]!.traceId);
 expect(records[0]!.traceId).not.toBe(records[1]!.traceId);expect(records.every(r=>r.traceId.length===32 && r.spanId.length===16)).toBe(true);
});
test('unrecognized CLI input is not copied into startup metadata', () => {
 const sentinel='PRIVATE-UNRECOGNIZED-INPUT';
 const child=Bun.spawnSync([process.execPath,join(import.meta.dir,'..','scripts','madarch.ts'),sentinel],{env:{...process.env,MADARCH_TRACE:'on',MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context}});
 const records=collectStartup(child.stderr.toString()).records;expect(records).toHaveLength(2);expect(JSON.stringify(records)).not.toContain(sentinel);
});

test('shared clock failure emits process samples and refuses independent process ordering', () => {
 const env = { ...process.env, MADARCH_TRACE:'on', MADARCH_STARTUP_TIMING:'1', MADARCH_STARTUP_CONTEXT:context };
 const fixture = join(import.meta.dir,'fixtures','startup-trace-child.ts');
 const preload = join(import.meta.dir,'fixtures','startup-trace-clock-failure.ts');
 const children = [0,1].map(() => Bun.spawnSync([process.execPath,'--preload',preload,fixture], { env }));
 for(const child of children) expect(child.exitCode).toBe(0);
 const streams = children.map(child => collectStartup(child.stderr.toString()));
 for(const stream of streams){
  expect(stream.incomplete).toEqual([]); expect(stream.records).toHaveLength(2);
  for(const record of stream.records){expect(record.clock).toBe('process');expect(record.domain).toBeUndefined();}
 }
 const a=streams[0]!.records[0]!,b=streams[1]!.records[0]!;
 expect(a.pid).not.toBe(b.pid);expect(a.instance).not.toBe(b.instance);
 expect(comparableTime(a,b)).toBe(false);
});

test('trace sink failure preserves product output and successful exit',()=>{
 const child=Bun.spawnSync([process.execPath,join(import.meta.dir,'fixtures','startup-trace-write-failure.ts')],{env:{...process.env,MADARCH_TRACE:'on',MADARCH_STARTUP_TIMING:'1',MADARCH_STARTUP_CONTEXT:context}});
 expect(child.exitCode).toBe(0);expect(child.stdout.toString()).toBe('UNCHANGED-PRODUCT-OUTPUT\n');expect(child.stderr.toString()).toBe('');
});
