import { expect, test } from 'bun:test';
import { run } from './startup-stop-matrix-helper.js';

// Both stop paths run `pg_ctl stop` and both read its ending the same way: the ending by a signal is the one that has no
// exit code, and the record's fields are read from a command record that exists (ALX-1604, item 2).
for (const [mode, path] of [['command-signal', 'stopStoreForExit'], ['cluster-command-signal', 'stopCluster']] as const) test(`signal termination of ${path}'s command omits its exit code`, async () => {
 const { records, stop, facts } = await run(mode);
 const commands = records.filter(r => r.phase === 'cluster.stop.command' && r.edge === 'terminal' && r.command === 'signal');
 expect(commands, `${mode} exactly one signal-ended stop command`).toHaveLength(1);
 expect(commands[0]!.code, `${mode} a command ended by a signal has no exit code`).toBeUndefined();
 expect(commands[0]!.outcome, `${mode} a command ended by a signal did not succeed`).toBe('error');
 expect(stop, `${mode} stop terminal`).toBeDefined();
 expect(stop!.command, `${mode} the stop names its command's ending`).toBe('signal');
 expect(stop!.code, `${mode} the stop inherits no exit code`).toBeUndefined();
 expect(stop!.signal, `${mode} no product signal was sent`).toBe('none');
 expect(stop!.identity, `${mode} identity from the bounded sample`).toBe('observed');
 expect(stop!.postmasterPid).toBe(facts[0].external.pid);
 expect(facts.find(f => f.commands)?.commands, `${mode} the wrapper really ended by the signal`).toContain('wrapper-sigterm');
}, 120_000);

test('a new holder after absence is unknown without a held claim', async () => {
 const { stop } = await run('appeared');
 expect(stop!.outcome).toBe('unknown');
 expect(stop!.holder, 'held means the same prior live PID and ticks').toBeUndefined();
}, 120_000);

for (const kind of ['users', 'start']) test(`nonblocking ${kind} lock records actual contention`, async () => {
 const { records } = await run(`${kind}-busy`);
 const lock = records.filter(r => r.phase === `cluster.lock.${kind}` && r.edge === 'terminal');
 expect(lock.some(r => r.outcome === 'busy'), `${kind} actual contested flock must report busy`).toBe(true);
 // Acquisition after release is asserted directly by the lock boundary fixture.
}, 120_000);
