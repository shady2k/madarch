/**
 * Where one run's time went (madarch-8bdc.2.5, item 2): `madarch trace` reads
 * the run's trace and nothing else, names the slowest names first, and the
 * proportion of the run no span covers stays small. The slow child is planted;
 * the fill is the same fixture the fill tests use.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { readTraceReport, readTraceSpans, traceReportOf } from '../src/obs/trace-report.js';
import { closeTrace, openTrace, runInTrace, withSpan } from '../src/obs/trace.js';
import { main } from '../src/product/cli.js';
import { writeProduct } from './fixtures/code-stages/repository.js';

/** Runs one command and answers what it wrote on standard output. */
async function commandOutput(argv: readonly string[]): Promise<{ code: number; text: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; }) as typeof process.stdout.write;
  try {
    const code = await main(argv);
    return { code, text: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

describe('madarch trace', () => {
  test('names a planted slow child first, before every faster name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-trace-planted-'));
    try {
      const store = join(root, 'store');
      const traced = openTrace({ store, runId: 'planted' });
      await runInTrace(traced, async () => await withSpan('fill.run', { 'madarch.run': 'planted' }, async () => {
        await withSpan('planted.quick', {}, async () => { await Bun.sleep(2); });
        await withSpan('planted.slow', {}, async () => { await Bun.sleep(120); });
        await withSpan('planted.other', {}, async () => { await Bun.sleep(10); });
      }));
      closeTrace(traced);

      const { code, text } = await commandOutput(['trace', '--store', store]);
      expect(code).toBe(0);
      // The names are printed in self-time order: the planted child is the first name line.
      const names = text.split('\n').filter((line) => line.includes('x  ') && !line.startsWith('  Time'));
      expect(names.length).toBeGreaterThan(1);
      expect(names[0]).toContain('planted.slow');
      // The report states the wall clock, the memory spans and the slowest spans too.
      expect(text).toContain('wall clock');
      expect(text).toContain('made the process grow');
      expect(text).toContain('Time no span covers');
      expect(text).toContain('slowest single spans');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a fixture fill leaves under 5% of its wall clock covered by no span', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-trace-uncovered-'));
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const store = join(root, 'store');
      const result = await runFill({ product, database: owner, runId: 'uncovered', store, workers: 2, maxPasses: 100_000 });
      expect(result.ok).toBe(true);
      const report = readTraceReport({ store, runId: 'uncovered' });
      expect(report.spanCount).toBeGreaterThan(10);
      expect(report.uncoveredPercent).toBeLessThan(5);
      // The same spans read again say the same thing: the report is a function of the file.
      expect(traceReportOf(readTraceSpans(report.file), report.file).uncoveredMs).toBe(report.uncoveredMs);
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);
});
