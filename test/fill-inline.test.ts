import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FillRunResult } from '../src/fill/orchestrator-host.js';
import { createDraft } from '../src/product/draft.js';
import { fillInProcess, requireSucceededFill } from './fill-inline.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

function result(state: string, settled: boolean): FillRunResult {
  return { ok: true, runId: 'fixture-fill', state, settled, passes: 1, work: 0,
    units: [], reused: [], retryWaitMs: 0, foundNothing: [] };
}

for (const [state, settled] of [['running', false], ['failed', true], ['succeeded', false]] as const) {
  test(`inline fill refuses state=${state}, settled=${String(settled)}`, () => {
    expect(() => requireSucceededFill(result(state, settled))).toThrow(
      `the fill did not succeed (run fixture-fill, state ${state}, settled ${String(settled)})`,
    );
  });
}

test("inline fill retains a refused run's code and reason", () => {
  expect(() => requireSucceededFill({ ok: false, code: 'fill/busy', reason: 'another run holds the product' }))
    .toThrow('the fill was refused (fill/busy): another run holds the product');
});

test('inline fill returns the settled succeeded result unchanged', () => {
  const succeeded = result('succeeded', true);
  expect(requireSucceededFill(succeeded)).toBe(succeeded);
});

test('fillInProcess accepts a real settled succeeded fill', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-inline-fill-'));
  try {
    const home = join(folder, 'products');
    const draft = createDraft({ home, name: 'inline-fill', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    useFixturePlugins(draft.folder, []);
    commitProduct(draft.folder, 'Keep this result-guard fixture free of plugin work');
    const filled = await fillInProcess(draft.folder, home);
    expect(filled.ok).toBe(true);
    expect(filled.state).toBe('succeeded');
    expect(filled.settled).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30_000);
