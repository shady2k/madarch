/**
 * The queue's behaviour, observed once and judged by every caller: the tests on
 * PGlite (`test/queue.test.ts`) and on PostgreSQL (`test/queue-postgres.test.ts`)
 * run this, and the compiled binary's driver (`test/queue-binary-driver.ts`)
 * runs its phases, so the two backends and the binary answer the same
 * questions. This module asserts nothing: it makes the calls and reports what
 * came back, and each caller holds the values it expects (decision 0027,
 * "Queue"; madarch-tzte.19.2).
 *
 * The queues it declares, and why:
 *
 * - `units` holds the ordinary work: its lease is 60 seconds, it retries twice
 *   with a doubling delay, and its spent jobs are copied into `units-dead`.
 * - `plans` holds one unfinished job per singleton key, 60 seconds of lease and
 *   no retries.
 * - `leases` has a one-second lease, so a claim lapses while the scenario
 *   watches it and `recover` has something to recover.
 * - `fixed-retry` retries once after exactly one second, which is what a fixed
 *   retry delay means, and dead-letters into `fixed-retry-dead`.
 * - `backoff-retry` retries twice with a doubling delay, the same one second
 *   wide, so its second wait can be told from its first.
 * - `lease-spent` has a one-second lease, no retries and a dead letter queue, so
 *   a claim that lapses on a job with nothing left lands there.
 * - `heartbeat-quiet` declares a ten-second heartbeat and a one-minute lease, so
 *   a claim that is never heartbeated is noticed by the interval rather than by
 *   the lease.
 * - `equal-priority` takes three jobs of the same priority, which come back in
 *   the order they were enqueued, and then five enqueued in one transaction —
 *   one clock tick — which must come back in that order too.
 * - `kept-retry` retries once after a second, `kept-recover` has a one-second
 *   lease, and `kept-dead` dead-letters on its first failure: each shows that a
 *   job keeps the place it was enqueued at through a retry, a recovery and a
 *   dead letter.
 * - `foreign-order` is written into directly, by two rows of one instant whose
 *   ids run against the order they were written in, so the adapter's own
 *   tie-break is what can answer them.
 * - `two-dead` dead-letters two jobs, so the read's own order and its limit can
 *   be told apart.
 * - `frozen-retries` and `raised-retries` are each re-declared after their job
 *   was enqueued, so a settlement's answer can be told from the job's own
 *   allowance.
 * - `stale-read` exists so a queue nobody declared can be refused by name.
 */
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import type { ClaimedJob, DeadLetter, FailOutcome } from '../src/fill/queue.js';

/** One claim, as the scenario observed it. */
export interface ObservedJob {
  /** What the job was enqueued with. */
  readonly unit: string;
  /** How many times the job had been claimed before this one. */
  readonly attempt: number;
  /** The retry allowance the job itself carries, stamped at its enqueue. */
  readonly retries: number;
  /** The lease the queue holds it under. */
  readonly leaseSeconds: number;
}

