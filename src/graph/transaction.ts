/**
 * The one place a caller's executor becomes the store's outer transaction
 * (decision 0033, item 3: "Only this layer holds a connection or runs a
 * query"). The fill's orchestrator hands its publication's apply step an
 * executor — one `query` method over the transaction it opened — and the graph
 * store writes and reads through an `OuterTransaction` of the same shape. The
 * adapter stands in the storage boundary, not in a stage module, so a stage
 * never imports the fill's executor type or the retired history store.
 */
import type { OuterTransaction } from '../history/types.js';

/** The one method a caller's executor has: a statement with its values, answered with rows. */
export interface QueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** The caller's executor, as the store's outer transaction: every statement runs in the caller's transaction. */
export function outerTransactionOf(executor: QueryExecutor): OuterTransaction {
  return {
    query: async <Row extends object>(sql: string, values?: readonly unknown[]) => await executor.query<Row & Record<string, unknown>>(sql, values),
  };
}
