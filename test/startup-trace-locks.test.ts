import { expect, test } from 'bun:test';
import { createFixtureOwner, observed, saveBoundaryEvidence } from './startup-boundary-fixture.js';
import { fixtureRun } from './startup-lifecycle-fixture.js';
const fixture = createFixtureOwner();
for (const kind of ['users', 'start']) for (const fault of ['zero', 'error']) test(`S3 ${kind} lock handles real descriptor zero and filesystem failure: ${fault}`, async () => {
 const mode = `lock-${kind}-${fault}`; const f = fixture(mode);
 const result = await fixtureRun(f, mode);
 const lock = result.records.find(r => r.phase === `cluster.lock.${kind}` && r.edge === 'terminal');
 expect(lock, 'missing production lock terminal').toBeDefined();
 if (fault === 'zero') {
  expect(observed(f).some(r => r.descriptor === 0 && r.kind === `pgdata.${kind === 'users' ? 'users' : 'lock'}`), 'actual lock open must return descriptor zero').toBe(true);
  expect(result.facts.opened).toBe(true); expect(lock!.outcome, 'descriptor zero is an acquired lock').toBe('acquired');
 } else {
  expect(observed(f).some(r => r.lockFilesystemError)).toBe(true);
  expect(result.facts).toEqual({ originalFilesystemError: true, code: 'EACCES' });
  expect(lock!.outcome, 'filesystem failure must terminate error').toBe('error');
 }
 saveBoundaryEvidence(mode, result.stderr);
}, 60_000);
