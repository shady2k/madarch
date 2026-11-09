/**
 * The graph's table statistics (madarch-8bdc.2.5): the planner's estimates for
 * `node_version` and `edge_version`, kept current while a fill publishes.
 *
 * **Why a rule is needed.** A server's autovacuum analyzes a table on its own
 * schedule (a 60 s naptime and 10 % growth by default) and nothing else in the
 * store runs `ANALYZE`, so a store that grew to millions of versions inside one
 * fill carried `reltuples = -1` on every table for the fill's whole length. Without statistics the planner
 * cannot know that a property read asks for a handful of rows: measured on a
 * copy of a 2 499 106-version store, the same bounded read
 * (`byProperty('code.listener-port', 'service', …)`) planned as a bitmap heap
 * scan over the whole of `node_version` — 540 569 buffers, 1 947 ms warm and
 * 3 651 ms cold — and planned as an index scan over one kind's rows, 0.2 ms,
 * once the table's statistics stood (`pg_statistic` emptied, then `ANALYZE`
 * run, both on that copy).
 *
 * **When, and what it costs.** `ANALYZE` of `node_version` at 2 499 106 rows
 * takes 476 ms and of `edge_version` at 252 584 rows 194 ms (measured on that
 * copy, one statement each). A fill writes about 3 000–5 000 versions per static
 * unit, so a rule that refreshes after every 50 000 rows written pays 670 ms
 * per 50 000 rows — about 14 ms per 1 000 rows, under a third of a second per
 * ten units of the code-facts stage — and no reader ever stands on estimates
 * more than 50 000 rows out of date. A table that holds rows and was never
 * analyzed is due at once, whatever the counter says: that is the state a
 * resumed store is opened in.
 *
 * **Reads stay correct while it runs.** `ANALYZE` writes `pg_statistic` and
 * nothing else: it takes no lock a reader waits on and changes no row of the
 * graph, so a read answers what it answered before the refresh and its recorded
 * membership (`answerMembership`, the fill's recheck) is the same digest
 * (stated in test/graph-statistics.test.ts).
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';

/** The tables a publication's and a read's plans are estimated from, in code-point order. */
export const STATISTICS_TABLES = ['edge_version', 'node_version'] as const;

/**
 * Rows written since the last refresh after which another one is due. Stated
 * from the measurement above: one refresh at 2.5 million rows costs 0.67 s, and
 * the window this leaves is at most 50 000 rows of a table that holds millions.
 */
export const STATISTICS_ROWS = 50_000;

export interface StatisticsRefresh {
  /** The tables the statement analyzed, in code-point order. */
  readonly tables: readonly string[];
  /** The versions written since the previous refresh, which made this one due. */
  readonly written: number;
  /** What the statement took, in milliseconds. */
  readonly ms: number;
  /** Whether a table that holds rows had never been analyzed, which makes a refresh due whatever the count. */
  readonly neverAnalyzed: boolean;
}

export interface GraphStatistics {
  /** Versions written since the last refresh. */
  readonly written: number;
  /** Counts rows one publication wrote; the next refresh is due once they reach `STATISTICS_ROWS`. */
  note(rows: number): void;
  /**
   * Runs `ANALYZE` on the two version tables when it is due, and answers what it
   * did; null when nothing was due, so a caller can tell a refresh from a call
   * that only looked.
   */
  refresh(): Promise<StatisticsRefresh | null>;
}

/** The statement: one `ANALYZE` over both tables, in code-point order. */
export const ANALYZE_STATISTICS_SQL = `ANALYZE ${STATISTICS_TABLES.join(', ')}`;

/** The due check: the tables PostgreSQL has no row count for, which is what an unanalyzed table answers. */
const NEVER_ANALYZED_SQL = `SELECT c.relname AS relname FROM pg_class c WHERE c.relname = ANY($1::text[]) AND c.reltuples < 0 ORDER BY 1`;

export function createGraphStatistics(owner: DatabaseOwner): GraphStatistics {
  let written = 0;
  let running: Promise<StatisticsRefresh | null> | undefined;
  const refresh = async (): Promise<StatisticsRefresh | null> => {
    const unanalyzed = await owner.transaction('snapshot', async (tx) => {
      const found = await tx.query<{ relname: string }>(NEVER_ANALYZED_SQL, [`{${STATISTICS_TABLES.join(',')}}`]);
      return found.rows.map((row) => row.relname);
    });
    const neverAnalyzed = unanalyzed.length > 0;
    if (written < STATISTICS_ROWS && !neverAnalyzed) return null;
    const count = written;
    // The counter is reset before the statement runs, so rows a publication writes while the statement
    // is queued are counted towards the next refresh rather than lost with this one.
    written = 0;
    const started = performance.now();
    await owner.transaction('write', async (tx) => { await tx.query(ANALYZE_STATISTICS_SQL); });
    return { tables: STATISTICS_TABLES, written: count, ms: Math.round(performance.now() - started), neverAnalyzed };
  };
  return {
    get written() { return written; },
    note(rows: number): void {
      if (Number.isFinite(rows) && rows > 0) written += rows;
    },
    /** One refresh at a time: a publication that lands while another refresh runs waits for it and then judges its own count. */
    async refresh(): Promise<StatisticsRefresh | null> {
      if (running !== undefined) await running.catch(() => undefined);
      running = refresh();
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
  };
}
