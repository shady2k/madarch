/** Queue installation. Only central store preparation calls prepareQueueSchema. */
import { PgBoss } from 'pg-boss';
import type { DatabaseOwner } from '../database-owner.js';
import type { QueueDeclaration } from '../../fill/queue.js';
import { createSchemaOnce } from '../schema-stamp.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from '../schema-lock.js';
import { assertDeclaration, DEFAULT_QUEUE_SCHEMA, ENQUEUE_STAMP_TABLE, ownerDatabase, QUEUE_SCHEMA_PARTS, queueOptions } from '../queue-definition.js';

/** Queue declarations installed by store preparation. Clients may update their mutable settings. */
const FILL_QUEUES: readonly QueueDeclaration[] = [
  { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
  { name: 'fill-units', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true },
];

export interface QueueSchemaOptions {
  readonly schema?: string;
  /** Explicit queue set, in dead-letter dependency order; the fixed fill queues when omitted. */
  readonly declarations?: readonly QueueDeclaration[];
}

/**
 * Installs dependency-owned queue DDL only at the central store preparation boundary.
 * The shared store lock covers installation and its readiness stamp. pg-boss
 * owns its migration transactions on a separate connection of the owner pool.
 */
export async function prepareQueueSchema(owner: DatabaseOwner, options: QueueSchemaOptions = {}): Promise<void> {
  const schema = options.schema ?? DEFAULT_QUEUE_SCHEMA;
  const declarations = options.declarations ?? FILL_QUEUES;
  const declared = new Map<string, QueueDeclaration>();
  for (const declaration of declarations) {
    assertDeclaration(declaration, declared);
    declared.set(declaration.name, declaration);
  }
  // pg-boss sends BEGIN/COMMIT migration scripts, so its database cannot be
  // the transaction holding our lock. Start that transaction in a sibling async
  // context instead: it signals acquisition, waits while pg-boss uses another
  // pool connection, then records readiness only on success. The finally below
  // always releases the waiter and awaits commit/rollback before returning.
  // This requires at least two pool connections (store owners have eight).
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  let release!: (prepared: boolean) => void;
  const finished = new Promise<boolean>((resolve) => { release = resolve; });
  const holding = owner.transaction('write', async (transaction) => {
    await transaction.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
    acquired();
    if (await finished) {
      await createSchemaOnce({ transaction: async (_kind, work) => await work(transaction) }, {
        name: `queue:${schema}`, parts: QUEUE_SCHEMA_PARTS, tables: [], create: async () => {},
      });
    }
  });
  holding.catch(failed);
  await ready;
  let prepared = false;
  try {
    const boss = new PgBoss({
      backend: 'postgres', db: ownerDatabase(owner), schema,
      supervise: false, schedule: false, persistQueueStats: false, reindex: false,
    });
    boss.on('error', (error: Error) => console.error(`pg-boss preparation at ${owner.location}: ${error.message}`));
    try {
      await boss.start();
      for (const declaration of declarations) {
        await boss.createQueue(declaration.name, queueOptions(declaration));
        const existing = await boss.getQueue(declaration.name);
        if ((existing?.policy === 'exclusive') !== (declaration.singletons === true)) {
          throw new Error(`the queue "${declaration.name}" has a different singleton rule in ${owner.location}: prepare a queue of its own name rather than changing its policy`);
        }
      }
      await owner.run((executor) => executor.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.${ENQUEUE_STAMP_TABLE} (queue text PRIMARY KEY, enqueued_at timestamp with time zone NOT NULL)`,
      ));
      prepared = true;
    } finally {
      await boss.stop({ graceful: false });
    }
  } finally {
    release(prepared);
    await holding;
  }
}
