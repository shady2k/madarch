/**
 * The fill's durable queue (decision 0027, "Queue"): work is enqueued with a
 * priority and a singleton key, claimed under a lease, heartbeated while a unit
 * runs, settled when it finishes, retried with backoff when it fails and
 * dead-lettered when its retries are spent. Every one of those steps is a short
 * transaction of the process's one database owner (madarch-tzte.19.1): the
 * queue opens no database of its own, holds no lock across an agent session, and
 * an enqueue or a settlement can be handed the transaction of a caller whose own
 * work must land with it — decision 0027's publication, which writes the unit's
 * facts, its state and the queue's settlement in one short transaction.
 *
 * madarch's vocabulary lives in this module and nothing of pg-boss's does: a
 * queue is declared with its lease, its retries, its dead letter queue and
 * whether it holds one unfinished job per singleton key, and the operations are
 * enqueue, claim, heartbeat, complete, fail, recover and deadLetters. The
 * adapter behind it (`src/adapters/pg-boss-queue.ts`) is pg-boss on that same
 * owner; the alternative the decision keeps behind this same interface — an own
 * leased queue on `FOR UPDATE SKIP LOCKED` — would satisfy it without any
 * caller changing.
 *
 * The domain dependencies decision 0027 keeps out of the queue stay out of it:
 * what a unit waits for, when it is stale and when it is published exactly once
 * are the orchestrator's, and a job's data is the orchestrator's own.
 */
import type { OuterTransaction } from '../history/types.js';

/**
 * One job's identity and data, as the queue hands it out. Its `attempt` and
 * `id` together are what fencing reads: a settlement or a heartbeat names the
 * attempt it was claimed as, and one that names an attempt the queue has since
 * handed out again, or a claim that lapsed, is refused rather than silently
 * applied to the wrong run of the job.
 */
export interface ClaimedJob<Data = unknown> {
  /** The job's id, stable across its attempts and its dead letters. */
  readonly id: string;
  /** The queue it was claimed from. */
  readonly queue: string;
  /** How many times the job was claimed before: 0 on its first attempt, and one more on each retry. */
  readonly attempt: number;
  /**
   * How many times this job may be handed out again after a failure: the retry
   * allowance the job itself carries, stamped when it was enqueued. A queue
   * declared again after that does not change the jobs already in it, so this is
   * the number a settlement is judged by, never the queue's latest declaration.
   */
  readonly retries: number;
  /** The job's data as it was enqueued. */
  readonly data: Data;
  /**
   * How many seconds this claim holds the job before the queue treats it as
   * abandoned, counted from the claim: the lease. A worker that dies without
   * settling is recovered by the next `recover` after it lapses.
   */
  readonly leaseSeconds: number;
}

/**
 * A queue, declared before anything is enqueued into it. Declaring the same
 * queue again replaces its settings whole — a queue declared again without a
 * heartbeat or a dead letter queue has neither — so a product's configuration
 * can be applied to a database that already holds the queue. One field is not
 * replaceable: `singletons`, because the database's own index over a queue's
 * unfinished keys is built when the queue is created, so a service refuses a
 * declaration that would change it, naming the queue.
 */
export interface QueueDeclaration {
  /** The queue's name: letters, digits, `_`, `-`, `.` or `/`, as every stored object's name. */
  readonly name: string;
  /**
   * How many seconds a claim holds a job before the queue treats it as
   * abandoned, at least 1. It is the bound one attempt may hold a job; a
   * heartbeat does not extend it, it only shows the claim is alive (see
   * `heartbeatSeconds`).
   */
  readonly leaseSeconds: number;
  /** How many times a failed job is handed out again before it fails for good: 0 fails on the first failure. */
  readonly retries: number;
  /** How many seconds a retry waits before it may be claimed again, at least 0. */
  readonly retryDelaySeconds: number;
  /**
   * Whether each wait doubles with the attempt, `retryDelaySeconds × 2^attempt`
   * with jitter, rather than staying at `retryDelaySeconds`.
   */
  readonly retryBackoff: boolean;
  /**
   * How many seconds may pass between heartbeats before the queue treats the
   * claim as dead, at least 10; left out, a claim is only recovered when its
   * lease lapses. It is the quicker of the two liveness bounds: a worker that
   * dies is noticed within this many seconds, where the lease would make the
   * queue wait for the whole attempt.
   */
  readonly heartbeatSeconds?: number;
  /**
   * True when the queue holds at most one unfinished job per singleton key: an
   * enqueue whose key already has a queued or claimed job is not created, and
   * one is created again once that job settles. A queue that holds singletons
   * requires a key on every enqueue.
   */
  readonly singletons?: boolean;
  /**
   * The queue a job is copied into when its retries are spent; that queue is
   * declared first, by this declaration or an earlier one. Left out, a failed
   * job is only marked failed and no copy is kept.
   */
  readonly deadLetter?: string;
}

