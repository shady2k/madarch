/**
 * The file-text queue (madarch-u3vw.16, decision 0037): a page's read of a file's text is a job on the one pg-boss queue,
 * claimed by the fill role, which asks the git plugin for the blob's lines through madarch.plugins/3 and settles the job
 * with the bytes as its result. The api role enqueues the job and reads its own record back through the queue, so there
 * is one queue and no second store: the queue holds the request and the answer.
 *
 * The plugin's own side of a read — the sandbox, the confinement, the plugin session — is src/plugin/file-reads.ts; this
 * module holds the queue's side and nothing that touches a file.
 */
import type { ClaimedJob, QueueService } from '../fill/queue.js';
import { readBlobThroughPlugin } from '../plugin/file-reads.js';
import type { FileTextResult } from './file-text-shape.js';


const WHERE = 'src/knowledge/file-texts.ts';

/** The queue the reads wait in: the store's one pg-boss queue, beside the fills. */
export const FILE_TEXT_QUEUE = 'file-texts';

/** One request on the queue: the product, the plugin's folder, the repository and the blob, with the lines asked for. */
export interface FileTextJob {
  readonly product: string;
  readonly plugin: string;
  readonly repository: string;
  readonly root: string;
  readonly blob: string;
  readonly from: number;
  /** The column inside `from` the text starts at, 1-based: where a line cut at the byte bound continues. */
  readonly fromColumn: number | null;
  readonly to: number | null;
}

/** Declares the read queue on a store's queue service: a read is quick, and one retry covers a host that died mid-read. */
export async function declareFileTextQueue(queue: QueueService): Promise<void> {
  // The declaration the store preparation installed, applied to this client: the settings must be the prepared ones.
  await queue.declare({ name: FILE_TEXT_QUEUE, leaseSeconds: 120, retries: 1, retryDelaySeconds: 1, retryBackoff: false });
}

/** Asks for one read: the job's id is what the caller reads its answer by. */
export async function askFileText(queue: QueueService, request: FileTextJob): Promise<string> {
  const held = await queue.enqueue({ queue: FILE_TEXT_QUEUE, data: request });
  if (!held.created) throw new Error(`${WHERE}:1: the queue created no file read: the ${FILE_TEXT_QUEUE} queue holds singletons and its key was taken`);
  return held.id;
}

/** The answer to one read, or null while the queue holds no answer yet. */
export async function fileTextAnswer(queue: QueueService, id: string): Promise<FileTextResult | { readonly error: string } | null> {
  const held = await queue.job<FileTextResult & { readonly error?: string }>(FILE_TEXT_QUEUE, id);
  if (held === null) return null;
  if (held.state === 'completed') return held.output ?? { error: `${WHERE}:1: the read's job completed with no answer` };
  if (held.state === 'failed' || held.state === 'cancelled') return { error: held.output?.error ?? `${WHERE}:1: the read's job ended ${held.state} without words` };
  return null;
}

/** The oldest reads waiting, claimed for this pass. */
export async function claimFileTexts(queue: QueueService, limit = 4): Promise<readonly ClaimedJob<FileTextJob>[]> {
  return await queue.claim<FileTextJob>({ queue: FILE_TEXT_QUEUE, limit });
}

/** Settles one read: the bytes as the job's result, or the words of why it could not be read. */
export async function settleFileText(queue: QueueService, job: ClaimedJob<FileTextJob>, answer: FileTextResult | { readonly error: string }): Promise<void> {
  if ('error' in answer) await queue.fail(FILE_TEXT_QUEUE, job, answer.error);
  else await queue.complete(FILE_TEXT_QUEUE, job, answer);
}

/** How long a page waits for its read: the fill role claims the request within a pass, and a read of a blob is quick. */
export const FILE_TEXT_DEADLINE_MS = 30_000;

/**
 * A file's text, asked of the store's one queue and awaited: the api role and the read worker both ask this way, and the
 * fill role answers (madarch-u3vw.16, decision 0037). `root` is the repository folder the host confines the read to.
 */
export async function readFileTextByBlob(queue: QueueService, ask: { readonly product: string; readonly repository: string; readonly root: string; readonly blob: string; readonly from: number; readonly fromColumn: number | null; readonly to: number | null }): Promise<FileTextResult> {
  const id = await askFileText(queue, { product: ask.product, plugin: 'plugins/git', repository: ask.repository, root: ask.root, blob: ask.blob, from: ask.from, fromColumn: ask.fromColumn, to: ask.to });
  const deadline = Date.now() + FILE_TEXT_DEADLINE_MS;
  let asked = 0;
  while (Date.now() < deadline) {
    const held = await fileTextAnswer(queue, id);
    if (held !== null) {
      if ('error' in held) throw new Error(held.error);
      return held;
    }
    asked += 1;
    // A read whose worker died is recovered by the queue's own sweep: ask it now and then rather than wait the lease.
    if (asked % 20 === 0) await queue.recover(FILE_TEXT_QUEUE).catch(() => undefined);
    await Bun.sleep(50);
  }
  throw new Error(`${WHERE}:1: no file read answered within ${String(FILE_TEXT_DEADLINE_MS)} ms: a file's text is read through the plugin host, and no fill role is answering (madarch serve starts one)`);
}

/** The words one failed read answers with: the refusal's own, or the failure's, never a bare exception. */
function failureOf(error: unknown): string {
  return error instanceof Error ? `${WHERE}:1: ${error.message}` : `${WHERE}:1: the read failed: ${String(error)}`;
}

/** Answers the reads waiting on the queue: the api role's pages wait on these jobs. Answers how many were served. */
export async function serveFileTexts(queue: QueueService, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void } = {}): Promise<number> {
  const jobs = await claimFileTexts(queue);
  for (const job of jobs) {
    try {
      const answer = await readBlobThroughPlugin({ product: job.data.product, plugin: job.data.plugin, repository: job.data.repository, root: job.data.root, blob: job.data.blob, from: job.data.from, ...(job.data.fromColumn === null ? {} : { fromColumn: job.data.fromColumn }), ...(job.data.to === null ? {} : { to: job.data.to }) }, options);
      await settleFileText(queue, job, answer);
    } catch (error) {
      options.log?.(`madarch file read: ${failureOf(error)}`);
      await settleFileText(queue, job, { error: failureOf(error) });
    }
  }
  return jobs.length;
}