/** Everything one run of the scenario saw, with no judgement in it. */
export interface QueueScenarioReport {
  /** Two claims of `units`, in the order they came back. */
  readonly claimedByPriority: ObservedJob[];
  readonly claimedLast: ObservedJob[];
  /** What the second enqueue of the same singleton key answered. */
  readonly secondKeyCreated: boolean | null;
  /** A fourth enqueue of the same key while its job is claimed, and what an empty key answered. */
  readonly keyWhileClaimedCreated: boolean | null;
  readonly emptySingletonKey: string | null;
  /** What the enqueue of a different key answered while the first was unfinished. */
  readonly otherKeyCreated: boolean | null;
  /** What the enqueue of the first key answered after its job settled. */
  readonly keyFreedCreated: boolean | null;
  /** One job of `leases` claimed, then the queue after its one-second lease lapsed. */
  readonly claimsWhileLeaseHeld: number;
  readonly attemptAfterRecover: number | null;
  /** The lapsed attempt's own calls: a completion, a heartbeat and a failure. */
  readonly staleComplete: boolean | null;
  readonly staleHeartbeat: boolean | null;
  readonly staleFail: string | null;
  /** A claim that went quiet past the queue's heartbeat interval, without its lease lapsing. */
  readonly heartbeatLostAttempt: number | null;
  /** The queue after the interval passed and before the pass ran: still nothing to claim, since the claim is only dead, not gone. */
  readonly heartbeatQuietClaimsBeforeRecover: number;
  readonly heartbeatLostDeadLetters: number;
  /** A claim whose lease lapsed on a job with no retries left. */
  readonly spentLeaseDeadLetters: DeadLetter[];
  readonly spentLeaseClaims: number;
  /** The live attempt's heartbeat, and its heartbeat after it settled. */
  readonly liveHeartbeat: boolean | null;
  readonly heartbeatAfterSettle: boolean | null;
  readonly completeSettled: boolean | null;
  readonly completeAgain: boolean | null;
  readonly claimsAfterComplete: number;
  /** The fixed retry delay of `fixed-retry`: the first failure, then the wait. */
  readonly fixedFirstOutcome: FailOutcome | null;
  readonly fixedClaimableAtOnce: number;
  readonly fixedAttemptAfterDelay: number | null;
  readonly fixedFinalOutcome: FailOutcome | null;
  readonly fixedDeadLetters: DeadLetter[];
  readonly fixedClaimsAfterDeadLetter: number;
  /** The job the first failed attempt was claimed as, so a dead letter can be related to it. */
  readonly fixedFailedJobId: string | null;
  /** Two spent jobs in one queue: the newest first, and one at most when a limit of one is asked for. */
  readonly twoDeadLetters: DeadLetter[];
  readonly twoDeadLettersLimited: DeadLetter[];
  readonly twoDeadLettersDefault: DeadLetter[];
  readonly fixedDeadLettersWithoutAQueue: DeadLetter[];
  readonly deadLettersBeyondTheBound: string | null;
  /** Jobs of equal priority come back in the order they were enqueued. */
  readonly equalPriorityOrder: ObservedJob[];
  /** Five jobs enqueued in one transaction, claimed two and then three. */
  readonly oneTickFirstClaim: ObservedJob[];
  readonly oneTickSecondClaim: ObservedJob[];
  /** Two jobs written into the queue's table at one instant, in the reverse of their ids' order. */
  readonly foreignOrder: Array<{ id: string; unit: string }>;
  /** A job claimed, failed and retried: it is the older one, so it comes back before the job enqueued after it. */
  readonly keptRetryOutcome: FailOutcome | null;
  readonly keptRetryAttempt: number | null;
  readonly keptRetryUnit: string | null;
  readonly keptRetryNextUnit: string | null;
  /** A claim whose lease lapsed, recovered while a newer job waited: the recovered job comes first. */
  readonly keptRecoverAttempt: number | null;
  readonly keptRecoverUnit: string | null;
  /** A job dead-lettered while another waited: the copy holds the failed job's id and the other keeps its place. */
  readonly keptDeadOutcome: FailOutcome | null;
  readonly keptDeadJobId: string | null;
  readonly keptDeadLetters: DeadLetter[];
  readonly keptDeadNextUnit: string | null;
  /** The doubling delay of `backoff-retry`. */
  readonly backoffFirstOutcome: FailOutcome | null;
  readonly backoffAttemptAfterFirstWait: number | null;
  readonly backoffSecondOutcome: FailOutcome | null;
  readonly backoffClaimsBeforeTwiceTheDelay: number;
  readonly backoffAttemptAfterSecondWait: number | null;
  readonly backoffFinalOutcome: FailOutcome | null;
  /** A queue re-declared between the enqueue and the failure: the answer follows the job's own allowance. */
  readonly retriesFrozenOutcome: FailOutcome | null;
  readonly retriesFrozenDeadLetters: DeadLetter[];
  readonly retriesRaisedOutcome: FailOutcome | null;
  readonly retriesRaisedAttemptAfterwards: number | null;
  /** What enqueuing into, claiming from and reading the dead letters of a queue nobody declared said. */
  readonly undeclaredEnqueue: string | null;
  readonly undeclaredClaim: string | null;
  readonly undeclaredDeadLetters: string | null;
  readonly missingSingletonKey: string | null;
  readonly keyOnAPlainQueue: string | null;
  readonly shortHeartbeat: string | null;
  readonly claimWithoutAWholeNumber: string | null;
  readonly fractionalPriority: string | null;
}

