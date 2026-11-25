import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureOwner, until, saveBoundaryEvidence } from './startup-boundary-fixture.js';
import { collectStartup } from './startup-trace-collector.js';
const fixture = createFixtureOwner();
for (const kind of ['users', 'start']) for (const mode of ['try', 'hold', 'zero', 'deadline']) test(`real ${kind} lock ${mode} records the actual kernel result`, async () => {
 const f = fixture();
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-correction-locks.ts'), f.home, kind, mode], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
 let stderr = ''; let stdout = '';
 const out = (async () => { for await (const part of child.stdout) stdout += new TextDecoder().decode(part); })();
 const err = (async () => { for await (const part of child.stderr) stderr += new TextDecoder().decode(part); })();
 try {
  if (mode === 'hold') {
   await until(() => existsSync(join(f.home, 'waiting')), 'actual refused flock before release');
   const live = collectStartup(stderr).records.filter(r => r.phase === `cluster.lock.${kind}`);
   expect(live.map(r => r.edge), 'waiting lock has begin only, never early acquired').toEqual(['begin']);
   expect(stdout).toContain('"externalRefused":true');
   writeFileSync(join(f.home, 'release'), 'release');
  }
  expect(await child.exited, stdout + stderr).toBe(0); await out; await err;
  const facts = stdout.trim().split('\n').map(l => JSON.parse(l));
  const records = collectStartup(stderr).records.filter(r => r.phase === `cluster.lock.${kind}`);
  const terminals = records.filter(r => r.edge === 'terminal');
  if (mode === 'try') {
   expect(facts).toContainEqual({ first: -1 }); expect(facts).toContainEqual({ second: 0 });
   expect(terminals.map(r => r.outcome), `${kind} contention then acquisition`).toEqual(['busy', 'acquired']);
  } else if (mode === 'zero') {
   expect(facts).toContainEqual({ descriptor: 0 }); expect(facts).toContainEqual({ first: 0 });
   expect(terminals.map(r => r.outcome), `${kind} descriptor zero is acquired`).toEqual(['acquired']);
  } else if (mode === 'deadline') {
   expect(facts).toContainEqual({ rejected: true, acquired: false });
   expect(terminals.map(r => r.outcome), `${kind} controlled deadline is busy, not filesystem error`).toEqual(['busy']);
  } else {
   expect(terminals.map(r => r.outcome)).toEqual(['acquired']);
   const release = facts.find(f => f.released).released;
   expect(terminals[0]!.clock).toBe(release.clock); expect(terminals[0]!.domain).toBe(release.domain);
   expect(BigInt(terminals[0]!.ns) >= BigInt(release.ns), 'acquired cannot precede external release mark').toBe(true);
  }
  saveBoundaryEvidence(`lock-${kind}-${mode}`, stderr);
 } finally {
  if (child.exitCode === null) { writeFileSync(join(f.home, 'release'), 'release'); child.kill('SIGTERM'); await child.exited; }
 }
}, 30_000);
