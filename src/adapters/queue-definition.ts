/** Shared queue names, settings and database mapping. No schema preparation. */
import type { Db } from 'pg-boss';
import type { DatabaseOwner } from './database-owner.js';
import type { QueueDeclaration } from '../fill/queue.js';
import { sha256Hex } from '../graph/digest.js';

export const DEFAULT_QUEUE_SCHEMA = 'pgboss';
export const ENQUEUE_STAMP_TABLE = 'madarch_enqueue_stamp';
export const QUEUE_SCHEMA_PARTS = ['pg-boss:12.38.0', 'madarch_enqueue_stamp:queue text primary key,enqueued_at timestamptz not null'];
export const QUEUE_SCHEMA_STAMP = sha256Hex(new TextEncoder().encode(QUEUE_SCHEMA_PARTS.join('\n')));

/** The owner's pool, shaped for pg-boss: one statement per call, batches through `exec`. */
export function ownerDatabase(owner: DatabaseOwner): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      if (values !== undefined && values.length > 0) {
        const { rows } = await owner.run((executor) => executor.query(text, values));
        return { rows };
      }
      const results = await owner.exec(text);
      return { rows: results.flatMap((result) => result.rows) };
    },
  };
}


/** A stored object's name, as the database itself takes one. */
const OBJECT_NAME = /^[\w.\-/]+$/;

function assertName(what: string, name: string): void {
  if (!OBJECT_NAME.test(name) || name.length > 50) {
    throw new Error(`the ${what} "${name}" is not a stored object's name: letters, digits, ".", "_", "-" and "/", at most 50 bytes`);
  }
}

/** The declaration's own fields, judged before anything is created, each fault naming the queue. */
export function assertDeclaration(declaration: QueueDeclaration, declared: ReadonlyMap<string, QueueDeclaration>): void {
  assertName('queue', declaration.name);
  const where = `the queue "${declaration.name}"`;
  if (!Number.isInteger(declaration.leaseSeconds) || declaration.leaseSeconds < 1) {
    throw new Error(`${where} was declared with the lease of ${String(declaration.leaseSeconds)} seconds: a lease is a whole number of seconds, at least 1`);
  }
  if (!Number.isInteger(declaration.retries) || declaration.retries < 0) {
    throw new Error(`${where} was declared with ${String(declaration.retries)} retries: retries are a whole number, 0 or more`);
  }
  if (!Number.isInteger(declaration.retryDelaySeconds) || declaration.retryDelaySeconds < 0) {
    throw new Error(`${where} was declared with the retry delay of ${String(declaration.retryDelaySeconds)} seconds: a retry delay is a whole number of seconds, 0 or more`);
  }
  if (declaration.heartbeatSeconds !== undefined && (!Number.isInteger(declaration.heartbeatSeconds) || declaration.heartbeatSeconds < 10)) {
    throw new Error(`${where} was declared with a heartbeat of ${String(declaration.heartbeatSeconds)} seconds: a heartbeat is a whole number of seconds, at least 10, or left out`);
  }
  if (declaration.deadLetter !== undefined) {
    assertName('dead letter queue', declaration.deadLetter);
    if (declaration.deadLetter === declaration.name) {
      throw new Error(`${where} names itself as its own dead letter queue: a dead letter queue is another queue`);
    }
    if (!declared.has(declaration.deadLetter)) {
      throw new Error(`${where} names the dead letter queue "${declaration.deadLetter}", which is not declared: declare it before the queue that fails into it`);
    }
  }
}

/** The pg-boss options one declaration maps to, in the shape both `createQueue` and `updateQueue` take. */
interface QueueSettings {
  policy: 'standard' | 'exclusive';
  expireInSeconds: number;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  heartbeatSeconds?: number;
  deadLetter?: string;
}

/** The pg-boss options one declaration maps to. */
export function queueOptions(declaration: QueueDeclaration): QueueSettings {
  return {
    policy: declaration.singletons === true ? 'exclusive' : 'standard',
    expireInSeconds: declaration.leaseSeconds,
    retryLimit: declaration.retries,
    retryDelay: declaration.retryDelaySeconds,
    retryBackoff: declaration.retryBackoff,
    ...(declaration.heartbeatSeconds === undefined ? {} : { heartbeatSeconds: declaration.heartbeatSeconds }),
    ...(declaration.deadLetter === undefined ? {} : { deadLetter: declaration.deadLetter }),
  };
}