/** The queues the scenario declares. */
export const SCENARIO_QUEUES = {
  units: 'units',
  unitsDead: 'units-dead',
  plans: 'plans',
  leases: 'leases',
  fixed: 'fixed-retry',
  fixedDead: 'fixed-retry-dead',
  backoff: 'backoff-retry',
  leaseSpent: 'lease-spent',
  leaseSpentDead: 'lease-spent-dead',
  heartbeatQuiet: 'heartbeat-quiet',
  equalPriority: 'equal-priority',
  keptRetry: 'kept-retry',
  keptRecover: 'kept-recover',
  keptDead: 'kept-dead',
  keptDeadDead: 'kept-dead-dead',
  foreignOrder: 'foreign-order',
  twoDead: 'two-dead',
  twoDeadDead: 'two-dead-dead',
  frozen: 'frozen-retries',
  raised: 'raised-retries',
  undeclared: 'stale-read',
} as const;

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** A pause in milliseconds, for the one gap a whole second would overshoot. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function observed(job: ClaimedJob<{ unit: string }>): ObservedJob {
  return { unit: job.data.unit, attempt: job.attempt, retries: job.retries, leaseSeconds: job.leaseSeconds };
}

/** The message of the refusal a call made, or null when it was not refused. */
async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Runs the scenario on one database owner and reports what it saw. The caller
 * closes the owner; this closes only the queue.
 */
