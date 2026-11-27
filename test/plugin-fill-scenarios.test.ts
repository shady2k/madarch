import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProducerOutcomes } from '../src/graph/producer-outcomes.js';
import { readProgress } from '../src/graph/fill-orchestration.js';
import { fixture, open } from './plugin-fill-scenario-fixture.js';

test('one multi-output process reads X for A and Y for B without selecting the other branch', async () => {
  const f = fixture('multi'); const { owner, run, rows } = await open(f);
  try {
    const a = await run('A', 'only-a'); expect(a.ok).toBe(true); if (!a.ok) throw new Error(JSON.stringify(a));
    expect(a.state).toBe('succeeded');
    expect(a.units.filter(unit => unit.stageId === 'plugin-turns').map(unit => unit.unitId).sort()).toEqual(['plugin-turns/scenarios:A', 'plugin-turns/scenarios:X']);
    expect(await rows('A')).toEqual([expect.objectContaining({ text: 'authored X' })]);
    expect(await rows('Y')).toEqual([]); expect(await rows('B')).toEqual([]);
    const b = await run('B', 'only-b'); expect(b.ok).toBe(true); if (!b.ok) throw new Error(JSON.stringify(b));
    expect(b.state).toBe('succeeded');
    expect(await rows('B')).toEqual([expect.objectContaining({ text: 'authored Y' })]);
    const outcomes = await readProducerOutcomes(owner, { runId: 'only-b' });
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['B', 'Y']);
  } finally { await owner.close(); }
}, 300_000);

test.each(['unselected-write', 'undeclared-read'] as const)('real plugin %s fails without publishing forbidden or selected output', async mode => {
  const f = fixture(mode); const { owner, run, rows } = await open(f);
  const target = mode === 'unselected-write' ? 'Files' : 'A';
  try {
    // Keep the retry attempts for these deterministic violations and skip the backoff between them.
    const result = await run(target, mode, { retryDelayMs: 0 });
    expect(result.ok && result.state === 'succeeded').toBe(false);
    expect(await rows(target)).toEqual([]);
    if (mode === 'unselected-write') expect(await rows('Summary')).toEqual([]);
    else { expect(await rows('Y')).toEqual([]); expect(await rows('X')).toHaveLength(1); }
    const outcomes = await readProducerOutcomes(owner, { runId: mode });
    expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: target, outcome: 'failed' })]));
    expect(outcomes.find(outcome => outcome.kind === target)?.reason).toContain(mode === 'unselected-write'
      ? 'the plugin declares no vertex kind "Summary"; it declares Files'
      : 'undeclared catalogue read of Y; declare this input in produces[].reads');
    expect(await readProducerOutcomes(owner, { runId: mode })).toEqual(outcomes);
  } finally { await owner.close(); }
}, 300_000);

/** Product metadata still uses real Git; only the producer's system-tool probe is unavailable/old. */
test.each(['unavailable', 'old'] as const)('system Git %s fails each Git output durably while an unrelated producer publishes', async mode => {
  const f = fixture('system-git');
  const { owner, run, rows } = await open(f);
  const previousPath = process.env.PATH;
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('fixture setup requires Git');
  const bin = join(f.home, 'git-probe'); mkdirSync(bin);
  const executable = join(bin, 'git');
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n${mode === 'old' ? 'echo "git version 2.30.5"' : 'echo "git unavailable for producer" >&2; exit 127'}\nelse\nexec ${JSON.stringify(realGit)} "$@"\nfi\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try {
    const runId = `system-git-${mode}`;
    const result = await run(['X', 'Y', 'Healthy'], runId);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.state).not.toBe('succeeded');
    // The owner's final-run rule leaves no blocked unit: the failed plugin's dependants are skipped-because.
    for (const kind of ['X', 'Y']) {
      expect(result.units.find(unit => unit.unitId === `plugin-turns/scenarios:${kind}`)?.state).toBe('skipped');
    }
    expect(await rows('X')).toEqual([]); expect(await rows('Y')).toEqual([]);
    expect(await rows('Healthy')).toEqual([expect.objectContaining({ text: 'still filled' })]);
    const retried = (await readProgress(owner, runId)).filter(event => event.kind === 'unit-retried');
    expect(retried).toEqual([]);
    const outcomes = await readProducerOutcomes(owner, { runId });
    // Dependants skipped by the failed plugin publish no outcome; the unrelated producer still does.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ plugin: 'healthy', kind: 'Healthy', outcome: 'completed', produced: 1 });
    // Read completion metadata again in a separate committed transaction: failures are not private drafts.
    expect(await readProducerOutcomes(owner, { runId })).toEqual(outcomes);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await owner.close();
  }
}, 300_000);
