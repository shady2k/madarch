/**
 * The queue's pg-boss adapter (decision 0027, "Queue"): `QueueService`
 * (`src/fill/queue.ts`) served by pg-boss, running on the process's one
 * database owner (madarch-tzte.19.1) instead of a database or a pool of its
 * own. pg-boss is handed a thin `IDatabase` over the pool the owner already
 * holds, which is what makes the queue's tables live in the same database as
 * the fact log, the query projection and the orchestrator's tables, and every
 * statement pg-boss sends takes the owner's queue like any other work, so a
 * claim, a settlement and a maintenance pass are short transactions that can
 * never land inside someone else's.
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
 *
 * pg-boss owns enqueue ordering, locking, expiry and retries (0039 item 24).
 */
import { PgBoss } from 'pg-boss';
import type { CommandResponse, Db, JobAttempt, JobWithMetadata, PgBoss as PgBossInstance } from 'pg-boss';
import { assertDeclaration, DEFAULT_QUEUE_SCHEMA, ownerDatabase, QUEUE_SCHEMA_STAMP, queueOptions } from './queue-definition.js';
export { DEFAULT_QUEUE_SCHEMA } from './queue-definition.js';
import { withSpan } from '../obs/trace.js';
import { raise } from '../model/raise.js';
import { byCodePoint } from '../model/order.js';
import type { DatabaseOwner } from './database-owner.js';
import { requireSchema } from './store-readiness.js';
import type { OuterTransaction } from '../history-types.js';
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
  /** Where a pg-boss error is logged; the process's error stream when it is left out. */
  log?: (line: string) => void;
}