export async function runQueueScenario(owner: DatabaseOwner, schema: string): Promise<QueueScenarioReport> {
  const queue = await createPgBossQueue({ owner, schema, supervise: false });
  try {
    await queue.declare({ name: SCENARIO_QUEUES.unitsDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.units, leaseSeconds: 60, retries: 2, retryDelaySeconds: 1, retryBackoff: true, deadLetter: SCENARIO_QUEUES.unitsDead });
    await queue.declare({ name: SCENARIO_QUEUES.plans, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, singletons: true });
    await queue.declare({ name: SCENARIO_QUEUES.leases, leaseSeconds: 1, retries: 2, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.fixedDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.fixed, leaseSeconds: 60, retries: 1, retryDelaySeconds: 1, retryBackoff: false, deadLetter: SCENARIO_QUEUES.fixedDead });
    await queue.declare({ name: SCENARIO_QUEUES.backoff, leaseSeconds: 60, retries: 2, retryDelaySeconds: 1, retryBackoff: true });
    await queue.declare({ name: SCENARIO_QUEUES.leaseSpentDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.leaseSpent, leaseSeconds: 1, retries: 0, retryDelaySeconds: 0, retryBackoff: false, deadLetter: SCENARIO_QUEUES.leaseSpentDead });
    await queue.declare({ name: SCENARIO_QUEUES.heartbeatQuiet, leaseSeconds: 60, retries: 1, retryDelaySeconds: 0, retryBackoff: false, heartbeatSeconds: 10 });
    await queue.declare({ name: SCENARIO_QUEUES.equalPriority, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.keptRetry, leaseSeconds: 60, retries: 2, retryDelaySeconds: 1, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.keptRecover, leaseSeconds: 1, retries: 2, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.keptDeadDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.keptDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, deadLetter: SCENARIO_QUEUES.keptDeadDead });
    await queue.declare({ name: SCENARIO_QUEUES.foreignOrder, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.twoDeadDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.twoDead, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, deadLetter: SCENARIO_QUEUES.twoDeadDead });
    await queue.declare({ name: SCENARIO_QUEUES.frozen, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    await queue.declare({ name: SCENARIO_QUEUES.raised, leaseSeconds: 60, retries: 1, retryDelaySeconds: 0, retryBackoff: false });

    // Priority first, then the order the jobs were enqueued in.
    await queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'low' }, priority: 1 });
    await queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'high' }, priority: 5 });
    await queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'middle' }, priority: 3 });
    const two = await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.units, limit: 2 });
    const last = await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.units });
    for (const job of [...two, ...last]) await queue.complete(SCENARIO_QUEUES.units, job);

    // One unfinished job per singleton key.
    await queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-a' }, singletonKey: 'a' });
    const second = await queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-a' }, singletonKey: 'a' });
    const other = await queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-b' }, singletonKey: 'b' });
    const plans = await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.plans, limit: 2 });
    // Held by a claimed job, not only by a queued one: still nothing created.
    const keyWhileClaimed = await queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-a' }, singletonKey: 'a' });
    for (const job of plans) await queue.complete(SCENARIO_QUEUES.plans, job);
    const freed = await queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-a' }, singletonKey: 'a' });

    // A lease that lapses: the claim is recovered and handed out again.
    await queue.enqueue({ queue: SCENARIO_QUEUES.leases, data: { unit: 'long' } });
    const lapsed = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.leases }))[0]!;
    await wait(1.3);
    const claimsWhileLeaseHeld = (await queue.claim({ queue: SCENARIO_QUEUES.leases })).length;
    await queue.recover(SCENARIO_QUEUES.leases);
    const again = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.leases }))[0]!;
    const staleComplete = await queue.complete(SCENARIO_QUEUES.leases, lapsed);
    const staleHeartbeat = await queue.heartbeat(SCENARIO_QUEUES.leases, lapsed);
    const staleFail = await refusal(() => queue.fail(SCENARIO_QUEUES.leases, lapsed, 'the attempt that lost its claim'));
    const liveHeartbeat = await queue.heartbeat(SCENARIO_QUEUES.leases, again);
    const completeSettled = await queue.complete(SCENARIO_QUEUES.leases, again);
    const heartbeatAfterSettle = await queue.heartbeat(SCENARIO_QUEUES.leases, again);
    const completeAgain = await queue.complete(SCENARIO_QUEUES.leases, again);
    const claimsAfterComplete = (await queue.claim({ queue: SCENARIO_QUEUES.leases })).length;

    // A claim that goes quiet past the declared heartbeat interval is dead
    // before its lease lapses: the lease is a minute, the interval ten seconds.
    await queue.enqueue({ queue: SCENARIO_QUEUES.heartbeatQuiet, data: { unit: 'quiet' } });
    const quiet = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.heartbeatQuiet }))[0]!;
    await wait(10.4);
    const heartbeatQuietClaimsBeforeRecover = (await queue.claim({ queue: SCENARIO_QUEUES.heartbeatQuiet })).length;
    await queue.recover(SCENARIO_QUEUES.heartbeatQuiet);
    const quietAgain = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.heartbeatQuiet }))[0]!;
    const heartbeatLostAttempt = quietAgain.attempt;
    const heartbeatLostDeadLetters = (await queue.deadLetters(SCENARIO_QUEUES.heartbeatQuiet)).length;
    await queue.complete(SCENARIO_QUEUES.heartbeatQuiet, quietAgain);

    // A lease that lapses on a job with no retries left is dead-lettered.
    await queue.enqueue({ queue: SCENARIO_QUEUES.leaseSpent, data: { unit: 'spent' } });
    const spent = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.leaseSpent }))[0]!;
    await wait(1.3);
    await queue.recover(SCENARIO_QUEUES.leaseSpent);
    const spentLeaseDeadLetters = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.leaseSpent);
    const spentLeaseClaims = (await queue.claim({ queue: SCENARIO_QUEUES.leaseSpent })).length;

    // A fixed retry delay, then the dead letter queue when the retries are spent.
    await queue.enqueue({ queue: SCENARIO_QUEUES.fixed, data: { unit: 'flaky' } });
    const firstAttempt = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.fixed }))[0]!;
    const fixedFirstOutcome = await queue.fail(SCENARIO_QUEUES.fixed, firstAttempt, 'the first attempt failed');
    const fixedClaimableAtOnce = (await queue.claim({ queue: SCENARIO_QUEUES.fixed })).length;
    await wait(1.3);
    const secondAttempt = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.fixed }))[0]!;
    const fixedAttemptAfterDelay = secondAttempt.attempt;
    const fixedFinalOutcome = await queue.fail(SCENARIO_QUEUES.fixed, secondAttempt, 'the second attempt failed');
    const fixedDeadLetters = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.fixed);
    const fixedClaimsAfterDeadLetter = (await queue.claim({ queue: SCENARIO_QUEUES.fixed })).length;
    const fixedFailedJobId = secondAttempt.id;

    // Two spent jobs in one queue: newest first, and one at most when one is asked for.
    await queue.enqueue({ queue: SCENARIO_QUEUES.twoDead, data: { unit: 'first-spent' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.twoDead, data: { unit: 'second-spent' } });
    const firstSpent = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.twoDead }))[0]!;
    await queue.fail(SCENARIO_QUEUES.twoDead, firstSpent, 'the first spent job failed');
    // A dead letter's time is what "newest first" reads, and it is kept to the
    // millisecond: two copies made in one instant could not be told apart.
    await pause(30);
    const secondSpent = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.twoDead }))[0]!;
    await queue.fail(SCENARIO_QUEUES.twoDead, secondSpent, 'the second spent job failed');
    const twoDeadLetters = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.twoDead);
    const twoDeadLettersDefault = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.twoDead, {});
    const twoDeadLettersLimited = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.twoDead, { limit: 1 });
    const deadLettersBeyondTheBound = await refusal(() => queue.deadLetters(SCENARIO_QUEUES.twoDead, { limit: 100_001 }));

    // A queue whose retries were spent and which declares no dead letter queue
    // answers none.
    await queue.enqueue({ queue: SCENARIO_QUEUES.frozen, data: { unit: 'no-dead-letter' } });
    const noDeadLetterJob = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.frozen }))[0]!;
    await queue.fail(SCENARIO_QUEUES.frozen, noDeadLetterJob, 'nothing to dead-letter into');
    const fixedDeadLettersWithoutAQueue = await queue.deadLetters(SCENARIO_QUEUES.frozen);

    // Equal priorities come back in the order they were enqueued.
    await queue.enqueue({ queue: SCENARIO_QUEUES.equalPriority, data: { unit: 'first-equal' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.equalPriority, data: { unit: 'second-equal' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.equalPriority, data: { unit: 'third-equal' } });
    const equalPriorityOrder = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.equalPriority, limit: 3 })).map(observed);

    // Five jobs enqueued inside one transaction: the store stamps every statement
    // of a transaction with one instant, so this is one clock tick made certain
    // rather than waited for, and the queue's own place for each enqueue is what
    // keeps the order — a claim of two takes the two oldest, and the rest follow.
    await owner.transaction('write', async (transaction) => {
      for (const unit of ['tick-one', 'tick-two', 'tick-three', 'tick-four', 'tick-five']) {
        await queue.enqueue({ queue: SCENARIO_QUEUES.equalPriority, data: { unit }, transaction });
      }
    });
    const oneTickFirstClaim = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.equalPriority, limit: 2 })).map(observed);
    const oneTickSecondClaim = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.equalPriority, limit: 3 })).map(observed);

    // Two rows written straight into the queue's table, at one instant and in the
    // reverse of their ids' code point order: the adapter gave them no place of
    // their own, so the last key it promises — ids in code point order — is the
    // only thing that can order them, and insertion order is not it.
    await owner.run(async (transaction) => {
      await transaction.query(
        `INSERT INTO ${schema}.job (id, name, data, priority, created_on, start_after, keep_until)
         VALUES ('22222222-2222-4222-8222-222222222222', $1, '{"unit":"written-first"}'::jsonb, 0, $2::timestamptz, $2::timestamptz, $2::timestamptz + interval '1 day'),
                ('11111111-1111-4111-8111-111111111111', $1, '{"unit":"written-second"}'::jsonb, 0, $2::timestamptz, $2::timestamptz, $2::timestamptz + interval '1 day')`,
        [SCENARIO_QUEUES.foreignOrder, '2026-10-18 00:00:00+00'],
      );
    });
    const foreignOrder = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.foreignOrder, limit: 2 })).map((job) => ({ id: job.id, unit: job.data.unit }));

    // A job that failed and waits for its retry keeps its place: it was enqueued
    // before the job behind it, so it is the one claimed once its retry is due.
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptRetry, data: { unit: 'kept-retry-first' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptRetry, data: { unit: 'kept-retry-second' } });
    const keptRetryFirst = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptRetry }))[0]!;
    const keptRetryOutcome = await queue.fail(SCENARIO_QUEUES.keptRetry, keptRetryFirst, 'the first attempt failed');
    await wait(1.3);
    const keptRetryAgain = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptRetry }))[0]!;
    await queue.complete(SCENARIO_QUEUES.keptRetry, keptRetryAgain);
    const keptRetryNext = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptRetry }))[0]!;
    await queue.complete(SCENARIO_QUEUES.keptRetry, keptRetryNext);

    // The same for a claim recovered after its lease lapsed.
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptRecover, data: { unit: 'kept-recover-first' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptRecover, data: { unit: 'kept-recover-second' } });
    await queue.claim({ queue: SCENARIO_QUEUES.keptRecover });
    await wait(1.3);
    await queue.recover(SCENARIO_QUEUES.keptRecover);
    const keptRecoverAgain = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptRecover }))[0]!;

    // And for a job whose only attempt failed: the copy is in the dead letter
    // queue under the failed job's id, and the job behind it is claimed next.
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptDead, data: { unit: 'kept-dead-first' } });
    await queue.enqueue({ queue: SCENARIO_QUEUES.keptDead, data: { unit: 'kept-dead-second' } });
    const keptDeadFirst = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptDead }))[0]!;
    const keptDeadOutcome = await queue.fail(SCENARIO_QUEUES.keptDead, keptDeadFirst, 'the only attempt failed');
    const keptDeadLetters = await queue.deadLetters<{ unit: string }>(SCENARIO_QUEUES.keptDead);
    const keptDeadNext = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.keptDead }))[0]!;

    // The same one-second delay, doubling: the second wait is not the first.
    await queue.enqueue({ queue: SCENARIO_QUEUES.backoff, data: { unit: 'slow' } });
    const backoffFirst = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffFirstOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffFirst, 'the first attempt failed');
    await wait(2.1);
    const backoffSecond = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffSecondOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffSecond, 'the second attempt failed');
    // A fixed delay of one second would have handed the job out by now; the
    // doubling one waits between two and four seconds, so half a second on
    // either side of this check keeps the margin a loaded runner needs.
    await wait(1.5);
    const backoffClaimsBeforeTwiceTheDelay = (await queue.claim({ queue: SCENARIO_QUEUES.backoff })).length;
    await wait(2.6);
    const backoffThird = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffFinalOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffThird, 'the third attempt failed');

    // A queue declared again between the enqueue and the failure: the answer
    // follows the job's own allowance, which pg-boss stamped on it.
    await queue.enqueue({ queue: SCENARIO_QUEUES.frozen, data: { unit: 'frozen' } });
    await queue.declare({ name: SCENARIO_QUEUES.frozen, leaseSeconds: 60, retries: 3, retryDelaySeconds: 0, retryBackoff: false });
    const frozenJob = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.frozen }))[0]!;
    const retriesFrozenOutcome = await queue.fail(SCENARIO_QUEUES.frozen, frozenJob, 'the job carries no retries');
    const retriesFrozenDeadLetters = await queue.deadLetters(SCENARIO_QUEUES.frozen);
    const retriesFrozenClaims = (await queue.claim({ queue: SCENARIO_QUEUES.frozen })).length;

    await queue.enqueue({ queue: SCENARIO_QUEUES.raised, data: { unit: 'raised' } });
    await queue.declare({ name: SCENARIO_QUEUES.raised, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
    const raisedJob = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.raised }))[0]!;
    const retriesRaisedOutcome = await queue.fail(SCENARIO_QUEUES.raised, raisedJob, 'the job carries one retry');
    const raisedAgain = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.raised }))[0];
    const retriesRaisedAttemptAfterwards = raisedAgain?.attempt ?? null;

    // The refusals this adapter makes itself, each naming the queue.
    const undeclaredEnqueue = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.undeclared, data: { unit: 'nowhere' } }));
    const undeclaredClaim = await refusal(() => queue.claim({ queue: SCENARIO_QUEUES.undeclared }));
    const undeclaredDeadLetters = await refusal(() => queue.deadLetters(SCENARIO_QUEUES.undeclared));
    const missingSingletonKey = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-c' } }));
    const keyOnAPlainQueue = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'keyed' }, singletonKey: 'k' }));
    const emptySingletonKey = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-d' }, singletonKey: '' }));
    const shortHeartbeat = await refusal(() =>
      queue.declare({ name: 'short-heartbeat', leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false, heartbeatSeconds: 9 }),
    );
    const claimWithoutAWholeNumber = await refusal(() => queue.claim({ queue: SCENARIO_QUEUES.units, limit: 0 }));
    const fractionalPriority = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'half' }, priority: 1.5 }));

    return {
      claimedByPriority: two.map(observed),
      claimedLast: last.map(observed),
      secondKeyCreated: second.created,
      keyWhileClaimedCreated: keyWhileClaimed.created,
      otherKeyCreated: other.created,
      keyFreedCreated: freed.created,
      emptySingletonKey,
      claimsWhileLeaseHeld,
      attemptAfterRecover: again.attempt,
      staleComplete,
      staleHeartbeat,
      staleFail,
      heartbeatLostAttempt,
      heartbeatQuietClaimsBeforeRecover,
      heartbeatLostDeadLetters,
      spentLeaseDeadLetters,
      spentLeaseClaims,
      liveHeartbeat,
      heartbeatAfterSettle,
      completeSettled,
      completeAgain,
      claimsAfterComplete,
      fixedFirstOutcome,
      fixedClaimableAtOnce,
      fixedAttemptAfterDelay,
      fixedFinalOutcome,
      fixedDeadLetters,
      fixedClaimsAfterDeadLetter,
      fixedFailedJobId,
      twoDeadLetters,
      twoDeadLettersLimited,
      twoDeadLettersDefault,
      fixedDeadLettersWithoutAQueue,
      deadLettersBeyondTheBound,
      equalPriorityOrder,
      oneTickFirstClaim,
      oneTickSecondClaim,
      foreignOrder,
      keptRetryOutcome,
      keptRetryAttempt: keptRetryAgain.attempt,
      keptRetryUnit: keptRetryAgain.data.unit,
      keptRetryNextUnit: keptRetryNext.data.unit,
      keptRecoverAttempt: keptRecoverAgain.attempt,
      keptRecoverUnit: keptRecoverAgain.data.unit,
      keptDeadOutcome,
      keptDeadJobId: keptDeadFirst.id,
      keptDeadLetters,
      keptDeadNextUnit: keptDeadNext.data.unit,
      backoffFirstOutcome,
      backoffAttemptAfterFirstWait: backoffSecond.attempt,
      backoffSecondOutcome,
      backoffClaimsBeforeTwiceTheDelay,
      backoffAttemptAfterSecondWait: backoffThird.attempt,
      backoffFinalOutcome,
      retriesFrozenOutcome,
      retriesFrozenDeadLetters,
      retriesRaisedOutcome,
      retriesRaisedAttemptAfterwards,
      undeclaredEnqueue,
      undeclaredClaim,
      undeclaredDeadLetters,
      missingSingletonKey,
      keyOnAPlainQueue,
      shortHeartbeat,
      claimWithoutAWholeNumber,
      fractionalPriority,
    };
  } finally {
    await queue.stop();
  }
}
