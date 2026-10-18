/**
 * The queue's pg-boss adapter (decision 0027, "Queue"): `QueueService`
 * (`src/fill/queue.ts`) served by pg-boss, running on the process's one
 * database owner (madarch-tzte.19.1) instead of a database or a pool of its
 * own. A PGlite owner hands pg-boss the adapter's own `fromPglite` over the
 * owner's one connection, which is what makes the queue's tables live in the
 * same database as the fact log, the query projection and the orchestrator's
 * tables; a PostgreSQL owner gets a thin `IDatabase` over the pool the owner
 * already holds. Either way every statement pg-boss sends takes the owner's
 * queue like any other work, so a claim, a settlement and a maintenance pass
 * are short transactions that can never land inside someone else's.
 *
 * Two shapes reach the owner. The ordinary one is a statement with parameters
 * (`run`); the other is the schema creation and the migrations pg-boss sends as
 * one `BEGIN … COMMIT` text with none, which `DatabaseOwner.exec` carries
 * (madarch-tzte.19.2 added it for exactly this). An operation given a caller's
 * transaction runs its statement inside it through that transaction and never
 * touches the owner's queue: that is how decision 0027's publication enqueues or
 * settles beside the facts it writes, in one short transaction.
 *
 * The adapter adds no policy of its own beyond the mapping: `singletons` is
 * pg-boss's `exclusive` queue policy, the lease is `expireInSeconds`, the
 * retries are `retryLimit`, and the dead letter queue is the one pg-boss routes
 * a spent job into. Declarations are remembered here so an operation on a queue
 * nobody declared is refused by this adapter, naming the queue, rather than by
 * the SQL that then could not name it.
 */
import { PgBoss, fromPglite } from 'pg-boss';
import type { CommandResponse, Db, Job, JobAttempt, JobWithMetadata, PgBoss as PgBossInstance } from 'pg-boss';
import { byCodePoint } from '../model/order.js';
import type { DatabaseOwner } from './database-owner.js';
import type { OuterTransaction } from '../history/types.js';
import type {
  ClaimedJob,
  ClaimRequest,
  DeadLetter,
  EnqueueRequest,
  EnqueueResult,
  FailOutcome,
  QueueDeclaration,
  QueueService,
} from '../fill/queue.js';

/** The schema pg-boss's own tables live in, in the database the owner holds. */
export const DEFAULT_QUEUE_SCHEMA = 'pgboss';

/** The most dead letters one read answers: the bound the database itself takes for a list read. */
const MAX_DEAD_LETTERS = 100_000;

export interface PgBossQueueOptions {
  /** The process's database owner, opened once and lent: the queue never opens a second database. */
  owner: DatabaseOwner;
  /** The schema the queue's tables live in; `pgboss` when it is left out. */
  schema?: string;
  /**
   * Whether the adapter runs pg-boss's own background passes while the process
   * lives: expired leases and quiet heartbeats are recovered there without
   * anyone asking. On by default; a test that wants recovery only when it asks
   * for it turns it off.
   */
  supervise?: boolean;
  /**
   * How many seconds apart those passes run, at least 1 and at most 3600; 60
   * when it is left out. A shorter interval recovers a killed worker sooner and
   * costs the database a pass per interval. It is also the interval at which a
   * queue's own sweep comes due — pg-boss sweeps a queue only when its monitor
   * claim is due, which it otherwise takes once a minute whatever this is — so
   * `recover` inside that window asks for a pass the queue is not due yet and
   * the next pass takes it.
   */
  superviseIntervalSeconds?: number;
}

/** The shape pg-boss's PGlite adapter reads: a query and a batch, both on the owner's one connection. */
interface PgliteFace {
  query<Row = unknown>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  exec(text: string): Promise<{ rows: unknown[] }[]>;
}

/** The owner's one connection, shaped for pg-boss's own PGlite adapter. */
function pgliteFace(owner: DatabaseOwner): PgliteFace {
  return {
    query: async <Row>(text: string, values?: unknown[]) => {
      const { rows } = await owner.run((executor) => executor.query<Row & object>(text, values));
      return { rows };
    },
    exec: async (text: string) => {
      const results = await owner.exec(text);
      return results.map((result) => ({ rows: result.rows as unknown[] }));
    },
  };
}

