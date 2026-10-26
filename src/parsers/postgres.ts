/** Shared PostgreSQL syntax parser only. Admission policy belongs to each caller.
 * libpg-query is the pinned PostgreSQL 18 C parser compiled to WebAssembly.
 * This module neither executes SQL nor treats syntax as a read-only guarantee.
 */
import { parse, type ParseResult } from 'libpg-query';
export type { ParseResult } from 'libpg-query';
export async function parsePostgres(sql: string): Promise<ParseResult> {
  return await parse(sql);
}
