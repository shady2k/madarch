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
import { runFill } from '../src/fill/run.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readTraceReport, readTraceRun, readTraceSpans, stepReportsOf, traceReportOf, type StepReport } from '../src/obs/trace-report.js';
import { closeTrace, openTrace, runInTrace, withSpan } from '../src/obs/trace.js';
import { main } from '../src/product/cli.js';
import { writeProduct } from './fixtures/code-stages/repository.js';
import { createTestDatabaseOwner } from './test-database.js';

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

  test('names each step of a fill with its wall clock, its peak memory and its slowest names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-trace-steps-'));
    const owner = await createTestDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const store = join(root, 'store');
      await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
      const result = await runFill({ product, database: owner, runId: 'steps', store, workers: 2, maxPasses: 100_000, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
      expect(result.ok).toBe(true);
      const run = readTraceRun({ store, runId: 'steps' });
      expect(run.runId).toBe('steps');
      expect(run.report.spanCount).toBeGreaterThan(10);
      expect(run.endedAtMs - run.startedAtMs).toBeCloseTo(run.report.wallMs, 0);
      // The two steps of this fill, in the order their work started, each with the numbers the run page shows.
      expect(run.steps.map((step) => step.step).sort()).toEqual(['repository-history', 'repository-tree']);
      for (const step of run.steps) {
        expect(step.wallMs).toBeGreaterThan(0);
        expect(step.peakRssBytes).toBeGreaterThanOrEqual(step.startRssBytes);
        // A step names the spans under it, the store's writes included.
        expect(step.slowest.length).toBeGreaterThan(0);
        expect(step.slowest[0]!.selfMs).toBeGreaterThanOrEqual(step.slowest[step.slowest.length - 1]!.selfMs);
      }
      // The same spans read again say the same steps: the page's numbers are a function of the file.
      const again: readonly StepReport[] = stepReportsOf(readTraceSpans(run.file));
      expect(again.map((step) => [step.step, step.wallMs, step.peakRssBytes])).toEqual(run.steps.map((step) => [step.step, step.wallMs, step.peakRssBytes]));
      // The steps' own time stands inside the run's.
      expect(run.steps.reduce((sum, step) => sum + step.wallMs, 0)).toBeGreaterThan(0);
      expect(Math.max(...run.steps.map((step) => step.wallMs))).toBeLessThanOrEqual(run.report.wallMs);
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  test('a span states the highest memory it reached while it ran, not only its two ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-trace-peak-'));
    try {
      const store = join(root, 'store');
      const traced = openTrace({ store, runId: 'peak' });
      // A hundred megabytes touched inside the span, held until after it ends: the process's memory
      // grows while the span runs, and the sampler must see it before the span's end reading.
      let held: Uint8Array[] = [];
      await runInTrace(traced, async () => await withSpan('fill.step', { 'madarch.step': 'memory-probe' }, async () => {
        await withSpan('planted.grow', {}, async () => {
          for (let block = 0; block < 100; block++) {
            const bytes = new Uint8Array(1024 * 1024);
            bytes[0] = 1;
            bytes[bytes.length - 1] = 1;
            held.push(bytes);
          }
          await Bun.sleep(120);
        });
      }));
      closeTrace(traced);
      const spans = readTraceSpans(join(store, 'traces', 'peak.jsonl'));
      const grown = spans.find((span) => span.name === 'planted.grow')!;
      const peak = grown.attributes['process.rss.peak'] as number;
      const start = grown.attributes['process.rss.start'] as number;
      expect(typeof peak).toBe('number');
      expect(peak).toBeGreaterThan(40 * 1024 * 1024);
      expect(peak).toBeGreaterThanOrEqual(start);
      // The step that holds it states the same peak, so the run page's column is the sampled one.
      const step = stepReportsOf(spans).find((one) => one.step === 'memory-probe')!;
      expect(step.peakRssBytes).toBe(peak);
      expect(step.peakRssBytes).toBeGreaterThan(40 * 1024 * 1024);
      held = [];
      Bun.gc(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a fixture fill leaves under 5% of its wall clock covered by no span', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-trace-uncovered-'));
    const owner = await createTestDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const store = join(root, 'store');
      await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
      const result = await runFill({ product, database: owner, runId: 'uncovered', store, workers: 2, maxPasses: 100_000, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
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
