export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export const SQL_TRANSACTION_KINDS = { snapshot: 'snapshot', write: 'write' } as const;
export type SqlTransactionKind = typeof SQL_TRANSACTION_KINDS[keyof typeof SQL_TRANSACTION_KINDS];
