import { describe, expect, test } from 'bun:test';
import { parsePostgres } from '../src/parsers/postgres.js';

describe('shared PostgreSQL 18 C-to-WASM parser', () => {
  test('returns the actual PostgreSQL raw AST without imposing an admission policy', async () => {
    const parsed = await parsePostgres('SELECT 1 AS value INTO guide_probe');
    expect(parsed.version).toBeGreaterThanOrEqual(180000);
    expect(parsed.stmts).toHaveLength(1);
    const raw = parsed as unknown as { stmts: { stmt: { SelectStmt: { intoClause: unknown } } }[] };
    expect(raw.stmts[0]!.stmt.SelectStmt.intoClause).toBeDefined();
  }, 20_000);
  test('preserves read-only CTE and multiple-statement ASTs for caller policy', async () => {
    const cte = await parsePostgres('WITH rows AS (SELECT 1 AS value) SELECT value FROM rows');
    expect(cte.stmts).toHaveLength(1);
    const pair = await parsePostgres('SELECT 1; SELECT 2;');
    expect(pair.stmts).toHaveLength(2);
  }, 20_000);
  test('rejects malformed SQL rather than returning a partial tree', async () => {
    await expect(parsePostgres('SELECT FROM (')).rejects.toThrow();
    expect((await parsePostgres('SELECT 2 AS value')).stmts).toHaveLength(1);
  }, 20_000);
});
