/** The store owner is the only schema writer. Clients import store-readiness instead. */
import type { DatabaseOwner } from './database-owner.js';
import type { GraphContract } from '../graph/contract.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { prepareGraphSchema } from './schemas/graph.js';
import { fillStateSchema } from './schemas/fill-state.js';
import { orchestratorSchema } from './schemas/orchestrator.js';
import { agentUsageSchema } from './schemas/agent-usage.js';
import { historySchema } from './schemas/history.js';
import { prepareQueueSchema } from './schemas/queue.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from './schema-lock.js';

/** Add module-owned schemas here, never in a reader or fill constructor. */
export interface StoreSchema {
  readonly name: string;
  prepare(owner: DatabaseOwner): Promise<void>;
}
const MODULE_SCHEMAS: readonly StoreSchema[] = [fillStateSchema, orchestratorSchema, agentUsageSchema];
export interface PrepareStoreOptions {
  readonly contract?: GraphContract;
  readonly reset?: boolean;
  readonly historyOnly?: boolean;
  readonly modules?: readonly StoreSchema[];
  readonly queue?: Parameters<typeof prepareQueueSchema>[1];
}
/** Called before publishing a store or changed contract to any client. */
export async function prepareStore(owner: DatabaseOwner, options: PrepareStoreOptions = {}): Promise<{ reset: boolean }> {
  await owner.ready;
  if (options.reset === true) {
    await owner.transaction('write', async (tx) => {
      await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
      // Writers that already started finish before these preservation checks; later writers cannot race the drop.
      await tx.query('LOCK TABLE operation, fill_run IN ACCESS EXCLUSIVE MODE');
      const authored = await tx.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM operation WHERE author LIKE 'person:%') AS present");
      if (authored.rows[0]?.present === true) throw new Error(`${owner.location}:1: start over is refused: this store holds person-authored history; nothing was removed`);
      const live = await tx.query("SELECT 1 FROM fill_run WHERE state IN ('created', 'planning', 'running', 'pausing', 'cancelling') LIMIT 1");
      if (live.rows.length !== 0) throw new Error(`${owner.location}:1: a fill of this product is running; start over after it ends`);
      await tx.query('DROP SCHEMA public CASCADE');
      await tx.query('DROP SCHEMA IF EXISTS madarch_meta CASCADE');
      await tx.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
      await tx.query('CREATE SCHEMA public');
    });
  }

  await owner.transaction('write', async (tx) => {
    await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
    await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
  });
  await historySchema.prepare(owner);
  if (options.historyOnly === true) return { reset: false };
  const held = await owner.transaction('snapshot', async (tx) => await tx.query("SELECT 1 FROM madarch_meta.schema_stamp WHERE name = 'one-graph'"));
  const graph = options.contract !== undefined || held.rows.length === 0
    ? await prepareGraphSchema(owner, options.contract ?? EMPTY_CONTRACT)
    : { reset: false };
  for (const schema of [...MODULE_SCHEMAS, ...(options.modules ?? [])]) await schema.prepare(owner);
  await prepareQueueSchema(owner, options.queue);
  return graph;
}
