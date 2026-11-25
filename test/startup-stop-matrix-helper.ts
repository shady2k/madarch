import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';
export async function run(mode: string, trace = true) {
 const root = mkdtempSync(join(tmpdir(), 'stop-matrix-'));
 chmodSync(root, 0o700);
 try {
 const context = join(root, 'context');
 writeFileSync(context, JSON.stringify({ version: 1, collection: randomUUID(), key: randomBytes(32).toString('hex') }), { mode: 0o600 });
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-stop-matrix.ts'), join(root, mode, 'graph'), mode], {
  env: { ...process.env, MADARCH_TRACE: trace ? 'on' : 'off', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 const lines = stderr.split('\n').filter(line => line.includes('"phase":"cluster.') || line.includes('"phase":"store.open"'));
 const observation = { code, stdout, stderr, startupLines: lines.length, startupBytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0), completeStartupRecords: lines.length };
 if (process.env['STARTUP_FIXTURE_EVIDENCE']) writeFileSync(join(process.env['STARTUP_FIXTURE_EVIDENCE']!, `${mode}${trace ? '' : '-off'}.json`), JSON.stringify(observation));
 expect(code, stdout + stderr).toBe(0);
 const result = collectStartup(stderr); expect(result.incomplete).toEqual([]);
 const subject = result.records.find(r => r.phase === 'cluster.start' && r.edge === 'terminal')!;
 const all = result.records.filter(r => r.phase === 'cluster.stop' && r.edge === 'terminal' && r.cluster === subject?.cluster);
 // Cleanup is a separate real stop. Sync preparation gives back the lease first.
 const stop = all[mode.startsWith('sync-') || ['absent', 'users-busy', 'start-busy', 'reclaim', 'pre-reclaim'].includes(mode) ? 1 : 0];
 const facts = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
 const writes = facts.find(f => 'startupWrites' in f);
 const startupLines = stderr.split('\n').filter(line => { try { const record = JSON.parse(line); return record.version === 1 && typeof record.phase === 'string'; } catch { return false; } });
 expect(writes.startupWrites, 'actual startup synchronous writes equal collected complete records').toBe(startupLines.length);
 expect(writes.startupWriteBytes, 'actual startup synchronous bytes equal collected line bytes').toBe(startupLines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0));
 return { stop, facts, records: result.records };
 } finally { rmSync(root, { recursive: true, force: true }); }
}
