import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';
for (const [mode, outcome, holder, code, identity, probe, signal] of [
 ['unstable-pidfile', 'unknown', 'unreadable', 1, 'unknown', 'skipped', 'none'],
 ['appeared', 'unknown', undefined, 1, undefined, 'skipped', 'none'],
 ['corrupt-holder', 'unknown', 'unreadable', 1, 'unknown', 'skipped', 'none'],
 ['non-linux-holder', 'unknown', 'unreadable', 1, 'unknown', 'skipped', 'none'],
 ['missing-ticks', 'unknown', 'unreadable', 1, 'unknown', 'skipped', 'none'],
] as const) test(`S2 matrix ${mode}: independent holder and command facts`, async () => {
 const { stop, facts } = await run(mode);
 expect(stop, `${mode} stop terminal`).toBeDefined();
 expect(stop!.outcome, `${mode} outcome`).toBe(outcome);
 expect(stop!.holder, `${mode} holder`).toBe(holder);
 expect(stop!.code, `${mode} command code`).toBe(code);
 expect(stop!.identity, `${mode} identity grade`).toBe(identity);
 expect(stop!.probe, `${mode} existing probe`).toBe(probe);
 expect(stop!.signal, `${mode} product signal`).toBe(signal);
 expect(stop!.postmasterPid).toBeUndefined(); expect(stop!.postmasterTicks).toBeUndefined();
 if (mode.includes('sigstop')) { expect(facts).toContainEqual({ sigstopObserved: true }); expect(facts).toContainEqual({ resumed: true }); }
 if (mode === 'appeared') expect(facts.find(f => 'afterExternal' in f)?.afterExternal?.pid).toBe(facts[0].external.pid);
 if (mode.includes('gone')) expect(facts.find(f => f.commands)?.commands).toContain('"gone":true');
}, 120_000);
