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
  /** What the enqueue of a different key answered while the first was unfinished. */
  readonly otherKeyCreated: boolean | null;
  /** What the enqueue of the first key answered after its job settled. */
  readonly keyFreedCreated: boolean | null;
  /** One job of `leases` claimed, then the queue after its one-second lease lapsed. */
  readonly claimsWhileLeaseHeld: number;
  readonly attemptAfterRecover: number | null;
  /** The lapsed attempt's own calls: a completion and a heartbeat. */
  readonly staleComplete: boolean | null;
  readonly staleHeartbeat: boolean | null;
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
  /** The doubling delay of `backoff-retry`. */
  readonly backoffFirstOutcome: FailOutcome | null;
  readonly backoffAttemptAfterFirstWait: number | null;
  readonly backoffSecondOutcome: FailOutcome | null;
  readonly backoffClaimsBeforeTwiceTheDelay: number;
  readonly backoffAttemptAfterSecondWait: number | null;
  readonly backoffFinalOutcome: FailOutcome | null;
  /** What enqueuing into, claiming from and reading the dead letters of a queue nobody declared said. */
  readonly undeclaredEnqueue: string | null;
  readonly undeclaredClaim: string | null;
  readonly undeclaredDeadLetters: string | null;
  readonly missingSingletonKey: string | null;
  readonly keyOnAPlainQueue: string | null;
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
  undeclared: 'stale-read',
} as const;

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function observed(job: ClaimedJob<{ unit: string }>): ObservedJob {
  return { unit: job.data.unit, attempt: job.attempt, leaseSeconds: job.leaseSeconds };
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
    const liveHeartbeat = await queue.heartbeat(SCENARIO_QUEUES.leases, again);
    const completeSettled = await queue.complete(SCENARIO_QUEUES.leases, again);
    const heartbeatAfterSettle = await queue.heartbeat(SCENARIO_QUEUES.leases, again);
    const completeAgain = await queue.complete(SCENARIO_QUEUES.leases, again);
    const claimsAfterComplete = (await queue.claim({ queue: SCENARIO_QUEUES.leases })).length;

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

    // The same one-second delay, doubling: the second wait is not the first.
    await queue.enqueue({ queue: SCENARIO_QUEUES.backoff, data: { unit: 'slow' } });
    const backoffFirst = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffFirstOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffFirst, 'the first attempt failed');
    await wait(2.1);
    const backoffSecond = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffSecondOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffSecond, 'the second attempt failed');
    await wait(1.9);
    const backoffClaimsBeforeTwiceTheDelay = (await queue.claim({ queue: SCENARIO_QUEUES.backoff })).length;
    await wait(2.2);
    const backoffThird = (await queue.claim<{ unit: string }>({ queue: SCENARIO_QUEUES.backoff }))[0]!;
    const backoffFinalOutcome = await queue.fail(SCENARIO_QUEUES.backoff, backoffThird, 'the third attempt failed');

    // The refusals this adapter makes itself, each naming the queue.
    const undeclaredEnqueue = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.undeclared, data: { unit: 'nowhere' } }));
    const undeclaredClaim = await refusal(() => queue.claim({ queue: SCENARIO_QUEUES.undeclared }));
    const undeclaredDeadLetters = await refusal(() => queue.deadLetters(SCENARIO_QUEUES.undeclared));
    const missingSingletonKey = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.plans, data: { unit: 'scope-c' } }));
    const keyOnAPlainQueue = await refusal(() => queue.enqueue({ queue: SCENARIO_QUEUES.units, data: { unit: 'keyed' }, singletonKey: 'k' }));

    return {
      claimedByPriority: two.map(observed),
      claimedLast: last.map(observed),
      secondKeyCreated: second.created,
      otherKeyCreated: other.created,
      keyFreedCreated: freed.created,
      claimsWhileLeaseHeld,
      attemptAfterRecover: again.attempt,
      staleComplete,
      staleHeartbeat,
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
      backoffFirstOutcome,
      backoffAttemptAfterFirstWait: backoffSecond.attempt,
      backoffSecondOutcome,
      backoffClaimsBeforeTwiceTheDelay,
      backoffAttemptAfterSecondWait: backoffThird.attempt,
      backoffFinalOutcome,
      undeclaredEnqueue,
      undeclaredClaim,
      undeclaredDeadLetters,
      missingSingletonKey,
      keyOnAPlainQueue,
    };
  } finally {
    await queue.stop();
  }
}
