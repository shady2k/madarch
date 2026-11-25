import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
for (const [mode, outcome, holder, code, identity, probe, signal] of [
 ['missing-command', 'error', 'held', undefined, 'observed', 'unavailable', 'none'],
 ['launch-error', 'error', 'held', undefined, 'observed', 'skipped', 'none'],
 ['absent', 'absent', 'absent', 1, undefined, 'skipped', 'none'],
] as const) test(`S2 matrix ${mode}: independent holder and command facts`, async () => {
 const { stop, facts } = await run(mode);
 expect(stop, `${mode} stop terminal`).toBeDefined();
 expect(stop!.outcome, `${mode} outcome`).toBe(outcome);
 expect(stop!.holder, `${mode} holder`).toBe(holder);
 expect(stop!.code, `${mode} command code`).toBe(code);
 expect(stop!.identity, `${mode} identity grade`).toBe(identity);
 expect(stop!.probe, `${mode} existing probe`).toBe(probe);
 expect(stop!.signal, `${mode} product signal`).toBe(signal);
 if (identity === 'observed') {
  expect(stop!.postmasterPid).toBe(facts[0].external.pid);
  expect(stop!.postmasterTicks).toBe(facts[0].external.ticks);
 } else { expect(stop!.postmasterPid).toBeUndefined(); expect(stop!.postmasterTicks).toBeUndefined(); }
 if (mode.includes('sigstop')) { expect(facts).toContainEqual({ sigstopObserved: true }); expect(facts).toContainEqual({ resumed: true }); }
 if (mode === 'launch-error') { expect(stop!.command).toBe('launch-error'); expect(facts).toContainEqual({ launchFailed: true }); }
 if (mode === 'missing-command') expect(stop!.command).toBe('none');
 if (holder === 'held') expect(facts.find(f => 'afterExternal' in f)?.afterExternal?.pid).toBe(facts[0].external.pid);
 if (mode.includes('gone')) expect(facts.find(f => f.commands)?.commands).toContain('"gone":true');
}, 120_000);
