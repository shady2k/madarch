import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';
const root = mkdtempSync(join(tmpdir(), 'startup-rpc-'));
chmodSync(root, 0o700);
const context = join(root, 'context');
writeFileSync(context, JSON.stringify({ version: 1, collection: randomUUID(), key: randomBytes(32).toString('hex') }), { mode: 0o600 });
afterAll(() => rmSync(root, { recursive: true, force: true }));
test('S3 real child RPC correlates preparation and reuse, but refuses mismatched identifiers', async () => {
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-trace-rpc.ts'), join(root, 'store'), 's3'], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, stdout + stderr).toBe(0);
 const parsed = collectStartup(stderr); expect(parsed.incomplete).toEqual([]);
 const evidence = process.env['STARTUP_FIXTURE_EVIDENCE'] ?? process.env['STARTUP_BOUNDARY_EVIDENCE'];
 if (evidence) writeFileSync(join(evidence, 'rpc.json'), JSON.stringify({ code, stdout, stderr, startupRecords: parsed.records, stderrLines: stderr.split('\n').filter(Boolean).length, stderrBytes: Buffer.byteLength(stderr), startupWrites: parsed.records.length }));
 const facts = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
 const ops = facts.filter(f => f.operation).map(f => f.operation as string);
 expect(ops.length).toBe(2); expect(ops[0]).not.toBe(ops[1]);
 for (const operation of ops) {
  const request = parsed.records.find(r => r.phase === 'schema.request' && r.operation === operation && r.edge === 'terminal')!;
  const prepare = parsed.records.find(r => r.phase === 'schema.prepare' && r.operation === operation && r.edge === 'terminal')!;
  expect(request).toBeDefined(); expect(prepare).toBeDefined();
  expect(prepare.cluster).toBe(request.cluster); expect(prepare.collection).toBe(request.collection); expect(prepare.keyId).toBe(request.keyId);
 }
 expect(parsed.records.some(r => r.phase === 'schema.prepare' && r.operation === ops[1] && r.outcome === 'reused')).toBe(true);
 expect(parsed.records.some(r => r.phase === 'schema.commit' && r.operation === ops[0] && r.outcome === 'acknowledged')).toBe(true);
 const captures = facts.filter(f => f.capturedRequest);
 const queued = facts.filter(f => f.queuedOperation).map(f => f.queuedOperation as string);
 expect(captures).toHaveLength(4);
 expect(queued).toHaveLength(2);
 expect(new Set([...ops, ...queued]).size).toBe(4);
 expect(facts).toContainEqual({ queuedReceipts: 2 });
 for (const capture of captures) {
  expect(capture.fields, 'only product request fields and startup identifiers').toEqual(['database', 'startup', 'store']);
  expect(capture.startupFields, 'no trace key or context path in RPC').toEqual(['collection', 'keyId', 'operation']);
  expect(capture.identifiersMatch).toBe(true);
  expect(capture.contextPathAbsent).toBe(true); expect(capture.keyAbsent).toBe(true);
  expect(capture.credentialAbsent).toBe(true); expect(capture.authenticated).toBe(true);
 }
 expect(captures.map(f => f.capturedOperation).sort()).toEqual([...ops, ...queued].sort());
 for (const operation of queued) {
  const request = parsed.records.filter(r => r.phase === 'schema.request' && r.operation === operation && r.edge === 'terminal');
  const prepare = parsed.records.filter(r => r.phase === 'schema.prepare' && r.operation === operation && r.edge === 'terminal');
  const commit = parsed.records.filter(r => r.phase === 'schema.commit' && r.operation === operation && r.edge === 'terminal');
  expect(request).toHaveLength(1); expect(prepare).toHaveLength(1);
  // A fresh history prepares extension/lock and history schema in separate write transactions.
  expect(commit, 'both production schema writes retain the queued request operation').toHaveLength(2);
  expect(prepare[0]!.outcome).toBe('ok'); expect(commit.map(r => r.outcome)).toEqual(['acknowledged', 'acknowledged']);
  for (const record of [prepare[0]!, ...commit]) {
   expect(record.cluster).toBe(request[0]!.cluster); expect(record.collection).toBe(request[0]!.collection); expect(record.keyId).toBe(request[0]!.keyId);
  }
 }
 // The owner serializes handlers: a queued operation cannot take the preceding operation's scope.
 const ownerPrepares = parsed.records.filter(r => r.phase === 'schema.prepare' && queued.includes(r.operation ?? ''));
 expect(ownerPrepares.map(r => r.edge)).toEqual(['begin', 'terminal', 'begin', 'terminal']);
 const mismatch = facts.find(f => f.mismatch)!; expect(mismatch.status).toBe(204);
 expect(parsed.records.some(r => r.operation === mismatch.mismatch)).toBe(false);
 expect(parsed.records.some(r => r.phase === 'schema.prepare' && r.operation === undefined && r.edge === 'terminal')).toBe(true);
}, 120_000);
