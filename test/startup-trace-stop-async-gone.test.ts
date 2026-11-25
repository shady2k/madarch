import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
for (const [mode, outcome, holder, code, identity, probe, signal] of [
 ['gone-zero', 'stopped', 'gone', 0, 'observed', 'skipped', 'none'],
 ['cluster-gone-zero', 'stopped', 'gone', 0, 'observed', 'answered', 'none'],
 ['gone-nonzero', 'unknown', 'gone', 7, 'observed', 'skipped', 'none'],
 ['released', 'unknown', 'released', 0, 'observed', 'skipped', 'none'],
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
