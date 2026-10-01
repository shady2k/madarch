import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, preparedStatementCacheSizeForTests, type AssertionChange, type AssertionRecord, type Clock } from '../src/index.js';

/**
 * madarch-ti6.2's long-run acceptance (the graph-queries capability's
 * "Resources" quality requirement): a server holds one engine per graph for
 * days, so the engine is asked here with at least 20 000 `dependents` and
 * `view` calls at a clock that keeps advancing — the ordinary shape of an
 * agent watching a graph — yielding to the event loop between batches, the
 * way a server yields between requests. The measured claim it holds the
 * engine to, chosen from this test's own first runs at the fixed 2
 * execution threads (see `LADYBUG_EXEC_THREADS`): RSS levels off well
 * under 400 MB, and the prepared statements in play stay a handful — a
 * query's `valid`/`known` reduce to the model history's own times, so an
 * advancing clock alone builds no new statement texts. The whole memory
 * curve is printed so the numbers behind the bound stay visible. Skipped
 * with the other performance tests under `MADARCH_SKIP_PERF` (about two
 * minutes of real work otherwise).
 */

const DAY = (day: number) => Date.UTC(2026, 8, day);

function element(id: string, kind: string, ancestors: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...extra });
}

function relation(id: string, from: string, to: string): string {
  return JSON.stringify({ id, from, to, states: ['as-is'] });
}

