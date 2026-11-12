/** Shared store schema lock identity; this module executes no SQL. */
import { sha256Hex } from '../graph/digest.js';

/**
 * The advisory lock one schema's creation takes, from the schema's own name: PostgreSQL does not make `CREATE SCHEMA IF
 * NOT EXISTS` or `CREATE TABLE IF NOT EXISTS` safe under concurrency — two connections pass the existence check and the
 * second insert into `pg_namespace` fails with a duplicate key (CI run 42498133661: `duplicate key value violates unique
 * constraint "pg_namespace_nspname_index"`, three processes of one store making the schema at once). The lock is
 * transaction-scoped: the transaction that holds it makes the schema and writes the stamp, and the next caller finds
 * both. It is derived from the name, so every process of every store computes the same key.
 */
function lockKeyOf(name: string): string {
  return BigInt(`0x${sha256Hex(new TextEncoder().encode(`madarch:schema:${name}`)).slice(0, 15)}`).toString();
}

/**
 * One key for every schema one store makes, so the schemas of one store are made one at a time, whatever their names: the
 * stamp's own schema (`madarch_meta`) is made by all of them, and two of them under different keys would race over it.
 */
const STORE_SCHEMA_LOCK = lockKeyOf('store');

/** The key of the store's schema lock, for a schema creator that opens its own transaction. */
export function storeSchemaLockKey(): string {
  return STORE_SCHEMA_LOCK;
}

/** The one statement that takes the store's schema lock inside a transaction the caller already holds. */
export const SCHEMA_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1::bigint)';
