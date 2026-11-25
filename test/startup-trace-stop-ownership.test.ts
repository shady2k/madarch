import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
test('S2 in-process owner skips without a sampled identity or command', async () => {
 const { stop, facts } = await run('in-process-owner');
 expect(stop!.outcome).toBe('skipped'); expect(stop!.identity).toBe('unknown');
 expect(stop!.postmasterPid).toBeUndefined(); expect(stop!.command).toBe('none');
 expect(facts.find(f => f.action === 'end').procReads).toBe(0);
 expect(facts.find(f => 'afterExternal' in f).afterExternal.pid).toBe(facts[0].external.pid);
}, 120_000);
test('S2 remaining lease emits no stop attempt', async () => {
 const { records, facts } = await run('lease-release');
 // Only finally's real shutdown emits a stop. The remaining lease releases no pair.
 expect(records.filter(r => r.phase === 'cluster.stop' && r.edge === 'begin')).toHaveLength(1);
 expect(facts.find(f => f.action === 'end').procReads).toBe(1); // cached-open identity only
}, 120_000);

for (const mode of ['users-busy', 'start-busy']) test(`S2 ${mode}: real contested lock takes precedence`, async () => {
 const { stop, facts } = await run(mode);
 expect(stop!.outcome).toBe('skipped'); expect(stop!.identity).toBe('unknown');
 expect(stop!.postmasterPid).toBeUndefined(); expect(stop!.command).toBe('none');
 expect(facts.find(f => f.action === 'end').procReads).toBe(0);
 expect(facts.find(f => 'afterExternal' in f).afterExternal.pid).toBe(facts[0].external.pid);
 expect(facts).toContainEqual({ lockReleased: true });
 expect(facts.find(f => f.commands).commands.split('\n').filter((line: string) => line === 'launched'), 'no command under contested lock').toHaveLength(1); // lease-return preparation only
}, 120_000);

test('S2 synchronous early exit without pg_ctl emits no stop pair', async () => {
 const { records, facts } = await run('sync-no-command');
 expect(records.filter(r => r.phase === 'cluster.stop' && r.edge === 'begin')).toHaveLength(2); // lease release and cleanup only
 expect(facts.find(f => f.action === 'end').procReads).toBe(0);
}, 120_000);
