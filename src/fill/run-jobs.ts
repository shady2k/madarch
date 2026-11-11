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
import type { ClaimedJob, QueueService } from './queue.js';

/** The queue one product's fill requests wait in, at the product's store database. */
const FILL_RUN_QUEUE = 'fill-runs';

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
  /** The task the press named, when it named one. */
  readonly task?: string;
  /**
   * The kinds the press asked for (madarch-stm0.6): the catalogue's selection and the kinds its dependencies add, in the
   * dependency order to run them in, and with a vertex the one entity it rewrites. Absent, the run fills every kind.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string };
}

/**
 * The store's fill-run queue, declared: a lease of fifteen minutes is one run's own bound, the job is retried once if the
 * process that took it ends without settling it, and a second press of a product whose job is unfinished waits.
 */
/** The one connection the queue runs its statements on, as its adapter takes it: derived, so this module holds none. */
type QueueOwner = Parameters<typeof createPgBossQueue>[0]['owner'];

export async function openFillRunQueue(owner: QueueOwner): Promise<QueueService> {
  return await withSpan('fill.job.queue', {}, async () => {
    const queue = await createPgBossQueue({ owner, schema: DEFAULT_QUEUE_SCHEMA, supervise: false });
    await queue.declare({ name: FILL_RUN_QUEUE, leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true });
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
