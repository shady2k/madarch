/**
 * The queue inside a compiled binary (madarch-tzte.19.2): `bun build --compile`
 * builds `test/queue-binary-driver.ts` with the three files PGlite's own build
 * reads — the same ones `scripts/build-binary.ts` stages for the release binary —
 * and the two phases of that program run as two processes on one PGlite data
 * folder. What the task asks this to show, and where each expectation comes
 * from:
 *
 * - enqueue, claim, fail and retry: the first phase enqueues one job with
 *   priority 4, claims it as attempt 0 under the queue's 60-second lease, fails
 *   it, and the declared one-second retry delay is why it is not claimable right
 *   away.
 * - survives a restart: the second process claims the same job as attempt 1 —
 *   the row outlived the process that failed it — completes it, and finds the
 *   queue empty and nothing dead-lettered, since the retries were not spent.
 *
 * The PostgreSQL leg of the queue's own tests is `test/queue-postgres.test.ts`:
 * a compiled binary is one image for one platform, and what carries across is
 * the same `QueueService` on the same owner, which that file runs.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pgliteAssetFiles } from '../scripts/pglite-assets.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRIVER = join(REPO_ROOT, 'test', 'queue-binary-driver.ts');

interface PhaseReport {
  phase: string;
  [key: string]: unknown;
}

/** Builds the driver and runs one phase of it, answering what it printed. */
function build(folder: string): string {
  const binary = join(folder, 'queue-binary');
  const build = spawnSync('bun', [
    'build', '--compile', DRIVER,
    ...pgliteAssetFiles().flatMap((file) => ['--asset', file]),
    '--outfile', binary,
  ], { encoding: 'utf8', cwd: REPO_ROOT });
  const said = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim();
  if (build.status !== 0) {
    throw new Error(`the queue's compiled binary could not be built (exit ${String(build.status)}): ${said}`);
  }
  return binary;
}

function run(binary: string, folder: string, phase: 'first' | 'second'): PhaseReport {
  const run = spawnSync(binary, [join(folder, 'database'), phase], { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`the queue's compiled binary refused its ${phase} phase (exit ${String(run.status)}): ${`${run.stdout ?? ''}${run.stderr ?? ''}`.trim()}`);
  }
  return JSON.parse(run.stdout.trim()) as PhaseReport;
}

test('a compiled binary enqueues, claims, fails and retries a job on PGlite, and a second process completes it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-queue-binary-'));
  try {
    const binary = build(folder);
    const first = run(binary, folder, 'first');
    expect(first).toEqual({
      phase: 'first',
      created: true,
      attempt: 0,
      leaseSeconds: 60,
      outcome: 'retry',
      claimableRightAway: 0,
    });
    const second = run(binary, folder, 'second');
    expect(second).toEqual({
      phase: 'second',
      attempt: 1,
      data: { unit: 'binary' },
      settled: true,
      afterComplete: 0,
      deadLetters: 0,
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);
