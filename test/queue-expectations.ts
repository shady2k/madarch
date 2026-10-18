/**
 * What the queue's behaviour must be, judged once and run by both backends
 * (madarch-tzte.19.2, decision 0027 "Queue"). `test/queue-scenario.ts` observes;
 * this module holds the expected values, and the PGlite suite
 * (`test/queue.test.ts`) and the PostgreSQL suite (`test/queue-postgres.test.ts`)
 * each run every check against their own run of the scenario, so "the same suite
 * passes on PostgreSQL" is literally the same expectations.
 *
 * Every expected value comes from the task and the decision, never from the code:
 * the claim takes the highest priority first and the oldest first; a singleton
 * key holds a second job back until the first settles and keys are independent;
 * a claim holds a job for the lease the queue declared, and one whose lease
 * lapsed is recovered and handed out again as the next attempt, which the attempt
 * that lost it can neither heartbeat nor settle; a settlement is fenced to its
 * attempt and a settled job is not held; a failure waits for its next attempt
 * under the declared delay, which doubles with backoff, and a job whose retries
 * are spent is copied into the dead letter queue carrying the reason its last
 * attempt failed with; and a queue nobody declared is refused, naming the queue.
 */
import { expect } from 'bun:test';
import type { QueueScenarioReport } from './queue-scenario.js';
import { SCENARIO_QUEUES } from './queue-scenario.js';

/** One named check, run against one backend's report. */
export interface QueueScenarioCheck {
  readonly name: string;
  readonly check: (report: QueueScenarioReport) => void;
}