/** A caller's transaction, shaped for pg-boss: `db` in the options of one call. */
function transactionDatabase(transaction: OuterTransaction): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      const { rows } = await withSpan('db.pg-boss-queue.transactionDatabase', { 'db.system': 'postgres' }, async () => await transaction.query(text, values));
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
  private stopping: Promise<void> | undefined;
  private readonly detach: () => void;

  constructor(
    private readonly boss: PgBossInstance,
    /** The owner of every queue transaction. */
    private readonly owner: DatabaseOwner,
    /** The schema of pg-boss's own tables. */
    private readonly schema: string,
  ) {
    this.detach = owner.onClose(async () => { await this.stop(); });
  }

  private declarationOf(queue: string): QueueDeclaration {
    const declaration = this.declared.get(queue);
    if (declaration === undefined) {
      raise(`the queue "${queue}" was never declared on the database owner "${this.owner.location}": declare it before enqueuing, claiming or settling work in it`);
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
    const existing = await this.boss.getQueue(judged.name);
    if (existing === null) {
      raise(`the queue "${judged.name}" is not prepared in ${this.owner.location}: prepare the store with this queue declaration before opening its clients`);
    }
    const holdsSingletons = existing !== null && existing.policy === 'exclusive';
    if (existing !== null && holdsSingletons !== (judged.singletons === true)) {
      raise(
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
      // The declaration did not land, so this client does not hold it.
      raise(`the queue "${judged.name}" settings were not applied, so it stands as it was: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.declared.set(judged.name, judged);
  }

  async enqueue<Data>(request: EnqueueRequest<Data>): Promise<EnqueueResult> {
    const declaration = this.declarationOf(request.queue);
    if (declaration.singletons === true && request.singletonKey === undefined) {
      raise(`the queue "${request.queue}" holds one unfinished job per singleton key, and the enqueue named none: pass the key the job is unique by`);
    }
    if (request.singletonKey === '') {
      raise(`the enqueue into the queue "${request.queue}" named an empty singleton key: a key is the name a job is unique by, and the queue folds an empty one with no key at all, so it would hold every job of the queue back`);
    }
    if (declaration.singletons !== true && request.singletonKey !== undefined) {
      raise(`the queue "${request.queue}" holds no singletons, and the enqueue named the singleton key "${request.singletonKey}": a key only holds a job back on a queue declared with singletons`);
    }
    if (request.priority !== undefined && !Number.isInteger(request.priority)) {
      raise(`the enqueue into the queue "${request.queue}" named the priority ${String(request.priority)}: a priority is a whole number, higher claimed first`);
    }
    const enqueued = async (transaction: OuterTransaction): Promise<EnqueueResult> => {
      const id = await this.boss.send({
        name: request.queue,
        data: request.data as object,
        options: {
          ...(request.priority === undefined ? {} : { priority: request.priority }),
          ...(request.singletonKey === undefined ? {} : { singletonKey: request.singletonKey }),
          ...(request.startAfter === undefined ? {} : { startAfter: request.startAfter }),
          db: transactionDatabase(transaction),
        },
      });
      if (id === null) return { created: false, id: null };
      return { created: true, id };
    };
    return request.transaction === undefined ? this.owner.transaction('write', enqueued) : enqueued(request.transaction);
  }

  async claim<Data>(request: ClaimRequest): Promise<ClaimedJob<Data>[]> {
    this.declarationOf(request.queue);
    const limit = request.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 1) {
      raise(`the claim of the queue "${request.queue}" asked for ${String(request.limit)} jobs: a claim takes a whole number of jobs, at least 1`);
    }
    // pg-boss owns batch selection. Sort the returned rows deterministically;
    // equal creation instants do not imply a separate enqueue-order mechanism.
    const jobs = await withSpan('queue.claim', { 'madarch.queue': request.queue }, async () => await this.boss.fetch<Data & object>(request.queue, { batchSize: limit, includeMetadata: true }));
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
      raise(`the job "${job.id}" was claimed from the queue "${job.queue}", and it was given to the queue "${queue}": settle or heartbeat a job in the queue it was claimed from`);
    }
    return attemptOf(job);
  }

  async fence(job: ClaimedJob, transaction: OuterTransaction): Promise<boolean> {
    this.jobOf(job.queue, job);
    return await withSpan('queue.fence', { 'madarch.queue': job.queue, 'madarch.attempt': job.attempt }, async () => {
      // Lock first, then sample database time: a lock wait must not accept an
      // attempt using the statement's earlier snapshot time. The lock also
      // serializes pg-boss complete, retry, cancellation and expiry transitions.
      const locked = await transaction.query<{ id: string }>(
        `SELECT id FROM ${this.schema}.job WHERE name = $1 AND id = $2::uuid FOR UPDATE`,
        [job.queue, job.id],
      );
      if (locked.rows.length === 0) return false;
      const checked = await transaction.query<{ accepted: boolean }>(
        `SELECT state = 'active' AND retry_count = $3
          AND started_on + expire_seconds * interval '1 second' > clock_timestamp()
          AND (heartbeat_seconds IS NULL OR heartbeat_on + heartbeat_seconds * interval '1 second' > clock_timestamp()) AS accepted
         FROM ${this.schema}.job WHERE name = $1 AND id = $2::uuid`,
        [job.queue, job.id, job.attempt],
      );
      return checked.rows[0]?.accepted === true;
    });
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
      raise(`the job "${job.id}" of the queue "${queue}" was not failed: its attempt ${String(job.attempt)} is no longer the one the queue hands out, or the claim lapsed and the job is already somewhere else`);
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
      raise(`the read of the queue "${queue}"'s dead letters asked for ${String(options?.limit)} of them: a limit is a whole number between 1 and ${String(MAX_DEAD_LETTERS)}`);
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

  async job<Output = unknown>(queue: string, id: string): Promise<{ readonly state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'; readonly output?: Output } | null> {
    return await withSpan('queue.job.read', { 'madarch.queue': queue }, async () => {
      const held = await this.boss.getJobById<object>(queue, id);
      if (held === null) return null;
      const output = (held as { output?: unknown }).output;
      return { state: held.state, ...(output === null || output === undefined ? {} : { output: output as Output }) };
    });
  }

  async stop(): Promise<void> {
    // One stop, answered to every caller: the owner this client is lent to stops
    // it as it closes (madarch-64o5.74), and a case that stopped it on its own
    // path before that asks a second time.
    if (this.stopping !== undefined) return await this.stopping;
    this.detach();
    this.stopping = this.boss.stop({ graceful: false });
    return await this.stopping;
  }
}

/** Attaches a queue client to an explicitly prepared store. The owner remains the caller's. */
export async function createPgBossQueue(options: PgBossQueueOptions): Promise<QueueService> {
  const { owner } = options;
  const schema = options.schema ?? DEFAULT_QUEUE_SCHEMA;
  await requireSchema(owner, `queue:${schema}`, QUEUE_SCHEMA_STAMP);
  const superviseInterval = options.superviseIntervalSeconds ?? 60;
  const boss = new PgBoss({
    backend: 'postgres',
    db: ownerDatabase(owner),
    schema,
    migrate: false,
    createSchema: false,
    // Stats partitions and automatic index rebuilds are DDL, not lease recovery.
    persistQueueStats: false,
    reindex: false,
    supervise: options.supervise ?? true,
    superviseIntervalSeconds: superviseInterval,
    monitorIntervalSeconds: superviseInterval,
    schedule: false,
  });
  boss.on('error', (error: Error) => {
    const line = `pg-boss at ${owner.location}: ${error.message}`;
    if (options.log !== undefined) options.log(line);
    else console.error(line);
  });
  try {
    await boss.start();
  } catch (error) {
    // A start that failed halfway may have armed a pass already: stop what it armed.
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
  const queue = new PgBossQueue(boss, owner, schema);
  return queue;
}
