import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';

test('S2 stale reclaim emits observed old-pair evidence after the existing answer wait', async () => {
 const { stop, facts } = await run('reclaim');
 expect(stop!.postmasterPid).toBe(facts[0].external.pid);
 expect(stop!.postmasterTicks).toBe(facts[0].external.ticks);
 expect(stop!.identity).toBe('observed'); expect(stop!.code).toBe(0);
 expect(stop!.holder).toBe('gone'); expect(stop!.outcome).toBe('stopped');
 const reopened = facts.find(f => f.reopened).reopened;
 expect(reopened.pid !== facts[0].external.pid || reopened.ticks !== facts[0].external.ticks).toBe(true);
}, 120_000);
test('S2 answering reuse exits reclaim without a spurious stop pair', async () => {
 const { records, facts } = await run('pre-reclaim');
 expect(facts).toContainEqual({ initialAnswerForcedFailure: true });
 expect(facts).toContainEqual({ reclaimCmdlineEntry: true, cmdlineNamesDataDir: true });
 expect(facts).toContainEqual({ reclaimActualAnswer: true });
 expect(facts).toContainEqual({ existingStartRefusedLiveHolder: true });
 const entered = facts.findIndex(f => f.reclaimCmdlineEntry);
 const answered = facts.findIndex(f => f.reclaimActualAnswer);
 expect(entered).toBeGreaterThan(facts.findIndex(f => f.initialAnswerForcedFailure));
 expect(answered).toBeGreaterThan(entered);
 expect(facts.find(f => f.holderAfterReclaimReturn).holderAfterReclaimReturn.pid).toBe(facts[0].external.pid);
 expect(facts.find(f => f.holderAfterReclaimReturn).holderAfterReclaimReturn.ticks).toBe(facts[0].external.ticks);
 expect(records.filter(r => r.phase === 'cluster.stop' && r.edge === 'begin')).toHaveLength(2); // lease return and cleanup
}, 120_000);