/** One enqueue: the job's data and the options that decide when and whether it runs. */
export interface EnqueueRequest<Data = unknown> {
  /** The queue to enqueue into; it must have been declared. */
  readonly queue: string;
  /** The job's own data, stored as given and handed back on every attempt. */
  readonly data: Data;
  /**
   * The job's priority: a higher number is claimed first, equal priorities by
   * the order they were enqueued, oldest first. Left out, 0.
   */
  readonly priority?: number;
  /**
   * The job's singleton key, on a queue declared with `singletons`: while an
   * unfinished job carries this key, an enqueue with it creates nothing.
   */
  readonly singletonKey?: string;
  /** The moment the job may first be claimed; left out, at once. */
  readonly startAfter?: Date;
  /**
   * A transaction of the process's database owner to enqueue inside: the job's
   * row is written with the caller's own work and commits with it, or is rolled
   * back with it. Left out, the enqueue is its own short transaction.
   */
  readonly transaction?: OuterTransaction;
}

/**
 * What an enqueue did: the job it created, or that the queue's singleton key
 * already had an unfinished job and nothing was created.
 */
export type EnqueueResult =
  | { readonly created: true; readonly id: string }
  | { readonly created: false; readonly id: null };

/** One claim: how many jobs to take from one queue, at most. */
export interface ClaimRequest {
  /** The queue to claim from; it must have been declared. */
  readonly queue: string;
  /** How many jobs to claim, a positive whole number; left out, one. */
  readonly limit?: number;
}

/** What failing a job did: it waits for its next attempt, or its retries are spent. */
export type FailOutcome = 'retry' | 'failed';

/**
 * One job a queue's retries were spent on, as it lies in that queue's dead
 * letter queue. The queue keeps a copy rather than the job itself: the copy has
 * an id of its own and names the job that failed, and its data and its reason
 * are the failed job's.
 */
export interface DeadLetter<Data = unknown> {
  /** The dead letter copy's own id, which is the id of the job lying in the dead letter queue. */
  readonly id: string;
  /**
   * The id of the job that failed: the id every claim of it carried, which the
   * copy keeps as its source. A caller holding a unit's job id relates its dead
   * letter this way.
   */
  readonly jobId: string;
  /** The dead letter queue the copy lies in. */
  readonly queue: string;
  /** The queue the job failed on, or null where the copy names none. */
  readonly sourceQueue: string | null;
  /** The failed job's data, as it was enqueued. */
  readonly data: Data;
  /** The reason the last attempt failed with, or null where none was given. */
  readonly reason: string | null;
  /** How many retries the job consumed before it was dead-lettered: 0 when its first attempt failed. */
  readonly retriesSpent: number;
  /** When the copy landed in the dead letter queue, in epoch milliseconds. */
  readonly deadLetteredAt: number;
}

/**
 * The queue the fill's work waits in. One service per process, on the process's
 * one database owner: it is started by its adapter's factory, declared its
 * queues before use and stopped when the process is done with it, and it never
 * closes the owner, which is the caller's.
 */
