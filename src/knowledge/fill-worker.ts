/**
 * The fill worker (madarch-m38l.4, decision 0033 item 27): `madarch knowledge-fill-worker`.
 * It owns one product's store while a fill runs — opens PGlite, boots it, runs the one
 * runner `runFill` over it and finishes it — so the server that serves the wiki's pages
 * never holds the store's thread: a PGlite runs every statement on the thread that owns
 * it, and a page asked while the store boots waits seconds for it (CI measured three pages
 * of the training repository answering in 2 454, 2 723 and 2 936 ms while a first fill opened
 * its store inside the server's process).
 *
 * The server starts one for each fill it runs and speaks lines of JSON to it (`wire.ts`):
 * `start` names the product, the store and the run; the worker answers `started`, then a
 * `snapshot` line for every numbered snapshot it publishes for the reader (so the
 * server's pages follow the fill as it reads), and one `done` line with the run's result.
 * `control` carries a person's pause or stop into the run's own state machine.
 */
import { startKnowledgeFill, type KnowledgeFillOptions, type KnowledgeFillResult, type KnowledgeFillRun } from './fill-run.js';
import { storeDatabasePath } from '../product/store.js';
import { linesOf } from './lines.js';
import { selfCommand } from '../product/self-command.js';
import { decodeWire, encodeWire } from './wire.js';

/** Whether a store answers as the fill's database: an opened connection, as `startKnowledgeFill` takes it. */
export type FillStoreOwner = KnowledgeFillOptions['database'];

/** What the server asks of the worker. */
type FillRequest =
  | { type: 'start'; id: number; productFolder: string; storeFolder: string; runId: string }
  | { type: 'control'; id: number; action: 'pause' | 'stop' };

