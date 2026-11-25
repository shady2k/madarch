import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
for (const [mode, outcome, holder, code, identity, probe, signal] of [
 ['sync-positive', 'stopped', 'gone', 0, 'verified', 'answered', 'none'],
 ['sync-term', 'unknown', 'gone', 1, 'verified', 'answered', 'term'],
] as const) test(`S2 matrix ${mode}: independent holder and command facts`, async () => {
 const { stop, facts } = await run(mode);
 expect(stop, `${mode} stop terminal`).toBeDefined();
 expect(stop!.outcome, `${mode} outcome`).toBe(outcome);
 expect(stop!.holder, `${mode} holder`).toBe(holder);
 expect(stop!.code, `${mode} command code`).toBe(code);
 expect(stop!.identity, `${mode} identity grade`).toBe(identity);
 expect(stop!.probe, `${mode} existing probe`).toBe(probe);
 expect(stop!.signal, `${mode} product signal`).toBe(signal);
 expect(stop!.postmasterPid).toBe(facts[0].external.pid);
 expect(stop!.postmasterTicks).toBe(facts[0].external.ticks);
 if (mode.includes('sigstop')) { expect(facts).toContainEqual({ sigstopObserved: true }); expect(facts).toContainEqual({ resumed: true }); }
 if (mode.includes('gone')) expect(facts.find(f => f.commands)?.commands).toContain('"gone":true');
}, 120_000);

test('S2 trace-off leaves existing probe and command invocation counts unchanged', async () => {
 const enabled = await run('sync-positive');
 const disabled = await run('sync-positive', false);
 expect(disabled.records).toHaveLength(0);
 expect(disabled.facts.find(f => 'startupWrites' in f).sampleProcReads).toBe(0);
 expect(disabled.facts.find(f => 'startupWrites' in f).samplePidReads).toBe(0);
 expect(enabled.facts.find(f => 'startupWrites' in f).sampleProcReads).toBe(2);
 expect(enabled.facts.find(f => 'startupWrites' in f).samplePidReads).toBe(4);
 expect(enabled.facts.find(f => f.probes).probes).toBe(1);
 expect(disabled.facts.find(f => f.probes).probes).toBe(1);
 const commands = (facts: { commands?: string }[]) => facts.find(f => f.commands)!.commands!.split('\n').filter(line => line === 'launched').length;
 expect(commands(enabled.facts)).toBe(2);
 expect(commands(disabled.facts)).toBe(2);
}, 120_000);
