import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';

test('S2 command signal is an actual wrapper SIGTERM, not a product signal', async () => {
 const { stop, facts } = await run('command-signal');
 expect(stop!.command).toBe('signal'); expect(stop!.outcome).toBe('error');
 expect(stop!.holder).toBe('held'); expect(stop!.identity).toBe('observed');
 expect(stop!.signal).toBe('none');
 expect(facts.find(f => f.commands).commands).toContain('wrapper-sigterm');
 expect(facts.find(f => f.afterExternal).afterExternal.pid).toBe(facts[0].external.pid);
}, 120_000);
test('S2 controlled native timeout is distinct from a launch error', async () => {
 const { stop, facts } = await run('sync-command-timeout');
 expect(stop!.command).toBe('timeout'); expect(stop!.code).toBeUndefined();
 expect(stop!.outcome).toBe('unknown'); expect(stop!.holder).toBe('gone');
 expect(stop!.identity).toBe('verified'); expect(stop!.signal).toBe('term');
 expect(facts).toContainEqual({ timeoutBoundary: 'controlled ETIMEDOUT, no elapsed-time claim', commandLaunched: false });
}, 120_000);