/** What the worker answers. */
type FillReply =
  | { type: 'started'; id: number }
  | { type: 'failed'; id: number; message: string }
  /** A numbered snapshot a reader opens: its folder number, and the pins the store held when it was made. */
  | { type: 'snapshot'; seq: number }
  | { type: 'done'; id: number; result: KnowledgeFillResult }
  | { type: 'controlled'; id: number; ok: boolean; state?: string; message?: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The worker's own loop: one fill, the snapshots it publishes, a person's pause or stop,
 * and one answer at its end. `openStore` opens the store's connection: the caller that
 * owns the process supplies it, so this module never names a database connection
 * (decision 0033, item 3).
 */
export async function runFillWorker(io: { lines: AsyncIterable<string>; send: (line: string) => void }, openStore: (path: string) => FillStoreOwner): Promise<number> {
  const send = (reply: FillReply): void => io.send(encodeWire(reply));
  let run: KnowledgeFillRun | undefined;
  /** The run to its answer, written by the loop below: the worker does not exit before its run has said what it did. */
  let ended: Promise<void> = Promise.resolve();
  for await (const line of io.lines) {
    const request = decodeWire<FillRequest>(line);
    if (request.type === 'start') {
      if (run !== undefined) {
        send({ type: 'failed', id: request.id, message: 'a fill worker runs one fill: this one has already been asked for a store' });
        continue;
      }
      const database = openStore(storeDatabasePath(request.storeFolder));
      try {
        run = await startKnowledgeFill({
          productFolder: request.productFolder,
          storeFolder: request.storeFolder,
          runId: request.runId,
          database,
          // A server's pages follow the fill: every snapshot the run publishes is one its reader can open now.
          onPublish: (seq) => send({ type: 'snapshot', seq }),
        });
      } catch (error) {
        await database.close().catch(() => undefined);
        send({ type: 'failed', id: request.id, message: errorText(error) });
        return 1;
      }
      send({ type: 'started', id: request.id });
      ended = run.done.then(
        (result) => send({ type: 'done', id: request.id, result }),
        (error: unknown) => send({ type: 'done', id: request.id, result: { ok: false, state: 'failed', message: errorText(error), units: 0 } }),
      );
      continue;
    }
    const answer = run === undefined
      ? { ok: false, message: 'no fill of this store has started in this worker: there is nothing to pause or to stop' }
      : await run.control(request.action);
    send({ type: 'controlled', id: request.id, ...answer });
  }
  // The server's pipe is closed: a run still under way is stopped, and its answer is written before this process ends.
  await run?.control('stop').catch(() => undefined);
  await ended.catch(() => undefined);
  return 0;
}

/** A started fill worker: lines in, lines out, and the process to end. */
interface FillWorkerProcess {
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  stderr(): string;
  kill(): void;
}

/** Starts `madarch knowledge-fill-worker` as a process of its own. */
function spawnFillWorker(): FillWorkerProcess {
  const { command, args } = selfCommand(['knowledge-fill-worker']);
  const child = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
  let tail = '';
  void (async () => {
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-4000);
  })();
  return {
    write: (line) => {
      try {
        child.stdin.write(`${line}\n`);
        void child.stdin.flush();
      } catch {
        // the worker is gone; its exit rejects what waits
      }
    },
    lines: linesOf(child.stdout as unknown as AsyncIterable<Uint8Array>),
    exited: child.exited,
    stderr: () => tail,
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

/** What one fill's worker is asked to run: the product, its store, and the run's id. */
export interface FillWorkerRun {
  readonly productFolder: string;
  readonly storeFolder: string;
  readonly runId: string;
}

/**
 * A fill the server runs in a worker process, as the run a caller controls: the store is
 * the worker's, the snapshots it publishes are handed to `opened`, and a pause or stop is
 * carried to the run's own state machine over the pipe.
 */
export function startFillInWorker(options: FillWorkerRun, opened: (seq: number) => void): KnowledgeFillRun & { close(): Promise<void> } {
  const child = spawnFillWorker();
  let next = 1;
  let answered = false;
  /** Whether the run has said how it ended: a control after that is refused by name, not by the worker's exit code. */
  let finished = false;
  let resolveDone!: (result: KnowledgeFillResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<KnowledgeFillResult>((resolve, reject) => {
    resolveDone = (result) => { answered = true; resolve(result); };
    rejectDone = (error) => { answered = true; reject(error); };
  });
  // A caller that never awaits the answer is not a caller with an unhandled rejection.
  void done.catch(() => undefined);
  const waiting = new Map<number, (reply: FillReply) => void>();
  /** Why the worker ended, once it has: a control asked after that is answered from here rather than into a closed pipe. */
  let gone: string | undefined;
  const startId = next++;
  void (async () => {
    try {
      for await (const line of child.lines) {
        const reply = decodeWire<FillReply>(line);
        if (reply.type === 'snapshot') { opened(reply.seq); continue; }
        if (reply.type === 'done') { finished = true; resolveDone(reply.result); continue; }
        if (reply.type === 'failed' && reply.id === startId) { rejectDone(new Error(reply.message)); continue; }
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      }
    } catch (error) {
      rejectDone(error instanceof Error ? error : new Error(String(error)));
    }
    const code = await child.exited;
    const said = child.stderr().trim().split('\n').slice(-4).join(' | ');
    gone = `src/knowledge/fill-worker.ts: the fill worker for ${options.storeFolder} ended with exit code ${String(code)}${said === '' ? '' : `: ${said}`}`;
    if (!answered) rejectDone(new Error(gone));
    for (const answer of waiting.values()) answer({ type: 'failed', id: -1, message: gone });
    waiting.clear();
  })();
  const ask = (build: (id: number) => FillRequest): Promise<FillReply> => {
    if (gone !== undefined) return Promise.resolve({ type: 'failed', id: -1, message: gone });
    return new Promise<FillReply>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.write(encodeWire(build(id)));
    });
  };
  child.write(encodeWire({ type: 'start', id: startId, ...options } satisfies FillRequest));
  return {
    runId: options.runId,
    done,
    async control(action) {
      if (finished) return { ok: false, message: `the fill ${options.runId} has ended: there is nothing to ${action === 'pause' ? 'pause' : 'stop'}` };
      const reply = await ask((id) => ({ type: 'control', id, action }));
      if (reply.type === 'controlled') return { ok: reply.ok, ...(reply.state === undefined ? {} : { state: reply.state }), ...(reply.message === undefined ? {} : { message: reply.message }) };
      return { ok: false, message: reply.type === 'failed' ? reply.message : `src/knowledge/fill-worker.ts: the worker answered ${reply.type} to a ${action}` };
    },
    async close() {
      // The run is over (or the server is ending it): the worker is killed, and the snapshot it published before this
      // stands for the reader already (the swap named it when it arrived).
      child.kill();
      await child.exited.catch(() => undefined);
    },
  };
}
