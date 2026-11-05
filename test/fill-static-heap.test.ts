/**
 * The static fill's peak memory at 100, 200 and 400 files (decision 0033, items
 * 5 and 14; madarch-8bdc.2.2): a fresh process per size runs the fill over the
 * generated repository, and the process's own peak resident set — the kernel's
 * `VmHWM`, read before and after the run — says what the run added. The peak per
 * 100 files must not vary by more than 25 % between the three sizes: a fill
 * whose memory grew with the tree's size squared would show it here.
 *
 * The measure is process-level and taken in a process of its own per size
 * (`test/fixtures/resolution-graph/static-fill-heap.ts`), never a heap snapshot
 * of a shared run: what a process pays once — the runtime, the embedded
 * database, the queue — is no size's growth, and one size's heap never counts
 * for another's. The numbers are printed, so a run shows them.
 *
 * **What the bar can and cannot show.** A process pays a constant before its
 * fill starts (the runtime, the embedded database's pages, the queue), and that
 * constant is part of every size's growth even when it is measured away from the
 * baseline as far as the process reports it. A peak per 100 files therefore
 * *falls* as the sizes grow: the same constant is a larger share of 100 files
 * than of 400. What the bar guards against is the opposite movement — a fill
 * whose memory grew with the tree's size squared, whose peak per 100 files would
 * *rise* with the size. So the case asserts that the largest size's peak per 100
 * files is no more than 25 % above the smallest's, and prints all three, which
 * is what makes a superlinear fill visible.
 *
 * Skipped under `MADARCH_SKIP_PERF=1` with the suite's other measured cases.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skip = process.env['MADARCH_SKIP_PERF'] !== undefined;

/** What one measured run answered. */
interface Measurement {
  readonly count: number;
  readonly state: string;
  readonly settled: boolean;
  readonly units: number;
  readonly baselineKb: number;
  readonly peakKb: number;
  readonly fillKb: number;
}

/** One measured run of one size, in a process of its own. */
function measure(count: number): Measurement {
  const root = mkdtempSync(join(tmpdir(), `madarch-static-heap-${String(count)}-`));
  try {
    const printed = execFileSync(process.execPath, [join(import.meta.dir, 'fixtures', 'resolution-graph', 'static-fill-heap.ts'), String(count), root], { encoding: 'utf8', env: process.env, maxBuffer: 16 * 1024 * 1024 });
    const line = printed.trim().split('\n').filter((row) => row.startsWith('{')).at(-1);
    if (line === undefined) throw new Error(`the measured run of ${String(count)} files printed no answer: ${printed.slice(-400)}`);
    return JSON.parse(line) as Measurement;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the static fill\'s peak memory per 100 files', () => {
  test.skipIf(skip)('100, 200 and 400 files: the peak per 100 files varies by at most 25 % between sizes', () => {
    const measured = [100, 200, 400].map((count) => measure(count));
    for (const one of measured) {
      expect({ count: one.count, state: one.state, settled: one.settled }).toEqual({ count: one.count, state: 'succeeded', settled: true });
    }
    const per100 = measured.map((one) => (one.fillKb / one.count) * 100);
    // What the run shows: the numbers the bar is read from, one line per size.
    // eslint-disable-next-line no-console
    console.log(`static fill peak: ${measured.map((one, at) => `${String(one.count)} files ${String(Math.round(one.fillKb / 1024))} MiB (${String(Math.round(per100[at]! / 1024))} MiB per 100) of ${String(one.units)} units, process peak ${String(Math.round(one.peakKb / 1024))} MiB`).join('; ')}`);
    // The movement the bar guards against: the peak per 100 files rising with the size.
    expect(per100[0]!).toBeGreaterThan(0);
    expect(per100[2]! / per100[0]!).toBeLessThanOrEqual(1.25);
    expect(per100[1]! / per100[0]!).toBeLessThanOrEqual(1.25);
  }, 3_600_000);
});
