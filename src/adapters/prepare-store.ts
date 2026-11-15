/** The store owner is the only schema writer. Clients import store-readiness instead. */
import { withSpan } from '../obs/trace.js';
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
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength(SCHEMA_LOCK_SQL) }, async (span) => { const answer = await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]); span.setAttribute('db.rows', answer.rows.length); return answer; });
      // Writers that already started finish before these preservation checks; later writers cannot race the drop.
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('LOCK TABLE operation, fill_run IN ACCESS EXCLUSIVE MODE') }, async (span) => { const answer = await tx.query('LOCK TABLE operation, fill_run IN ACCESS EXCLUSIVE MODE'); span.setAttribute('db.rows', answer.rows.length); return answer; });
      const authored = await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength("SELECT EXISTS (SELECT 1 FROM operation WHERE author LIKE 'person:%') AS present") }, async (span) => { const answer = await tx.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM operation WHERE author LIKE 'person:%') AS present"); span.setAttribute('db.rows', answer.rows.length); return answer; });
      if (authored.rows[0]?.present === true) throw new Error(`${owner.location}:1: start over is refused: this store holds person-authored history; nothing was removed`);
      const live = await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength("SELECT 1 FROM fill_run WHERE state IN ('created', 'planning', 'running', 'pausing', 'cancelling') LIMIT 1") }, async (span) => { const answer = await tx.query("SELECT 1 FROM fill_run WHERE state IN ('created', 'planning', 'running', 'pausing', 'cancelling') LIMIT 1"); span.setAttribute('db.rows', answer.rows.length); return answer; });
      if (live.rows.length !== 0) throw new Error(`${owner.location}:1: a fill of this product is running; start over after it ends`);
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('DROP SCHEMA public CASCADE') }, async (span) => { const answer = await tx.query('DROP SCHEMA public CASCADE'); span.setAttribute('db.rows', answer.rows.length); return answer; });
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('DROP SCHEMA IF EXISTS madarch_meta CASCADE') }, async (span) => { const answer = await tx.query('DROP SCHEMA IF EXISTS madarch_meta CASCADE'); span.setAttribute('db.rows', answer.rows.length); return answer; });
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('DROP SCHEMA IF EXISTS pgboss CASCADE') }, async (span) => { const answer = await tx.query('DROP SCHEMA IF EXISTS pgboss CASCADE'); span.setAttribute('db.rows', answer.rows.length); return answer; });
      await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('CREATE SCHEMA public') }, async (span) => { const answer = await tx.query('CREATE SCHEMA public'); span.setAttribute('db.rows', answer.rows.length); return answer; });
    });
  }

  await owner.transaction('write', async (tx) => {
    await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength(SCHEMA_LOCK_SQL) }, async (span) => { const answer = await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]); span.setAttribute('db.rows', answer.rows.length); return answer; });
    await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength('CREATE EXTENSION IF NOT EXISTS btree_gist') }, async (span) => { const answer = await tx.query('CREATE EXTENSION IF NOT EXISTS btree_gist'); span.setAttribute('db.rows', answer.rows.length); return answer; });
  });
  await historySchema.prepare(owner);
  if (options.historyOnly === true) return { reset: false };
  const held = await owner.transaction('snapshot', async (tx) => await withSpan('db.query', { 'db.system': 'postgres', 'db.sql.bytes': Buffer.byteLength("SELECT 1 FROM madarch_meta.schema_stamp WHERE name = 'one-graph'") }, async (span) => { const answer = await tx.query("SELECT 1 FROM madarch_meta.schema_stamp WHERE name = 'one-graph'"); span.setAttribute('db.rows', answer.rows.length); return answer; }));
  const graph = options.contract !== undefined || held.rows.length === 0
    ? await prepareGraphSchema(owner, options.contract ?? EMPTY_CONTRACT)
    : { reset: false };
  for (const schema of [...MODULE_SCHEMAS, ...(options.modules ?? [])]) await schema.prepare(owner);
  await prepareQueueSchema(owner, options.queue);
  return graph;
}