export const QUEUE_SCENARIO_CHECKS: readonly QueueScenarioCheck[] = [
  {
    name: 'a claim takes the highest priority first and then the oldest, reporting each job’s attempt and its queue’s lease',
    check: (report) => {
      // `units` was declared with two retries, and each job carries that
      // allowance from its own enqueue.
      expect(report.claimedByPriority).toEqual([
        { unit: 'high', attempt: 0, retries: 2, leaseSeconds: 60 },
        { unit: 'middle', attempt: 0, retries: 2, leaseSeconds: 60 },
      ]);
      expect(report.claimedLast).toEqual([{ unit: 'low', attempt: 0, retries: 2, leaseSeconds: 60 }]);
    },
  },
  {
    name: 'a singleton key holds a second job back while the first is queued or claimed, until it settles, and different keys are independent',
    check: (report) => {
      expect(report.secondKeyCreated).toBe(false);
      expect(report.keyWhileClaimedCreated).toBe(false);
      expect(report.otherKeyCreated).toBe(true);
      expect(report.keyFreedCreated).toBe(true);
    },
  },
  {
    name: 'claiming three jobs of equal priority answers them in the order they were enqueued',
    check: (report) => {
      // `equal-priority` was declared with no retries.
      expect(report.equalPriorityOrder).toEqual([
        { unit: 'first-equal', attempt: 0, retries: 0, leaseSeconds: 60 },
        { unit: 'second-equal', attempt: 0, retries: 0, leaseSeconds: 60 },
        { unit: 'third-equal', attempt: 0, retries: 0, leaseSeconds: 60 },
      ]);
    },
  },
  {
    name: 'five jobs enqueued inside one clock tick come back in the order they were enqueued, and a claim of two takes the two oldest',
    check: (report) => {
      // `equal-priority` was declared with no retries.
      expect(report.oneTickFirstClaim).toEqual([
        { unit: 'tick-one', attempt: 0, retries: 0, leaseSeconds: 60 },
        { unit: 'tick-two', attempt: 0, retries: 0, leaseSeconds: 60 },
      ]);
      expect(report.oneTickSecondClaim).toEqual([
        { unit: 'tick-three', attempt: 0, retries: 0, leaseSeconds: 60 },
        { unit: 'tick-four', attempt: 0, retries: 0, leaseSeconds: 60 },
        { unit: 'tick-five', attempt: 0, retries: 0, leaseSeconds: 60 },
      ]);
    },
  },
  {
    name: 'jobs written into the queue at one instant come back in code point order of their ids',
    check: (report) => {
      // The rows were written in the reverse of their ids' order, so this is the
      // adapter's own tie-break answering, not the store's insertion order.
      expect(report.foreignOrder.map((job) => job.unit)).toEqual(['written-second', 'written-first']);
      const ids = report.foreignOrder.map((job) => job.id);
      expect(ids).toEqual([...ids].sort());
    },
  },
  {
    name: 'a retried job, a recovered job and a job whose retry is spent keep the place they were enqueued at',
    check: (report) => {
      expect(report.keptRetryOutcome).toBe('retry');
      expect(report.keptRetryAttempt).toBe(1);
      expect(report.keptRetryUnit).toBe('kept-retry-first');
      expect(report.keptRetryNextUnit).toBe('kept-retry-second');

      expect(report.keptRecoverAttempt).toBe(1);
      expect(report.keptRecoverUnit).toBe('kept-recover-first');

      expect(report.keptDeadOutcome).toBe('failed');
      expect(report.keptDeadLetters.map((letter) => letter.data)).toEqual([{ unit: 'kept-dead-first' }]);
      expect(report.keptDeadNextUnit).toBe('kept-dead-second');
    },
  },
  {
    name: 'a claim whose lease lapsed is recovered as the next attempt, and the attempt that lost it can neither settle, heartbeat nor fail the job',
    check: (report) => {
      expect(report.claimsWhileLeaseHeld).toBe(0);
      expect(report.attemptAfterRecover).toBe(1);
      expect(report.staleComplete).toBe(false);
      expect(report.staleHeartbeat).toBe(false);
      expect(report.staleFail ?? '').toContain('was not failed: its attempt 0 is no longer the one the queue hands out');
    },
  },
  {
    name: 'a claim that goes quiet past the declared heartbeat interval is recovered before its lease lapses',
    check: (report) => {
      // The lease is a minute, so nothing lapsed: only the heartbeat interval
      // can have made this claim dead.
      expect(report.heartbeatQuietClaimsBeforeRecover).toBe(0);
      expect(report.heartbeatLostAttempt).toBe(1);
      expect(report.heartbeatLostDeadLetters).toBe(0);
    },
  },
  {
    name: 'a lease that lapses on a job with no retries left dead-letters it',
    check: (report) => {
      expect(report.spentLeaseClaims).toBe(0);
      expect(report.spentLeaseDeadLetters).toEqual([
        {
          id: expect.any(String),
          jobId: expect.any(String),
          queue: SCENARIO_QUEUES.leaseSpentDead,
          sourceQueue: SCENARIO_QUEUES.leaseSpent,
          data: { unit: 'spent' },
          // The queue's own words for a lease that lapsed.
          reason: 'job timed out',
          retriesSpent: 0,
          deadLetteredAt: expect.any(Number),
        },
      ]);
    },
  },
  {
    name: 'a heartbeat keeps a live claim, and a settlement is fenced to its attempt',
    check: (report) => {
      expect(report.liveHeartbeat).toBe(true);
      expect(report.completeSettled).toBe(true);
      expect(report.heartbeatAfterSettle).toBe(false);
      expect(report.completeAgain).toBe(false);
      expect(report.claimsAfterComplete).toBe(0);
    },
  },
  {
    name: 'a failure waits for its next attempt under the queue’s fixed delay, and a job whose retries are spent is dead-lettered with the reason it failed with',
    check: (report) => {
      expect(report.fixedFirstOutcome).toBe('retry');
      expect(report.fixedClaimableAtOnce).toBe(0);
      expect(report.fixedAttemptAfterDelay).toBe(1);
      expect(report.fixedFinalOutcome).toBe('failed');
      expect(report.fixedClaimsAfterDeadLetter).toBe(0);
      expect(report.fixedDeadLetters).toEqual([
        {
          // The copy has an id of its own and names the job that failed, whose
          // id every claim of it carried.
          id: expect.any(String),
          jobId: report.fixedFailedJobId ?? '',
          queue: SCENARIO_QUEUES.fixedDead,
          sourceQueue: SCENARIO_QUEUES.fixed,
          data: { unit: 'flaky' },
          reason: 'the second attempt failed',
          retriesSpent: 1,
          deadLetteredAt: expect.any(Number),
        },
      ]);
      expect(report.fixedDeadLetters[0]?.id).not.toBe(report.fixedFailedJobId);
    },
  },
  {
    name: 'dead letters answer newest first, at most the number asked for, none for a queue with no dead letter queue, and a limit beyond the bound is refused naming the queue',
    check: (report) => {
      expect(report.twoDeadLetters.map((letter) => letter.data)).toEqual([{ unit: 'second-spent' }, { unit: 'first-spent' }]);
      expect(report.twoDeadLettersLimited.map((letter) => letter.data)).toEqual([{ unit: 'second-spent' }]);
      // With no limit named, every dead letter of the queue is answered.
      expect(report.twoDeadLettersDefault).toEqual(report.twoDeadLetters);
      expect(report.fixedDeadLettersWithoutAQueue).toEqual([]);
      expect(report.deadLettersBeyondTheBound ?? '').toContain(`the read of the queue "${SCENARIO_QUEUES.twoDead}"'s dead letters asked for 100001 of them: a limit is a whole number between 1 and 100000`);
    },
  },
  {
    name: 'a failure answers what the settlement did: the job’s own retry allowance, not the queue’s latest declaration',
    check: (report) => {
      // Enqueued with no retries, so its first failure is final even though the
      // queue was declared again with three.
      expect(report.retriesFrozenOutcome).toBe('failed');
      expect(report.retriesFrozenDeadLetters).toEqual([]);
      // Enqueued with one retry, so it is retried even though the queue was
      // declared again with none.
      expect(report.retriesRaisedOutcome).toBe('retry');
      expect(report.retriesRaisedAttemptAfterwards).toBe(1);
    },
  },
  {
    name: 'a retry delay that doubles waits longer on the second failure than on the first',
    check: (report) => {
      expect(report.backoffFirstOutcome).toBe('retry');
      // The first wait is the declared second with its jitter: [1, 2) seconds,
      // so 2.1 seconds of waiting is past it.
      expect(report.backoffAttemptAfterFirstWait).toBe(1);
      expect(report.backoffSecondOutcome).toBe('retry');
      // The second wait is retryDelay × 2^1 with the same jitter: [2, 4)
      // seconds, so 1.9 seconds — past the first wait — is not past it.
      expect(report.backoffClaimsBeforeTwiceTheDelay).toBe(0);
      expect(report.backoffAttemptAfterSecondWait).toBe(2);
      expect(report.backoffFinalOutcome).toBe('failed');
    },
  },
  {
    name: 'a queue nobody declared, a missing singleton key and a key on a plain queue are refused, each naming the queue',
    check: (report) => {
      expect(report.undeclaredEnqueue).toContain(`the queue "${SCENARIO_QUEUES.undeclared}" was never declared`);
      expect(report.undeclaredClaim).toContain(`the queue "${SCENARIO_QUEUES.undeclared}" was never declared`);
      expect(report.undeclaredDeadLetters).toContain(`the queue "${SCENARIO_QUEUES.undeclared}" was never declared`);
      expect(report.missingSingletonKey).toContain(`the queue "${SCENARIO_QUEUES.plans}" holds one unfinished job per singleton key`);
      expect(report.keyOnAPlainQueue).toContain(`the queue "${SCENARIO_QUEUES.units}" holds no singletons`);
      expect(report.emptySingletonKey ?? '').toContain(`the enqueue into the queue "${SCENARIO_QUEUES.plans}" named an empty singleton key`);
      expect(report.shortHeartbeat ?? '').toContain('the queue "short-heartbeat" was declared with a heartbeat of 9 seconds: a heartbeat is a whole number of seconds, at least 10, or left out');
      expect(report.claimWithoutAWholeNumber ?? '').toContain(`the claim of the queue "${SCENARIO_QUEUES.units}" asked for 0 jobs: a claim takes a whole number of jobs, at least 1`);
      expect(report.fractionalPriority ?? '').toContain(`the enqueue into the queue "${SCENARIO_QUEUES.units}" named the priority 1.5: a priority is a whole number, higher claimed first`);
    },
  },
];
