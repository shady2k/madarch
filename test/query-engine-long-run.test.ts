import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, preparedStatementCacheSizeForTests, type AssertionRecord, type Clock } from '../src/index.js';

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
          // The yield a server's request loop gives the runtime: an
          // asynchronous GC lets the event loop drain and LadybugDB's
          // dropped native scratch be finalized (a prepared statement is
          // freed only there, never synchronously) before the next batch.
          await Bun.gc();
          curve.push(rssMb());
        }
      }

      console.log(`ti6.2 long run: ${iterations * 2} calls, RSS per ${batchSize}-call batch (MB): ${curve.join(' ')}`);
      console.log(`ti6.2 long run: max prepared-statement cache ${maxCacheSize}, final RSS ${rssMb()} MB`);

      // Bounded, not creeping: the last third of the run sits within the
      // stated margin of the middle third (a leak keeps climbing instead),
      // and the whole run stays under the stated ceiling.
      const middle = curve.slice(iterations / batchSize / 3, (2 * iterations) / batchSize / 3);
      const last = curve.slice((2 * iterations) / batchSize / 3);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const middleMean = mean(middle);
      const lastMean = mean(last);
      console.log(`ti6.2 long run: middle-third mean ${Math.round(middleMean)} MB, last-third mean ${Math.round(lastMean)} MB`);
      expect(lastMean - middleMean).toBeLessThan(40);
      expect(Math.max(...curve)).toBeLessThan(400);

      // The statement cache is bounded by the history's own times, not by
      // the clock and not by its own LRU limit (200 — see `cachedPrepare`).
      expect(maxCacheSize).toBeLessThanOrEqual(5);

      engine.close();
    },
    300_000,
  );
});
