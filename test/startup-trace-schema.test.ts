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
 const child = Bun.spawn([process.execPath, join(import.meta.dir, mode === 'responses' ? 'fixtures/startup-schema-responses.ts' : 'fixtures/startup-slices.ts'), join(root, mode, 'graph'), mode], {
  env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
 });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, stdout + stderr).toBe(0);
 const evidence = process.env['STARTUP_FIXTURE_EVIDENCE'] ?? process.env['STARTUP_BOUNDARY_EVIDENCE'];
 if (evidence) writeFileSync(join(evidence, `${mode}.json`), JSON.stringify({ code, stdout, stderr, stderrLines: stderr.split('\n').filter(Boolean).length, stderrBytes: Buffer.byteLength(stderr), startupWrites: stderr.split('\n').filter(line => line.startsWith('{') && line.includes('\"version\":1') && line.includes('\"edge\":')).length }));
 const result = collectStartup(stderr); expect(result.incomplete).toEqual([]);
 const facts = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
 return { ...result, facts };
}
test('S3 real commit, callback rollback, deferred server rejection and read-only exclusion', async () => {
 const { records, facts } = await run('schema');
 const commits = records.filter(r => r.phase === 'schema.commit' && r.edge === 'terminal');
 expect(commits.map(r => r.outcome), 'write commit acknowledgement and server rejection').toEqual(['acknowledged','error']);
 expect(records.filter(r => r.phase === 'schema.rollback' && r.edge === 'terminal').map(r => r.outcome)).toEqual(['acknowledged','acknowledged']);
 expect(facts).toContainEqual({ committed: true });
 expect(facts).toContainEqual({ original: true });
 expect(facts).toContainEqual({ severity: 'ERROR', code: '23503' });
 expect(facts).toContainEqual({ rollbackAbsent: true });
}, 120_000);

test('S3 dispatched COMMIT with response transport cut stays unknown despite persistence', async () => {
 const { records, facts } = await run('lost-ack');
 expect(facts).toContainEqual({ commitDispatched: true, ackPaused: true });
 expect(facts).toContainEqual({ independentlyPersisted: true });
 expect(facts).toContainEqual({ connectionException: true, sameException: true });
 const commit = records.find(r => r.phase === 'schema.commit' && r.edge === 'terminal')!;
 expect(commit, 'missing lost-ack commit terminal').toBeDefined();
 expect(commit.outcome, 'lost acknowledgement cannot be rejection or success').toBe('unknown');
 expect(records.some(r => r.phase === 'schema.rollback' && r.edge === 'terminal' && r.outcome === 'unknown')).toBe(true);
}, 120_000);

test('S3 controlled actual-client responses preserve classification, exceptions and release', async () => {
 const { records, facts } = await run('responses');
 const outcomes: Record<string, string> = {
  'error-rejection': 'error', 'statement-unknown': 'unknown', 'connection-failure': 'unknown',
  'protocol-failure': 'unknown', fatal: 'unknown', panic: 'unknown', 'missing-severity': 'unknown',
  'missing-code': 'unknown', disconnect: 'unknown', 'rollback-tag': 'unknown', 'other-tag': 'unknown', 'missing-tag': 'unknown',
 };
 expect(facts).toHaveLength(14);
 for (const [operation, outcome] of Object.entries(outcomes)) {
  const commits = records.filter(r => r.operation === operation && r.phase === 'schema.commit' && r.edge === 'terminal');
  expect(commits.map(r => r.outcome), operation).toEqual([outcome]);
 }
 for (const fact of facts as { responseCase: string; controlledResponse: boolean; commitCalls: number; rollbackCalls: number; sameException: boolean; releases: number; releasePreserved: boolean }[]) {
  expect(fact.controlledResponse, 'synthetic response receipt is not a persistence observation').toBe(true);
  const isRollback = fact.responseCase.startsWith('rollback-') && fact.responseCase !== 'rollback-tag';
  const isTag = ['rollback-tag', 'other-tag', 'missing-tag'].includes(fact.responseCase);
  expect(fact.commitCalls, fact.responseCase).toBe(isRollback ? 0 : 1);
  expect(fact.rollbackCalls, fact.responseCase).toBe(isTag ? 0 : 1);
  expect(fact.sameException, fact.responseCase).toBe(!isTag);
  expect(fact.releases, fact.responseCase).toBe(1);
  expect(fact.releasePreserved, fact.responseCase).toBe(true);
  const rollbacks = records.filter(r => r.operation === fact.responseCase && r.phase === 'schema.rollback' && r.edge === 'terminal');
  expect(rollbacks.map(r => r.outcome), fact.responseCase).toEqual(isTag ? [] : [isRollback ? 'unknown' : 'acknowledged']);
  if (isRollback) expect(records.some(r => r.operation === fact.responseCase && r.phase === 'schema.commit')).toBe(false);
 }
}, 120_000);
