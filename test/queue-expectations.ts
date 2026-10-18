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
      expect(report.claimedByPriority).toEqual([
        { unit: 'high', attempt: 0, leaseSeconds: 60 },
        { unit: 'middle', attempt: 0, leaseSeconds: 60 },
      ]);
      expect(report.claimedLast).toEqual([{ unit: 'low', attempt: 0, leaseSeconds: 60 }]);
    },
  },
  {
    name: 'a singleton key holds a second job back until the first settles, and different keys are independent',
    check: (report) => {
      expect(report.secondKeyCreated).toBe(false);
      expect(report.otherKeyCreated).toBe(true);
      expect(report.keyFreedCreated).toBe(true);
    },
  },
  {
    name: 'a claim whose lease lapsed is recovered as the next attempt, and the attempt that lost it can neither settle nor heartbeat it',
    check: (report) => {
      expect(report.claimsWhileLeaseHeld).toBe(0);
      expect(report.attemptAfterRecover).toBe(1);
      expect(report.staleComplete).toBe(false);
      expect(report.staleHeartbeat).toBe(false);
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
          id: expect.any(String),
          queue: SCENARIO_QUEUES.fixedDead,
          sourceQueue: SCENARIO_QUEUES.fixed,
          data: { unit: 'flaky' },
          reason: 'the second attempt failed',
          attempts: 1,
          deadLetteredAt: expect.any(Number),
        },
      ]);
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
    },
  },
];