export interface QueueService {
  /**
   * Declares a queue, or replaces a declaration of it. A dead letter queue is
   * declared by the declaration that names it or by an earlier one.
   *
   * Refused, naming the queue and the field: a lease shorter than a second, a
   * negative retry or retry delay, a heartbeat under ten seconds, a name that
   * is no stored object's name, a dead letter queue that is the queue itself or
   * that is not declared, and a declaration that would change a queue's
   * singleton rule, which is fixed when the queue is created.
   */
  declare(declaration: QueueDeclaration): Promise<void>;
  /**
   * Enqueues one job into a declared queue and answers the job it created, or
   * that the queue's singleton key already held an unfinished job, in which case
   * nothing was created. Refused, naming the queue: one that was never declared,
   * a singleton key on a queue that does not hold singletons, a missing key on
   * one that does, and a non-integer priority.
   */
  enqueue<Data>(request: EnqueueRequest<Data>): Promise<EnqueueResult>;
  /**
   * Claims up to `limit` jobs of a declared queue for this worker, ordered the
   * way the queue selects them: the highest priority first, then the oldest,
   * and ids in code point order where two jobs were enqueued in the same
   * instant, so the same set of jobs always comes back in the same order. Every
   * job carries its attempt and the lease that claim holds it under. An empty
   * queue answers no jobs.
   */
  claim<Data>(request: ClaimRequest): Promise<ClaimedJob<Data>[]>;
  /**
   * Refreshes the claim of `job` so the queue does not treat it as dead before
   * its lease lapses: true when the claim is this attempt and is still held,
   * false when the attempt was already handed out again — the worker whose
   * attempt lapsed learns there that its job is no longer its own.
   */
  heartbeat(queue: string, job: ClaimedJob): Promise<boolean>;
  /**
   * Settles `job` as done, storing `output` beside it, inside `transaction` when
   * one is given so the settlement commits with the caller's own work. True when
   * this attempt settled it; false when the attempt was no longer the one in
   * force, and nothing was written.
   */
  complete(queue: string, job: ClaimedJob, output?: object, transaction?: OuterTransaction): Promise<boolean>;
  /**
   * Settles `job` as failed, with `reason` kept on it: a job whose attempts
   * remain waits for its next one under the queue's retry delay and backoff and
   * answers `retry`; a job whose retries are spent is marked failed, copied into
   * the queue's dead letter queue where it has one, and answers `failed`. Given
   * a `transaction`, the settlement commits with it. Refused when the attempt is
   * no longer the one in force, and nothing is written.
   */
  fail(queue: string, job: ClaimedJob, reason: string, transaction?: OuterTransaction): Promise<FailOutcome>;
  /**
   * Asks a declared queue's maintenance to run now, in short transactions of
   * its own, recovering what a killed process left behind: a claim whose lease
   * lapsed, or whose heartbeat went quiet past the interval the job was
   * enqueued under, is settled as failed through the same retry and dead letter
   * rules as `fail` — the attempt that held it never settles it itself, and its
   * worker's later calls are refused. A queue is swept when its sweep comes due,
   * once per pass interval, so a call made inside that window leaves the queue
   * for its next turn rather than sweeping it twice; the adapter says so in its
   * own options (`superviseIntervalSeconds`). A queue served by a running
   * adapter is also swept on its own while the process lives, which is what
   * makes a killed worker recoverable without anyone asking.
   */
  recover(queue: string): Promise<void>;
  /**
   * The jobs a queue's retries were spent on, newest first, at most `limit` of
   * them — all of them when it is left out, and never more than 100 000, the
   * most one read takes. The read takes the queue's
   * whole dead letter list, since the queue keeps it oldest first and offers no
   * order of its own, so a queue holding many dead letters costs the read all of
   * them. Refused, naming the queue, when it was never declared or the limit is
   * outside the bound; a queue with no dead letter queue answers none.
   */
  deadLetters<Data>(queue: string, options?: { limit?: number }): Promise<DeadLetter<Data>[]>;
  /**
   * Stops this service's own work — its polling and maintenance — and leaves
   * every job's state in the database as it stands. It never closes the owner,
   * which the caller that opened it closes.
   */
  stop(): Promise<void>;
}