/** The owner's pool, shaped for pg-boss: one statement per call, batches through `exec`. */
function ownerDatabase(owner: DatabaseOwner): Db {
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

/** A caller's transaction, shaped for pg-boss: `db` in the options of one call. */
function transactionDatabase(transaction: OuterTransaction): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      const { rows } = await transaction.query(text, values);
      return { rows };
    },
  };
}

/**
 * Whether pg-boss settled the job the call named. The published type of the
 * answer it hands back is empty, while the runtime answers `{ jobs, requested,
 * affected, settled }`; a count of zero is what it reports for a job that was
 * not the attempt in force any more, which is exactly the late worker's answer.
 * The count is read through the runtime shape and pinned by the tests.
 */
function settled(answer: CommandResponse): boolean {
  const affected = (answer as { affected?: number }).affected;
  return typeof affected === 'number' && affected > 0;
}

/** A stored object's name, as the database itself takes one. */
const OBJECT_NAME = /^[\w.\-/]+$/;

function assertName(what: string, name: string): void {
  if (!OBJECT_NAME.test(name) || name.length > 50) {
    throw new Error(`the ${what} "${name}" is not a stored object's name: letters, digits, ".", "_", "-" and "/", at most 50 bytes`);
  }
}

/** The declaration's own fields, judged before anything is created, each fault naming the queue. */
function assertDeclaration(declaration: QueueDeclaration, declared: ReadonlyMap<string, QueueDeclaration>): void {
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
function queueOptions(declaration: QueueDeclaration): QueueSettings {
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

/**
 * The job of one attempt, in the shape every settle and refresh takes: its id
 * and the attempt it was claimed as. pg-boss fences the statement to that
 * attempt, so a worker whose claim was handed out again cannot settle it.
 */
function attemptOf(job: ClaimedJob): JobAttempt {
  return { id: job.id, retryCount: job.attempt };
}

/** The reason a failed attempt carried, as pg-boss stores it on the job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null;
  const value = (output as { value?: unknown }).value;
  if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return null;
}

class PgBossQueue implements QueueService {
  private readonly declared = new Map<string, QueueDeclaration>();

  constructor(private readonly boss: PgBossInstance, private readonly location: string) {}

  private declarationOf(queue: string): QueueDeclaration {
    const declaration = this.declared.get(queue);
    if (declaration === undefined) {
      throw new Error(`the queue "${queue}" was never declared on the database owner "${this.location}": declare it before enqueuing, claiming or settling work in it`);
    }
    return declaration;
  }

  async declare(declaration: QueueDeclaration): Promise<void> {
    // A declaration is applied to the queue as it stands, not only to a queue that
    // does not exist yet: pg-boss creates a queue once and its `create_queue` never
    // touches the row again, so a product that changes a stage's limits would
    // otherwise keep the old ones silently. The singleton rule is the exception,
    // which pg-boss refuses to change after creation; this adapter refuses it by
    // name before that.
    const judged: QueueDeclaration = {
      name: declaration.name,
      leaseSeconds: declaration.leaseSeconds,
      retries: declaration.retries,
      retryDelaySeconds: declaration.retryDelaySeconds,
      retryBackoff: declaration.retryBackoff,
      ...(declaration.heartbeatSeconds === undefined ? {} : { heartbeatSeconds: declaration.heartbeatSeconds }),
      ...(declaration.singletons === undefined ? {} : { singletons: declaration.singletons }),
      ...(declaration.deadLetter === undefined ? {} : { deadLetter: declaration.deadLetter }),
    };
    assertDeclaration(judged, this.declared);
    await this.boss.createQueue(judged.name, queueOptions(judged));
    const existing = await this.boss.getQueue(judged.name);
    const holdsSingletons = existing !== null && existing.policy === 'exclusive';
    if (existing !== null && holdsSingletons !== (judged.singletons === true)) {
      throw new Error(
        `the queue "${judged.name}" was already created ${holdsSingletons ? 'holding one unfinished job per singleton key' : 'holding no singletons'}, and a queue's singleton rule cannot change after it is created: take the change to a queue of its own name, or declare it as it stands`,
      );
    }
    const { policy, ...updatable } = queueOptions(judged);
    try {
      await this.boss.updateQueue(judged.name, {
        ...updatable,
        // Absent means "no heartbeat" and "no dead letter queue", and pg-boss reads
        // an absent key as "leave as it was": nulls are the way to say the queue has
        // none.
        heartbeatSeconds: judged.heartbeatSeconds ?? null,
        deadLetter: judged.deadLetter ?? null,
      });
    } catch (error) {
      // The declaration did not land: the queue stands as the earlier one left it,
      // or as this declaration's own `createQueue` created it, and this service
      // does not hold it. Said here, because the caller's next call would
      // otherwise be refused as if it had never declared the queue at all.
      throw new Error(`the queue "${judged.name}" was created but its settings were not applied, so it stands as it was: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.declared.set(judged.name, judged);
  }

  async enqueue<Data>(request: EnqueueRequest<Data>): Promise<EnqueueResult> {
    const declaration = this.declarationOf(request.queue);
    if (declaration.singletons === true && request.singletonKey === undefined) {
      throw new Error(`the queue "${request.queue}" holds one unfinished job per singleton key, and the enqueue named none: pass the key the job is unique by`);
    }
    if (request.singletonKey === '') {
      throw new Error(`the enqueue into the queue "${request.queue}" named an empty singleton key: a key is the name a job is unique by, and the queue folds an empty one with no key at all, so it would hold every job of the queue back`);
    }
    if (declaration.singletons !== true && request.singletonKey !== undefined) {
      throw new Error(`the queue "${request.queue}" holds no singletons, and the enqueue named the singleton key "${request.singletonKey}": a key only holds a job back on a queue declared with singletons`);
    }
    if (request.priority !== undefined && !Number.isInteger(request.priority)) {
      throw new Error(`the enqueue into the queue "${request.queue}" named the priority ${String(request.priority)}: a priority is a whole number, higher claimed first`);
    }
    const id = await this.boss.send({
      name: request.queue,
      data: request.data as object,
      options: {
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.singletonKey === undefined ? {} : { singletonKey: request.singletonKey }),
        ...(request.startAfter === undefined ? {} : { startAfter: request.startAfter }),
        ...(request.transaction === undefined ? {} : { db: transactionDatabase(request.transaction) }),
      },
    });
    return id === null ? { created: false, id: null } : { created: true, id };
  }

  async claim<Data>(request: ClaimRequest): Promise<ClaimedJob<Data>[]> {
    this.declarationOf(request.queue);
    const limit = request.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`the claim of the queue "${request.queue}" asked for ${String(request.limit)} jobs: a claim takes a whole number of jobs, at least 1`);
    }
    // pg-boss picks the batch by priority (highest first) and creation time, but the
    // rows an `UPDATE … RETURNING` hands back are in no promised order, so the batch
    // is ordered here: highest priority, then oldest, then by id in code point order,
    // which is what makes two claims of the same rows answer the same order. The
    // metadata carries the priority and the creation time that ordering reads.
    const jobs = await this.boss.fetch<Data & object>(request.queue, { batchSize: limit, includeMetadata: true });
    return jobs
      .slice()
      .sort((left, right) => right.priority - left.priority || left.createdOn.getTime() - right.createdOn.getTime() || byCodePoint(left.id, right.id))
      .map((job) => this.claimed(job));
  }

  private claimed<Data>(job: JobWithMetadata<Data>): ClaimedJob<Data> {
    return {
      id: job.id,
      queue: job.name,
      attempt: job.retryCount,
      // The job's own allowance, not the queue's latest declaration: pg-boss
      // stamps it on the job when it is enqueued, and a settle is judged by it.
      retries: job.retryLimit,
      data: job.data,
      leaseSeconds: job.expireInSeconds,
    };
  }

  /**
   * The job as this queue's own, refusing one claimed from another: a settle or
   * a heartbeat naming the wrong queue would settle nothing and read as a lost
   * claim, which hides the caller's mistake behind the queue's own answer.
   */
  private jobOf(queue: string, job: ClaimedJob): JobAttempt {
    this.declarationOf(queue);
    if (job.queue !== queue) {
      throw new Error(`the job "${job.id}" was claimed from the queue "${job.queue}", and it was given to the queue "${queue}": settle or heartbeat a job in the queue it was claimed from`);
    }
    return attemptOf(job);
  }

  async heartbeat(queue: string, job: ClaimedJob): Promise<boolean> {
    const answer = await this.boss.touch(queue, this.jobOf(queue, job));
    return settled(answer);
  }

  async complete(queue: string, job: ClaimedJob, output?: object, transaction?: OuterTransaction): Promise<boolean> {
    const answer = await this.boss.complete(queue, this.jobOf(queue, job), output ?? null, transaction === undefined ? undefined : { db: transactionDatabase(transaction) });
    return settled(answer);
  }

  async fail(queue: string, job: ClaimedJob, reason: string, transaction?: OuterTransaction): Promise<FailOutcome> {
    const attempt = this.jobOf(queue, job);
    const answer = await this.boss.fail(queue, attempt, { value: { message: reason } }, transaction === undefined ? undefined : { db: transactionDatabase(transaction) });
    if (!settled(answer)) {
      throw new Error(`the job "${job.id}" of the queue "${queue}" was not failed: its attempt ${String(job.attempt)} is no longer the one the queue hands out, or the claim lapsed and the job is already somewhere else`);
    }
    // The answer is what the settlement did, and pg-boss judges it on the job's
    // own allowance (`retry_count < retry_limit`), which the job carries from
    // its enqueue. Reading the queue's latest declaration here would answer
    // `retry` for a job pg-boss has just failed for good.
    return job.attempt < job.retries ? 'retry' : 'failed';
  }

  async recover(queue: string): Promise<void> {
    this.declarationOf(queue);
    await this.boss.supervise(queue);
  }

  async deadLetters<Data>(queue: string, options?: { limit?: number }): Promise<DeadLetter<Data>[]> {
    const declaration = this.declarationOf(queue);
    if (declaration.deadLetter === undefined) {
      return [];
    }
    const limit = options?.limit ?? MAX_DEAD_LETTERS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEAD_LETTERS) {
      throw new Error(`the read of the queue "${queue}"'s dead letters asked for ${String(options?.limit)} of them: a limit is a whole number between 1 and ${String(MAX_DEAD_LETTERS)}`);
    }
    // The queue lists its dead letters oldest first and offers no order of its
    // own, so the whole list is read — at most the bound the database takes for
    // one read — and the newest of it are answered. Asking the queue for `limit`
    // rows directly would answer the *oldest* ones, which is not what "newest
    // first, at most the number asked for" means.
    const jobs = await this.boss.findJobs<Data & object>(declaration.deadLetter, { limit: MAX_DEAD_LETTERS });
    return jobs
      .map((job) => this.deadLetter(job, declaration.deadLetter as string))
      .sort((left, right) => right.deadLetteredAt - left.deadLetteredAt)
      .slice(0, limit);
  }

  private deadLetter<Data>(job: JobWithMetadata<Data>, deadLetterQueue: string): DeadLetter<Data> {
    return {
      // The copy has an id of its own; the job it was copied from is the source
      // pg-boss keeps beside it.
      id: job.id,
      jobId: job.sourceId ?? job.id,
      queue: deadLetterQueue,
      sourceQueue: job.sourceName,
      data: job.data,
      reason: reasonOf(job.sourceOutput),
      retriesSpent: job.sourceRetryCount ?? 0,
      deadLetteredAt: job.createdOn.getTime(),
    };
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: false });
  }
}

/**
 * Opens the queue on the process's database owner: pg-boss's own tables are
 * created or migrated in that database at once, and the service is ready to have
 * its queues declared. The owner is never closed by the queue; the caller that
 * opened it closes it, after `stop()`.
 */
export async function createPgBossQueue(options: PgBossQueueOptions): Promise<QueueService> {
  const { owner } = options;
  const database = owner.backend === 'pglite' ? fromPglite(pgliteFace(owner)) : ownerDatabase(owner);
  const superviseInterval = options.superviseIntervalSeconds ?? 60;
  const boss = new PgBoss({
    // The owner names the engine; pg-boss's profiles for the two are the same
    // set of gates, and naming the one the database really is keeps its own
    // diagnostics honest.
    backend: owner.backend,
    db: database,
    schema: options.schema ?? DEFAULT_QUEUE_SCHEMA,
    supervise: options.supervise ?? true,
    superviseIntervalSeconds: superviseInterval,
    // Without this, a queue's monitor claim (taken for a minute whatever the
    // pass interval is) would hold back the very recovery a shorter interval
    // was set for.
    monitorIntervalSeconds: superviseInterval,
    schedule: false,
  });
  await boss.start();
  return new PgBossQueue(boss, owner.location);
}
