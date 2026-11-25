import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';
const root = mkdtempSync(join(tmpdir(), 'startup-slices-'));
chmodSync(root, 0o700);
const context = join(root, 'context');
writeFileSync(context, JSON.stringify({ version: 1, collection: randomUUID(), key: randomBytes(32).toString('hex') }), { mode: 0o600 });
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(mode: string) {
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-slices.ts'), join(root, mode, 'graph'), mode], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, stdout + stderr).toBe(0);
 if (process.env['STARTUP_FIXTURE_EVIDENCE']) writeFileSync(join(process.env['STARTUP_FIXTURE_EVIDENCE']!, `${mode}.json`), JSON.stringify({ code, stdout, stderr }));
 const result = collectStartup(stderr); expect(result.incomplete).toEqual([]);
 const facts = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
 return { ...result, facts };
}
test('S2 fresh start is observed against independently sampled PID and ticks', async () => {
 const { records, facts } = await run('exit');
 const start = records.find(r => r.phase === 'cluster.start' && r.edge === 'terminal')!;
 expect(start, 'missing cluster.start terminal').toBeDefined();
 expect(start.identity, 'start pidfile must not verify').toBe('observed');
 expect(start.postmasterPid).toBe(facts[0].external.pid);
 expect(start.postmasterTicks).toBe(facts[0].external.ticks);
 const stopped = records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal')!;
 expect(stopped.identity, 'async stop pidfile must not verify').toBe('observed');
 expect(stopped.postmasterPid).toBe(start.postmasterPid);
 expect(stopped.postmasterTicks).toBe(start.postmasterTicks);
 expect(stopped.code).toBe(0);
 expect(['stopped','unknown']).toContain(stopped.outcome!);
 if (stopped.outcome === 'stopped') expect(stopped.holder).toBe('gone');
}, 120_000);
test('S2 independent reuse is observed and shares context and cluster', async () => {
 const { records, facts } = await run('reuse');
 const starts = records.filter(r => r.phase === 'cluster.start' && r.edge === 'terminal');
 expect(starts).toHaveLength(2);
 expect(starts[1]!.outcome).toBe('reused');
 expect(starts[1]!.postmasterPid, 'reuse external PID').toBe(facts[0].external.pid);
 expect(starts[1]!.postmasterTicks, 'reuse external ticks').toBe(facts[0].external.ticks);
 expect(starts[1]!.identity, 'reuse pidfile must not verify').toBe('observed');
 for (const field of ['collection','keyId','cluster','postmasterPid','postmasterTicks'] as const) expect(starts[1]![field]).toBe(starts[0]![field]);
}, 120_000);
