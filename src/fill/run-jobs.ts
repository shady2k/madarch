/**
 * A fill a person asks for, and the process that runs it (madarch-8bdc.9, the owner's separation of roles): the api role
 * serves the pages and the press, the fill role reads git and publishes, and the two talk only through PostgreSQL — one
 * job per pressed product in the store's own queue (decision 0027's queue, at the store's database). Two fill processes
 * against one store claim a job once between them: the queue's claim is exclusive (`FOR UPDATE SKIP LOCKED` under the
 * adapter), and the singleton key holds one unfinished job per product, so a second press while a run is under way
 * creates nothing.
 */
import { createPgBossQueue, DEFAULT_QUEUE_SCHEMA, holdsUnfinishedIn, JobClaimLapsedError } from '../adapters/pg-boss-queue.js';
import type { OuterTransaction } from '../history-types.js';
import { withSpan } from '../obs/trace.js';
import { RUN_JOB_HEARTBEAT_SECONDS, RUN_JOB_LEASE_SECONDS } from './queue-limits.js';
import type { ClaimedJob, EnqueueResult, FailOutcome, QueueService } from './queue.js';

/** The queue one product's fill requests wait in, at the product's store database: its claim is the run's lock. */
export const FILL_RUN_QUEUE = 'fill-runs';

/** One pressed fill, as the queue carries it to the process that runs it. */
export interface FillRunJob {
  /** The product's folder: the process that runs the job reads its manifest and its repositories there. */
  readonly product: string;
  /** The product's store folder: its graph database is the one the run writes. */
  readonly store: string;
  /** The run's id, named by the press, so the run's trace and its events are found by it. */
  readonly runId: string;
  /** The language the press named, when it named one. */
  readonly language?: string;
  readonly agent?: string | null;
  /** The model and the reasoning level this run asks of its agent (madarch-64o5.90): the press's, not the saved pair. */
  readonly model?: string;
  readonly reasoning?: string;
  readonly tokenCap?: number;
  /** The task the press named, when it named one. */
  readonly task?: string;
  /**
   * The kinds the press asked for (madarch-stm0.6): the catalogue's selection and the kinds its dependencies add, in the
   * dependency order to run them in, and with a vertex the one entity it rewrites. Absent, the run fills every kind.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string; readonly requested?: readonly string[]; readonly pluginsOnly?: boolean };
}

/**
 * The store's fill-run queue, declared: the claimed job is the run's own lock — one job per product while its run
 * runs, a lease wide enough for the worst case a fill may take, a heartbeat that shows the process holding it is
 * alive, and one retry for the claim a next process takes when that process ended. A second press of a product
 * whose job is unfinished waits.
 */
/** The one connection the queue runs its statements on, as its adapter takes it: derived, so this module holds none. */
type QueueOwner = Parameters<typeof createPgBossQueue>[0]['owner'];

export async function openFillRunQueue(owner: QueueOwner): Promise<QueueService> {
  return await withSpan('fill.job.queue', {}, async () => {
    // No background supervisor of its own — a role that stops leaves no timer — but an explicit `recover` is not held
    // back by the adapter's minute-long pass interval: an abandoned claim is swept within ten seconds of being asked
    // about (ALX-2024).
    const queue = await createPgBossQueue({ owner, schema: DEFAULT_QUEUE_SCHEMA, supervise: false, superviseIntervalSeconds: 10 });
    // The claimed job is the run's own lock while it runs (decision 0039, item 12): its lease is the worst case
    // one fill may take, its heartbeat is renewed by the process that runs it, and its one retry is the claim a
    // next process takes when the process that held the run ended.
    await queue.declare({
      name: FILL_RUN_QUEUE,
      leaseSeconds: RUN_JOB_LEASE_SECONDS,
      retries: 1,
      retryDelaySeconds: 5,
      retryBackoff: false,
      heartbeatSeconds: RUN_JOB_HEARTBEAT_SECONDS,
      singletons: true,
    });
    return queue;
  });
}

/** Asks for one fill of one product: the job the queue created, or that a press of it already waits. */
export async function enqueueFillRun(queue: QueueService, job: FillRunJob): Promise<EnqueueResult> {
  return await withSpan('fill.job.ask', { 'madarch.product': job.product, 'madarch.run': job.runId }, async () => {
    return await queue.enqueue({ queue: FILL_RUN_QUEUE, data: job, singletonKey: job.product });
  });
}

/** Takes the oldest asked fill, if one waits: two processes that claim at one instant get one job between them. */
export async function claimFillRun(queue: QueueService): Promise<ClaimedJob<FillRunJob> | null> {
  return await withSpan('fill.job.claim', {}, async () => {
    const claimed = await queue.claim<FillRunJob>({ queue: FILL_RUN_QUEUE, limit: 1 });
    return claimed[0] ?? null;
  });
}

/**
 * Whether a process still holds this product's fill: its `fill-runs` job is unfinished, which is the queue's own proof
 * that an attempt was asked for the product and drives its run — even while the run plans, or between two units, when no
 * row of the run's own moves (ALX-2024, ALX-2026 finding 5). The queue's sweep runs first, so the claim of a process that
 * died is handed back to its retry instead of holding the product for its lease's whole day, and a live claim survives
 * the sweep; a job that waits for its retry is an attempt still owed to the run, so it holds it too. `null` is no answer: the
 * queue could not be opened, declared or read, which proves nothing either way about the run.
 */
export async function fillRunHeldElsewhere(owner: QueueOwner, productFolder: string, transaction?: OuterTransaction): Promise<boolean | null> {
  // Inside the caller's transaction the store's owner refuses a statement outside it, so the queue's own table is read
  // through that transaction: the fence that serialises the run's writes is where the ownership question is answered
  // (ALX-2024). A read that fails there is still no answer rather than proof of abandonment.
  if (transaction !== undefined) {
    try {
      return await holdsUnfinishedIn(transaction, { queue: FILL_RUN_QUEUE, singletonKey: productFolder });
    } catch {
      return null;
    }
  }
  // A queue this process cannot open or declare is a question it cannot answer: `false` here would read as "no attempt
  // holds the run" and let a direct caller end a live one (ALX-2026 finding 5).
  const queue = await openFillRunQueue(owner).catch(() => undefined);
  if (queue === undefined) return null;
  try {
    await queue.recover(FILL_RUN_QUEUE).catch(() => undefined);
    return await queue.holdsUnfinished(FILL_RUN_QUEUE, productFolder);
  } catch {
    return null;
  } finally {
    await queue.stop().catch(() => undefined);
  }
}

/** How often the attempt that holds a `fill-runs` job touches its claim: a third of the 30 s an untouched claim lives. */
const CLAIM_HEARTBEAT_MS = RUN_JOB_HEARTBEAT_SECONDS * 1000 / 3;

/** One live heartbeat of a claimed job, stopped by the attempt that started it. */
export interface ClaimHeartbeat {
  /** Stops the beat and waits for one already sent, so nothing touches a job the caller has settled. */
  stop(): Promise<void>;
}

/**
 * Keeps one claimed `fill-runs` job alive for as long as the attempt that holds it runs (ALX-2077): from the claim through
 * the store's setup, the run, the cleanup of a run that failed and the queue's settlement. The queue treats a claim it has
 * not heard from in 30 s as dead and hands the job to its next attempt, so an attempt that only beat while its fill drove
 * lost its claim to the queue's own sweep during the cleanup — and then wrote its units, its run, its chain and its end
 * under the feet of the attempt the queue had already given them to. The beat is the attempt's own: once it stops, or the
 * claim lapses, the queue is the only one that decides who holds the job.
 */
export function startClaimHeartbeat(queueService: QueueService, job: ClaimedJob<unknown>, intervalMs: number = CLAIM_HEARTBEAT_MS): ClaimHeartbeat {
  let beating: Promise<void> | undefined;
  const beat = (): void => {
    // A beat that fails — the claim lapsed, or the store closed — answers `false` or throws and is not retried here: the
    // fence that decides whether this attempt may still write is the settlement's own, and a failed beat is its evidence.
    beating = queueService.heartbeat(job.queue, job).then(() => undefined, () => undefined).finally(() => { beating = undefined; });
  };
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await beating;
    },
  };
}

