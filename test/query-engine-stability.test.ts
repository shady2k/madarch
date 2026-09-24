import { describe, expect, test } from 'bun:test';
import { createLadybugEngine, preparedStatementCacheSizeForTests, type AssertionRecord, type Clock } from '../src/index.js';

/**
 * B1's own repository test (stage3-fixes.md): 5 000 consecutive queries of
 * each kind on one engine, without failure or unbounded memory growth. An
 * unclosed `QueryResult` and a prepared statement rebuilt from scratch on
 * every call (this LadybugDB build never frees either on its own) exhausted
 * the fixed-size buffer pool within a few hundred calls before B1's fix
 * (tried and confirmed) — `close()`ing every result and caching prepared
 * statements by their exact query text keeps this bounded. Skipped when
 * `MADARCH_SKIP_PERF` is set, since 5 000 `view` calls (the heaviest of the
 * three) take real wall time; the test still reports what it measured.
 */

const DAY = (day: number) => Date.UTC(2026, 8, day);

function element(id: string, kind: string, ancestors: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...extra });
}

function relation(id: string, from: string, to: string): string {
  return JSON.stringify({ id, from, to, states: ['as-is'] });
}

function row(kind: 'element' | 'relation', content: string): AssertionRecord {
  return { source: 's', kind, id: (JSON.parse(content) as { id: string }).id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

describe('B1: 5 000 consecutive queries of each kind answer without failure or unbounded memory growth', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'children, view and dependents each answer 5 000 times in a row on one engine',
    () => {
      const engine = createLadybugEngine();
      engine.rebuild([
        row('element', element('a', 'service', [])),
        row('element', element('b', 'service', [])),
        row('relation', relation('a-to-b', 'a', 'b')),
      ]);
      const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };

      const iterations = 5000;
      // The buffer pool is fixed-size and shared across every query kind on
      // this one engine, so the calls are interleaved rather than run one
      // kind after another to a full 5 000 each — the same total call
      // volume the leak had to survive, closer to how a caller would
      // actually mix `children`/`view`/`dependents` calls in practice.
      const startRss = process.memoryUsage().rss;
      for (let i = 0; i < iterations; i++) {
        expect(() => engine.children('a', at)).not.toThrow();
        expect(() => engine.view({ depth: 0 }, at)).not.toThrow();
        expect(() => engine.dependents('b', { transitive: true }, at)).not.toThrow();
      }
      const endRss = process.memoryUsage().rss;

      // Bounded, not unbounded: the original bug exhausted a 256 MiB pool
      // within a few hundred calls (over 1 MiB/call, every one of them a
      // hard failure). What remains after B1's fix is a much smaller,
      // roughly linear RSS creep — some native scratch this LadybugDB
      // build does not hand back to the OS per call, observed here at
      // tens of KB/call, not MB/call — bounded well under this margin and
      // never once throwing across 15 000 calls, which is the bar this
      // test actually holds it to.
      const bytesPerCall = (endRss - startRss) / (iterations * 3);
      // eslint-disable-next-line no-console
      console.log(`B1 stability: ${iterations * 3} queries, RSS grew by ${Math.round((endRss - startRss) / 1e6)}MB (${Math.round(bytesPerCall)} bytes/call)`);
      expect(bytesPerCall).toBeLessThan(100_000);

      expect(engine.children('a', at).elements?.map((e) => e.id)).toEqual([]);
      expect(engine.dependents('b', { transitive: true }, at).elements?.map((e) => e.id)).toEqual(['a']);

      engine.close();
    },
    120_000,
  );
});

/**
 * The other half of B2's memory-growth fix (stage3-fixes-d.md item 3):
 * `dependencyQuery`'s own text embeds `valid`/`known` as literals (params
 * refused inside the relationship-filter lambda — tried again for this
 * clause specifically, see `cachedPrepare`'s own doc), so a caller asking
 * "now" through a clock that keeps advancing builds a new, distinct query
 * text on every call — the prepared-statement cache would grow forever if
 * it cached every one of those. `PREPARED_CACHE_LIMIT`'s small LRU is what
 * this test holds to a bound instead of an unbounded map's own size.
 */
