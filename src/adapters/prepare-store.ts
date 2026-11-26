import { withSpan } from '../obs/trace.js';
/** The store owner is the only schema writer. Clients import store-readiness instead. */
import type { DatabaseOwner } from './database-owner.js';
import type { GraphContract } from '../graph/contract.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { withAssertionContract } from '../graph/system-contract.js';
import { validateValueContracts } from '../graph/value-validation.js';
import { prepareGraphSchema } from './schemas/graph.js';
import { agentUsageSchema } from './schemas/agent-usage.js';
import { historySchema } from './schemas/history.js';
import { prepareQueueSchema } from './schemas/queue.js';
import { readKindAssertions } from '../graph/records.js';
import { acquireGraphWriteLock } from '../graph/write.js';
import { authoredHistoryIn } from './authored-import.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from './schema-lock.js';

/** Add module-owned schemas here, never in a reader or fill constructor. */
export interface StoreSchema {
  readonly name: string;
  prepare(owner: DatabaseOwner): Promise<void>;
}
const MODULE_SCHEMAS: readonly StoreSchema[] = [agentUsageSchema];
export interface PrepareStoreOptions {
  readonly contract?: GraphContract;
  readonly reset?: boolean;
  readonly historyOnly?: boolean;
  readonly modules?: readonly StoreSchema[];
  readonly queue?: Parameters<typeof prepareQueueSchema>[1];
}
/** Called before publishing a store or changed contract to any client. */
export async function prepareStore(owner: DatabaseOwner, options: PrepareStoreOptions = {}): Promise<{ reset: boolean }> {
  if (options.contract !== undefined) validateValueContracts(withAssertionContract(options.contract));
  await owner.ready;
  if (options.reset === true) {
    await owner.transaction('write', async (tx) => {
      await acquireGraphWriteLock(tx);
      await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]));
      // Writers that already started finish before these preservation checks; later writers cannot race the drop.
      const graphInstalled = (await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query<{ installed: boolean }>("SELECT to_regclass('public.assertion') IS NOT NULL AS installed"))).rows[0]!.installed;
      if (await authoredHistoryIn(tx)) throw new Error(`${owner.location}:1: start over is refused: this store holds person-authored history; nothing was removed`);
      const live = graphInstalled ? await readKindAssertions(tx, 'vertex', 'system.run', ['state']) : [];
      if (live.some(run => !['succeeded', 'failed', 'cancelled'].includes(String(run.values['state'])))) throw new Error(`${owner.location}:1: a fill of this product is running; start over after it ends`);
      await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query('DROP SCHEMA public CASCADE'));
      await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query('DROP SCHEMA IF EXISTS madarch_meta CASCADE'));
      await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query('DROP SCHEMA IF EXISTS pgboss CASCADE'));
      await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query('CREATE SCHEMA public'));
    });
  }

  await owner.transaction('write', async (tx) => {
    await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]));
    await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist'));
  });
  await historySchema.prepare(owner);
  if (options.historyOnly === true) return { reset: false };
  const held = await owner.transaction('snapshot', async (tx) => await withSpan('db.prepare-store.prepareStore', { 'db.system': 'postgres' }, async () => await tx.query("SELECT 1 FROM madarch_meta.schema_stamp WHERE name = 'one-graph'")));
  const graph = options.contract !== undefined || held.rows.length === 0
    ? await prepareGraphSchema(owner, options.contract ?? EMPTY_CONTRACT)
    : { reset: false };
  for (const schema of [...MODULE_SCHEMAS, ...(options.modules ?? [])]) await schema.prepare(owner);
  await prepareQueueSchema(owner, options.queue);
  return graph;
}
