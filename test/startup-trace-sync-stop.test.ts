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
test('S2 sync SIGSTOP is unresponsive, never verified from its pidfile', async () => {
 const { records, facts } = await run('sync-sigstop');
 const stops = records.filter(r => r.phase === 'cluster.stop' && r.edge === 'terminal' && r.holder === 'held');
 const stop = stops.find(r => r.probe === 'failed')!;
 expect(stop, 'missing failed existing probe on SIGSTOP').toBeDefined();
 expect(stop.outcome).toBe('unresponsive');
 expect(stop.identity, 'sync SIGSTOP pidfile must not verify').toBe('observed');
 expect(stop.command).toBe('none'); expect(stop.signal).toBe('none');
 expect(facts).toContainEqual({ resumed: true });
}, 120_000);
test('S2 sync positive probe verifies the stable old process pair', async () => {
 const { records } = await run('sync-positive');
 const stop = records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal' && r.probe === 'answered' && r.identity === 'verified')!;
 expect(stop, 'missing stable pair verification across actual directory probe').toBeDefined();
 expect(stop.code).toBe(0); expect(stop.holder).toBe('gone'); expect(stop.outcome).toBe('stopped');
}, 120_000);