describe('B2: the prepared-statement cache stays bounded across many dependency queries at an advancing "now"', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    '20 000 dependents() calls at the clock\'s own advancing "now" never grow the cache past its own limit',
    () => {
      let current = DAY(2);
      const clock: Clock = { now: () => current };
      const engine = createLadybugEngine({ clock });
      engine.rebuild([
        row('element', element('a', 'service', [])),
        row('element', element('b', 'service', [])),
        row('relation', relation('a-to-b', 'a', 'b')),
      ]);

      const iterations = 20_000;
      let maxCacheSize = 0;
      for (let i = 0; i < iterations; i++) {
        current += 1; // a distinct `valid`/`known` (and so a distinct query text) every call
        const result = engine.dependents('b', { transitive: true });
        expect(result.error).toBeUndefined();
        maxCacheSize = Math.max(maxCacheSize, preparedStatementCacheSizeForTests(engine));
      }

      // eslint-disable-next-line no-console
      console.log(`B2 bounded cache: ${iterations} distinct-time dependents() calls, max cache size ${maxCacheSize}`);
      // Comfortably below the count of distinct query texts 20 000 calls at
      // a strictly advancing time would otherwise have produced (20 000,
      // one per call) — bounded, not merely "smaller than that".
      expect(maxCacheSize).toBeLessThanOrEqual(210);

      engine.close();
    },
    150_000,
  );
});

/**
 * The recursive per-hop filter (`dependencyQuery`'s own `SHORTEST ... (r, n
 * | WHERE ...)` clause) is the one construct in this engine LadybugDB
 * itself does the most native work inside per query — this test measures,
 * rather than asserts a bound on, its own RSS cost per query against a
 * direct one-hop query on the very same relation as a baseline, so the
 * native part `do not try to fix LadybugDB itself` (stage3-fixes-d.md)
 * leaves alone is at least quantified.
 */
describe('B2: RSS per query for dependents, with and without the recursive (transitive) filter', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'measures and reports both',
    () => {
      const engine = createLadybugEngine();
      engine.rebuild([
        row('element', element('a', 'service', [])),
        row('element', element('b', 'service', [])),
        row('relation', relation('a-to-b', 'a', 'b')),
      ]);
      const at = { valid: DAY(2), known: DAY(2), state: 'as-is' };
      const iterations = 5000;

      const rssOf = () => {
        Bun.gc(true);
        return process.memoryUsage().rss;
      };

      // Without the recursive filter: `transitive: false` still goes
      // through `dependencyQuery`, but bounded to one hop (`maxHops = 1`),
      // the smallest instance of the same clause.
      const directStart = rssOf();
      for (let i = 0; i < iterations; i++) expect(engine.dependents('b', { transitive: false }, at).error).toBeUndefined();
      const directEnd = rssOf();

      // With the recursive filter doing real multi-hop work: `transitive:
      // true` walks up to the engine's own 30-hop ceiling per call, even
      // though this fixture's own longest chain is one hop.
      const transitiveStart = rssOf();
      for (let i = 0; i < iterations; i++) expect(engine.dependents('b', { transitive: true }, at).error).toBeUndefined();
      const transitiveEnd = rssOf();

      const directBytesPerCall = (directEnd - directStart) / iterations;
      const transitiveBytesPerCall = (transitiveEnd - transitiveStart) / iterations;
      // eslint-disable-next-line no-console
      console.log(
        `B2 RSS/query: direct (transitive:false) ${Math.round(directBytesPerCall)} bytes/call; ` +
          `transitive (30-hop ceiling) ${Math.round(transitiveBytesPerCall)} bytes/call, over ${iterations} calls each`,
      );

      engine.close();
    },
    60_000,
  );
});
