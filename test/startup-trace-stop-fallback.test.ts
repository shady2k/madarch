import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
// The pid file's own identity is a fallback for a postmaster that cannot answer, and it attests nothing about an answer:
// the stop that proceeds on it records the failed probe and an observed identity, never `answered` and `verified`
// (madarch-64o5.74, S2 `cluster.stop`).
test('S2 sync stop records a file-identity fallback as a failed probe, never an answer', async () => {
 const { stop, facts, records } = await run('sync-fallback');
 expect(stop, 'sync-fallback stop terminal').toBeDefined();
 expect(stop!.probe, 'psql did not answer').toBe('failed');
 expect(stop!.identity, 'the pid file identifies the postmaster, it does not verify an answer').toBe('observed');
 // The product behaviour is unchanged: the verified postmaster is stopped by its own command.
 expect(stop!.outcome).toBe('stopped');
 expect(stop!.holder).toBe('gone');
 expect(stop!.command).toBe('exit');
 expect(stop!.code).toBe(0);
 expect(stop!.signal).toBe('none');
 expect(stop!.postmasterPid).toBe(facts[0].external.pid);
 expect(stop!.postmasterTicks).toBe(facts[0].external.ticks);
 expect(facts.find(f => f.commands)?.commands, 'pg_ctl stop was run').toContain('launched');
 expect(facts.find(f => 'probes' in f)?.probes, 'the probe was asked once').toBe(1);
 expect(records.filter(r => r.phase === 'cluster.stop' && r.edge === 'terminal' && r.identity === 'verified'), 'no stop of this fixture verified an identity').toEqual([]);
}, 120_000);
