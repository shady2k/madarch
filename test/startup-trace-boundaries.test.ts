import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { createFixtureOwner, launch, observed, ready, port, until, clean, preload } from './startup-boundary-fixture.js';
const fixture = createFixtureOwner();
test('direct daemon-serve entry reports ready without a launcher', async () => {
 const f = fixture(); const p = await port(); const run = launch(f, ['daemon-serve', '--home', f.home, '--port', String(p)]);
 try { await until(async () => { try { return (await fetch(`http://127.0.0.1:${p}/api/products`)).ok; } catch { return false; } }, 'direct API response'); await until(() => observed(f).some(r => r.fillSignalReady), 'direct fill installed signal handler'); expect(collectStartup(run.snapshot()).records.some(r => r.role === 'fill' && r.edge === 'begin'), 'direct fill must emit begin before signal-ready receipt').toBe(true); }
 finally { run.child.kill('SIGTERM'); }
 const result = await run.result(); expect(result.code).toBe(0);
 const parsed = collectStartup(result.stderr, ['daemon', 'launcher', 'api', 'fill']); expect(parsed.incomplete).toEqual([]); ready(parsed.records, f, ['daemon', 'launcher', 'api', 'fill']);
}, 30_000);
test('real stop trace-off preserves bytes and touches neither file channel nor shared-clock loader', async () => {
 const f = fixture();
 const off = await launch(f, ['stop', '--home', f.home], { ...f.env, MADARCH_TRACE: 'off' }).result();
 const before = observed(f);
 expect(before.some(r => r.contextOpened || r.contextRead || r.clockLoaded)).toBe(false);
 const on = await launch(f, ['stop', '--home', f.home]).result();
 expect(off.code).toBe(on.code); expect(off.stdout).toBe(on.stdout); expect(off.stderr).toBe(clean(on.stderr));
 expect(collectStartup(off.stderr).records).toEqual([]);
 expect(observed(f).some(r => r.contextOpened)).toBe(true); expect(observed(f).some(r => r.clockLoaded)).toBe(true);
});
test('real pg_ctl Bun and synchronous executions plus unrelated children receive no private input', async () => {
 const f = fixture(); const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, 'fixtures', 'startup-boundary-privacy.ts'), join(f.folder, 'stores', 'sample', 'graph'), join(f.folder, 'stores')], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
 const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, out + err).toBe(0);
 const receipts = observed(f); const commands = receipts.filter(r => r.kind && (r.pgctl || r.unrelated));
 expect(commands.some(r => r.pgctl && r.kind === 'bun')).toBe(true); expect(commands.some(r => r.pgctl && r.kind === 'sync')).toBe(true);
 expect(receipts.some(r => r.unrelatedRan)).toBe(true); expect(commands.some(r => r.unrelated && r.kind === 'unrelated')).toBe(true);
 for (const r of commands) expect(r, 'child effective environment and argv must contain neither context path nor key').toMatchObject({ pathAbsent: true, keyAbsent: true });
 expect(JSON.stringify(receipts)).not.toContain(f.key); expect(JSON.stringify(receipts)).not.toContain(f.context);
 expect(collectStartup(err).incomplete).toEqual([]);
}, 60_000);

test('real empty fill entry writes begin before forced loss and collector reports missing terminal', async () => {
 const f = fixture(); const run = launch(f, ['--role', 'fill', '--home', f.home]);
 try { await until(() => observed(f).some(r => r.fillSignalReady), 'fill signal-ready receipt'); expect(collectStartup(run.snapshot()).records.some(r => r.role === 'fill' && r.edge === 'begin'), 'live fill entry must emit begin before signal-ready receipt').toBe(true); }
 finally { run.child.kill('SIGKILL'); }
 const result = await run.result(); const parsed = collectStartup(result.stderr);
 ready(parsed.records, f, ['fill']); expect(parsed.incomplete).toContain('unmatched begin');
 expect(parsed.records.some(r => r.edge === 'terminal')).toBe(false);
}, 15_000);
test('real API early argument error closes its role pair without changing error output', async () => {
 const f = fixture(); const args = ['--role', 'api', 'serve', '--not-a-flag'];
 const on = await launch(f, args).result(); const off = await launch(f, args, { ...f.env, MADARCH_TRACE: 'off' }).result();
 expect(on.code).not.toBe(0); expect(on.code).toBe(off.code); expect(on.stdout).toBe(off.stdout); expect(clean(on.stderr)).toBe(off.stderr);
 const parsed = collectStartup(on.stderr, ['api']); expect(parsed.incomplete).toEqual([]); ready(parsed.records, f, ['api']);
 expect(parsed.records.some(r => r.phase === 'role.api' && r.edge === 'terminal' && r.outcome === 'error')).toBe(true);
});

test('foreign UID is rejected independently of regular-file and private-mode validation', async () => {
 const f = fixture('foreign-uid'); const on = await launch(f, ['stop', '--home', f.home]).result();
 const off = await launch(f, ['stop', '--home', f.home], { ...f.env, MADARCH_TRACE: 'off' }).result();
 expect(on.code).toBe(off.code); expect(on.stdout).toBe(off.stdout); expect(clean(on.stderr)).toBe(off.stderr);
 expect(observed(f).filter(r => r.foreignUid)).toEqual([{ foreignUid: true, regular: true, privateMode: true }]);
 const parsed = collectStartup(on.stderr); expect(parsed.incomplete).toEqual([]); expect(parsed.records.length).toBeGreaterThan(0);
 for (const r of parsed.records) { expect(r.context).toBe('invalid'); expect(r.collection).toBeUndefined(); expect(r.keyId).toBeUndefined(); expect(r.cluster).toBeUndefined(); }
});
