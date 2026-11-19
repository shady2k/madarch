/**
 * A fill a person asks for, and the process that runs it (madarch-8bdc.9, the owner's separation of roles): the api role
 * serves the pages and the press, the fill role reads git and publishes, and the two talk only through PostgreSQL — one
 * job per pressed product in the store's own queue (decision 0027's queue, at the store's database). Two fill processes
 * against one store claim a job once between them: the queue's claim is exclusive (`FOR UPDATE SKIP LOCKED` under the
 * adapter), and the singleton key holds one unfinished job per product, so a second press while a run is under way
 * creates nothing.
 */
import { createPgBossQueue, DEFAULT_QUEUE_SCHEMA } from '../adapters/pg-boss-queue.js';
import { withSpan } from '../obs/trace.js';
import { RUN_JOB_LEASE_SECONDS } from './orchestrator-host.js';
import { RUN_JOB_HEARTBEAT_SECONDS } from './queue-limits.js';
import type { ClaimedJob, QueueService } from './queue.js';

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
    const queue = await createPgBossQueue({ owner, schema: DEFAULT_QUEUE_SCHEMA, supervise: false });
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

/** Asks for one fill of one product: answers whether the queue created the job, or a press of it already waits. */
export async function askFillRun(queue: QueueService, job: FillRunJob): Promise<boolean> {
  return await withSpan('fill.job.ask', { 'madarch.product': job.product, 'madarch.run': job.runId }, async () => {
    const created = await queue.enqueue({ queue: FILL_RUN_QUEUE, data: job, singletonKey: job.product });
    return created.created;
  });
}

/** Takes the oldest asked fill, if one waits: two processes that claim at one instant get one job between them. */
export async function claimFillRun(queue: QueueService): Promise<ClaimedJob<FillRunJob> | null> {
  return await withSpan('fill.job.claim', {}, async () => {
    const claimed = await queue.claim<FillRunJob>({ queue: FILL_RUN_QUEUE, limit: 1 });
    return claimed[0] ?? null;
  });
}

/** Settles one claimed fill: a run that ended settles the job, and one that failed is retried by the queue once. */
export async function settleFillRun(queue: QueueService, job: ClaimedJob<FillRunJob>, outcome: { readonly ok: boolean; readonly message?: string }): Promise<void> {
  await withSpan('fill.job.settle', { 'madarch.run': job.data.runId, 'madarch.outcome': outcome.ok ? 'done' : 'failed' }, async () => {
    if (outcome.ok) await queue.complete(FILL_RUN_QUEUE, job, { runId: job.data.runId });
    else await queue.fail(FILL_RUN_QUEUE, job, outcome.message ?? `the fill of ${job.data.product} ended without an answer`);
  });
}
