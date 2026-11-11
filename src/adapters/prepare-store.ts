/** The store owner is the only schema writer. Clients import store-readiness instead. */
import type { DatabaseOwner } from './database-owner.js';
import type { GraphContract } from '../graph/contract.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { prepareGraphSchema } from './schemas/graph.js';
import { fillStateSchema } from './schemas/fill-state.js';
import { orchestratorSchema } from './schemas/orchestrator.js';
import { fillSelectionSchema } from './schemas/fill-selection.js';
import { historySchema } from './schemas/history.js';
import { prepareQueueSchema } from './schemas/queue.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from './schema-lock.js';

/** Add module-owned schemas here, never in a reader or fill constructor. */
export interface StoreSchema {
  readonly name: string;
  prepare(owner: DatabaseOwner): Promise<void>;
}
const MODULE_SCHEMAS: readonly StoreSchema[] = [fillSelectionSchema, fillStateSchema, orchestratorSchema];
export interface PrepareStoreOptions {
  readonly contract?: GraphContract;
  readonly historyOnly?: boolean;
  readonly modules?: readonly StoreSchema[];
  readonly queue?: Parameters<typeof prepareQueueSchema>[1];
}
/** Called before publishing a store or changed contract to any client. */
export async function prepareStore(owner: DatabaseOwner, options: PrepareStoreOptions = {}): Promise<{ reset: boolean }> {
  await owner.ready;
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
