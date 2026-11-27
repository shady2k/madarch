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

/**
 * What one transaction remembers of a store: it reads what the process holds and its own writes, and
 * nothing it stages reaches the process until the owner commits. A rollback publishes nothing, so a
 * transaction that failed before COMMIT leaves no vertex remembered as standing (madarch-64o5.176).
 */
export class TransactionMemory<Key, Value> {
  private readonly staged = new Map<Key, Value | null>();
  constructor(private readonly committed: Map<Key, Value>) {}
  get(key: Key): Value | undefined {
    const held = this.staged.get(key);
    if (held !== undefined) return held ?? undefined;
    return this.committed.get(key);
  }
  set(key: Key, value: Value): void { this.staged.set(key, value); }
  /** Forgets the key when the transaction commits: a read after it looks the name up again. */
  forget(key: Key): void { this.staged.set(key, null); }
  /** Applies what the transaction staged; the owner calls it after COMMIT and never after a rollback. */
  publish(): void {
    for (const [key, value] of this.staged) if (value === null) this.committed.delete(key); else this.committed.set(key, value);
  }
}

/**
 * `memories` as this transaction sees it: `TransactionMemory` stages into the transaction and
 * publishes through `afterCommit`. A transaction that rolls back keeps its staged writes to itself,
 * so what a rolled-back transaction made is not answered as standing by the next one.
 */
export async function transactionMemoryIn<Key, Value>(tx: SqlExecutor, memories: WeakMap<DatabaseOwner, { readonly token: string; readonly value: Map<Key, Value> }>, create: () => Map<Key, Value>): Promise<TransactionMemory<Key, Value> | undefined> {
  const committed = await storeMemoryIn(tx, memories, create);
  if (committed === undefined) return undefined;
  const memory = new TransactionMemory(committed);
  tx.afterCommit?.(() => memory.publish());
  return memory;
}
