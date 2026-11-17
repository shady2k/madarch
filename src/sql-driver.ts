export interface SqlExecutor {
  /** Runs only after the owner has successfully committed this transaction. */
  afterCommit?(work: () => void): void;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export type SqlTransactionKind = 'snapshot' | 'write';
