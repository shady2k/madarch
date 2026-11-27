/** Which store a transaction reads, so what a process remembers is never read against another (decision 0039). */
import { databaseOwnerOf, type DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';

/**
 * The identity of the store a transaction reads. A start over drops the schema and builds it
 * again, so the graph's own table is a fresh one: its oid is the token, and a thing remembered
 * about one store — a uid, an installed identity — is forgotten when the token moves rather than
 * read against the store that replaced it.
 */
const tokens = new WeakMap<SqlExecutor, Promise<string>>();
export async function storeIdentityIn(tx: SqlExecutor): Promise<string> {
  let held = tokens.get(tx);
  if (held === undefined) {
    held = withSpan('graph.store.identity', { 'db.system': 'postgres' }, async () => (await tx.query<{ token: string }>("SELECT coalesce(to_regclass('public.assertion')::oid::text,'-') AS token")).rows[0]!.token);
    tokens.set(tx, held);
  }
  return await held;
}

/**
 * What one process remembers about the store a transaction reads, made when the store is met and
 * kept while its token stands. A hold handed back is this process's own: two stores never share it,
 * and a start over hands back a fresh one rather than what was remembered of the store it replaced.
 */
export async function storeMemoryIn<Value>(tx: SqlExecutor, memories: WeakMap<DatabaseOwner, { readonly token: string; readonly value: Value }>, create: () => Value): Promise<Value | undefined> {
  const owner = databaseOwnerOf(tx);
  if (owner === undefined) return undefined;
  const token = await storeIdentityIn(tx);
  const held = memories.get(owner);
  if (held !== undefined && held.token === token) return held.value;
  const value = create();
  memories.set(owner, { token, value });
  return value;
}
