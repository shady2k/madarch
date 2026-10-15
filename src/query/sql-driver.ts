export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export type SqlTransactionKind = 'snapshot' | 'write';

/** Transaction boundary for a PostgreSQL-compatible query database. */
export interface SqlQueryDriver {
  /** True when independent snapshot transactions may use separate connections concurrently. */
  readonly allowConcurrentSnapshots: boolean;
  /** Runs work in one transaction and commits on success or rolls back on failure. */
  transaction<T>(kind: SqlTransactionKind, work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  /** Closes resources owned by this driver. */
  close(): Promise<void>;
}