function row(kind: 'element' | 'relation', content: string): AssertionRecord {
  const parsed: { id: string } = JSON.parse(content);
  return { source: 's', kind, id: parsed.id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

/**
 * The yield a server's request loop gives the runtime, in the two steps
 * that actually release LadybugDB's dropped native objects (a prepared
 * statement or a query result is freed only by the native finalizer, never
 * synchronously — see `cachedPrepare` in the engine): `Bun.gc()` drops the
 * runtime's references, and the macrotask below is the event-loop turn the
 * finalizers need to run. `Bun.gc()` returns `void`, so awaiting it alone
 * resumes through the microtask queue only, which finalizes nothing.
 */
async function yieldToFinalizers(): Promise<void> {
  Bun.gc();
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

/** The least-squares slope of `ys` against its own index — MB per batch for an RSS curve. */
function leastSquaresSlope(ys: number[]): number {
  const xMean = (ys.length - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let x = 0; x < ys.length; x++) {
    numerator += (x - xMean) * (ys[x]! - yMean);
    denominator += (x - xMean) ** 2;
  }
  return numerator / denominator;
}

describe('ti6.2 long run: 24 000 dependents and view calls at an advancing clock level off in memory', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'levels off under 400 MB with a handful of prepared statements',
    async () => {
      // A 50-element dependency chain: every `dependents` call walks the
      // recursive (SHORTEST) relationship filter at its full 30-hop
      // ceiling — the native work whose per-thread cost the fixed thread
      // count bounds.
      const chain = Array.from({ length: 50 }, (_, i) => i + 1);
      let now = DAY(30); // already past the model's newest time; "now" then advances with no new history
      const clock: Clock = { now: () => now };
      const engine = createLadybugEngine({ clock });
      engine.rebuild([
        ...chain.map((n) => row('element', element(`e${n}`, 'service', []))),
        ...chain.slice(0, -1).map((n) => row('relation', relation(`r${n}`, `e${n}`, `e${n + 1}`))),
      ]);

      const iterations = 12_000; // 12 000 dependents + 12 000 view calls
      const batchSize = 500;
      const rssMb = () => Math.round(process.memoryUsage().rss / 1e6);
      const curve: number[] = [];
      let maxCacheSize = 0;

      for (let i = 0; i < iterations; i++) {
        now += 1; // a distinct "now" every iteration, all reducing to the same latest history time
        const dependents = engine.dependents('e50', { transitive: true });
        expect(dependents.error).toBeUndefined();
        expect(dependents.elements).toHaveLength(30); // the 30-hop ceiling reaches e20..e49
        const seen = engine.view({ depth: 0 });
        expect(seen.error).toBeUndefined();
        expect(seen.elements).toHaveLength(50);
        maxCacheSize = Math.max(maxCacheSize, preparedStatementCacheSizeForTests(engine));

        if ((i + 1) % batchSize === 0) {
          // A real event-loop turn before the next batch: the GC drops
          // this runtime's references and `yieldToFinalizers` gives
          // LadybugDB's native finalizers the turn they need (an `await
          // Bun.gc()` alone resumes through the microtask queue only and
          // frees nothing — the reviewer's timer probe printed
          // "microtask-only").
          await yieldToFinalizers();
          curve.push(rssMb());
        }
      }

      console.log(`ti6.2 long run: ${iterations * 2} calls, RSS per ${batchSize}-call batch (MB): ${curve.join(' ')}`);
      console.log(`ti6.2 long run: max prepared-statement cache ${maxCacheSize}, final RSS ${rssMb()} MB`);

      // Bounded, not creeping: a least-squares slope over the last half of
      // the batches reads through the per-batch GC saw-tooth (periodic, so
      // the drops cancel in the fit) and fails the steady linear growth the
      // old "last-third mean minus middle-third mean < 40" tolerated — that
      // accepted up to ~5 MB a batch across this run's 24 batches, and
      // passed by accident after a late GC drop. The bound sits far above
      // what a settled run drifts (the fixed runs' last half slopes flat
      // to falling — the finalizers' releases land mid-run) and well
      // under the ~5 MB a batch the old assertion tolerated, so growth at
      // the old blind spot trips it at once.
      const slopePerBatch = leastSquaresSlope(curve.slice(curve.length / 2));
      console.log(`ti6.2 long run: last-half slope ${slopePerBatch.toFixed(2)} MB/batch`);
      expect(slopePerBatch).toBeLessThan(1);
      // A regime change the slope could average out (a leak that starts
      // late) shows as the last third's worst batch climbing above the
      // middle third's. The margin only has to clear this run's observed
      // GC saw-tooth between thirds (drops of ~65 MB: 194 down to 128-133),
      // so 100 MB holds every plateau run and still fails a genuine
      // step-up; the slope above is the discriminator.
      const middle = curve.slice(curve.length / 3, (2 * curve.length) / 3);
      const last = curve.slice((2 * curve.length) / 3);
      const thirdsGap = Math.max(...last) - Math.max(...middle);
      console.log(`ti6.2 long run: middle-third max ${Math.max(...middle)} MB, last-third max ${Math.max(...last)} MB, gap ${thirdsGap} MB`);
      expect(thirdsGap).toBeLessThan(100);
      // And the whole run stays under the stated ceiling.
      expect(Math.max(...curve)).toBeLessThan(400);

      // The statement cache is bounded by the history's own times, not by
      // the clock and not by its own LRU limit (200 — see `cachedPrepare`).
      expect(maxCacheSize).toBeLessThanOrEqual(5);

      engine.close();
    },
    300_000,
  );
});

describe('ti6.2: a server-shaped stream of rebuild and update calls keeps memory bounded', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    '300 updates with a rebuild at each of 3 batch ends stay under the stated ceiling',
    async () => {
      // The write and reset paths (`rebuild`'s deletes, every
      // `mergeAnchor`/insert and row closure of `update`) each used to
      // discard their `QueryResult` and lean on the native finalizer
      // instead of closing it (`runAndClose` in the engine); a server
      // keeping a derived engine in step issues them on every stored
      // version. This is that stream at one reconciliation pass's scale:
      // 300 `update`s with a `rebuild` at each of the 3 batch ends,
      // yielding to the event loop between batches the way a server does.
      // Each `update` re-points `r1` between `e2` and `e3` (one row
      // closed, one opened, a fresh `recordedFrom` each, so no primary
      // key ever repeats). No queries run inside the loop: a read whose
      // statement text carries the history's own times (see
      // `dependencyQuery`) would churn the prepared cache with the growing
      // history and measure that instead of the write paths — the read
      // paths have this file's long run and the B1 stability tests of
      // their own. Skipped under `MADARCH_SKIP_PERF`: a few seconds of
      // real work.
      const chain = Array.from({ length: 10 }, (_, i) => i + 1);
      const model: AssertionRecord[] = [
        ...chain.map((n) => row('element', element(`e${n}`, 'service', []))),
        ...chain.slice(0, -1).map((n) => row('relation', relation(`r${n}`, `e${n}`, `e${n + 1}`))),
      ];
      const engine = createLadybugEngine();
      engine.rebuild(model);

      const iterations = 300;
      const batchSize = 100;
      const rssMb = () => Math.round(process.memoryUsage().rss / 1e6);
      const curve: number[] = [];
      // The row `update` will close next: after a `rebuild` it is the
      // model's own `r1` (`recordedFrom` DAY(1), into `e2`); after an
      // `update` it is the row that update just opened.
      let currentRecordedFrom = DAY(1);
      let currentTo = 'e2';
      let recordedFrom = DAY(1);

      for (let i = 0; i < iterations; i++) {
        recordedFrom += 1;
        const to = i % 2 === 0 ? 'e3' : 'e2';
        const opened: AssertionChange = { source: 's', kind: 'relation', id: 'r1', content: relation('r1', 'e1', to), validFrom: DAY(1), validTo: null, recordedFrom, recordedTo: null };
        const closed: AssertionChange = { source: 's', kind: 'relation', id: 'r1', content: relation('r1', 'e1', currentTo), validFrom: DAY(1), validTo: null, recordedFrom: currentRecordedFrom, recordedTo: recordedFrom };
        engine.update([opened], [closed]);
        currentRecordedFrom = recordedFrom;
        currentTo = to;

        if ((i + 1) % batchSize === 0) {
          engine.rebuild(model);
          currentRecordedFrom = DAY(1);
          currentTo = 'e2';
          await yieldToFinalizers();
          curve.push(rssMb());
        }
      }

      console.log(`ti6.2 rebuild/update stream: ${iterations} updates + ${curve.length} rebuilds, RSS after each ${batchSize}-update batch (MB): ${curve.join(' ')}`);

      // Bounded under a stated ceiling, not a slope: the long-run
      // acceptance's own 400 MB bound, an order of magnitude above where
      // fixed runs sit (the curve peaks near 170 MB, most of that the
      // engine's own warm-up), so the stream keeps headroom for ordinary
      // allocator noise while still failing gross unbounded growth.
      expect(Math.max(...curve)).toBeLessThan(400);

      // The model's own r1 (e1 -> e2) is what the last rebuild restored:
      // the stream never corrupted the engine.
      expect(engine.dependents('e2', {}).elements?.map((e) => e.id)).toEqual(['e1']);

      engine.close();
    },
    60_000,
  );
});
