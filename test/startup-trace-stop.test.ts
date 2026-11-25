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

for (const [mode, outcome, holder, code] of [
 ['held-zero', 'error', 'held', 0], ['held-one', 'error', 'held', 1], ['released', 'unknown', 'released', 0], ['gone-nonzero', 'unknown', 'gone', 7],
] as const) test(`S2 ${mode}: command status cannot replace holder evidence`, async () => {
 const { records } = await run(mode);
 const stop = records.find(r => r.phase === 'cluster.stop' && r.edge === 'terminal')!;
 expect(stop.outcome, `${mode} outcome`).toBe(outcome);
 expect(stop.holder, `${mode} holder`).toBe(holder);
 expect(stop.code).toBe(code);
 expect(stop.identity, 'async stop pidfile must not verify').toBe('observed');
}, 120_000);