/**
 * Settles one claimed fill: a run that ended settles the job done, and one whose attempt gave up is retried by the queue.
 * The answer says which happened, because a job whose retries are spent is the last attempt the run gets and what it
 * leaves behind is that process's to end (ALX-2024). `lapsed` is the third answer (ALX-2077): the attempt named is no
 * longer the one the queue hands out, so this attempt settled nothing and it is the new holder's to settle.
 */
export async function settleFillRun(queue: QueueService, job: ClaimedJob<FillRunJob>, outcome: { readonly ok: boolean; readonly message?: string }): Promise<'completed' | FailOutcome | 'lapsed'> {
  return await withSpan('fill.job.settle', { 'madarch.run': job.data.runId, 'madarch.outcome': outcome.ok ? 'done' : 'failed' }, async () => {
    if (outcome.ok) {
      // A done settlement the queue refuses wrote nothing either: the claim lapsed, and the attempt that holds the job now
      // owns its answer.
      return await queue.complete(FILL_RUN_QUEUE, job, { runId: job.data.runId }) ? 'completed' as const : 'lapsed' as const;
    }
    try {
      return await queue.fail(FILL_RUN_QUEUE, job, outcome.message ?? `the fill of ${job.data.product} ended without an answer`);
    } catch (error) {
      // The queue's own refusal is the attempt that lapsed its claim saying so: this attempt writes nothing more, and the
      // role keeps serving (ALX-2077). Anything else is still the unexpected error the worker surfaces.
      if (error instanceof JobClaimLapsedError) return 'lapsed' as const;
      throw error;
    }
  });
}
