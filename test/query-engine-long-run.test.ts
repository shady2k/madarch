import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * madarch-ti6.2's long-run acceptance (the graph-queries capability's
 * "Resources" quality requirement): a server holds one engine per graph for
 * days, so the probe runs at least 20 000 `dependents` and `view` calls at a
 * clock that keeps advancing, yielding to the event loop between batches.
 * Each workload runs in a fresh Bun process, so RSS retained by other test
 * files cannot mask the 400 MB absolute ceiling. The child prints its full
 * memory curve and enforces the plateau and prepared-statement bounds.
 * Skipped with the other performance tests under `MADARCH_SKIP_PERF`.
 */

const PROBE = fileURLToPath(new URL('./query-engine-long-run-probe.ts', import.meta.url));

async function runProbe(scenario: 'queries' | 'updates'): Promise<void> {
  const proc = Bun.spawn([process.execPath, PROBE, scenario], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(`the ${scenario} memory probe exited ${status ?? 'without a status'}
stdout:
${stdout}
stderr:
${stderr}`);
  }
  expect(stdout).toContain('peak RSS');
  console.log(stdout.trim());
}

describe('ti6.2 long run: 24 000 dependents and view calls at an advancing clock level off in memory', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'levels off under 400 MB RSS with a handful of prepared statements in an isolated process',
    async () => runProbe('queries'),
    300_000,
  );
});

describe('ti6.2: a server-shaped stream of rebuild and update calls keeps memory bounded', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    '300 updates with a rebuild at each of 3 batch ends stay under 400 MB RSS in an isolated process',
    async () => runProbe('updates'),
    60_000,
  );
});
