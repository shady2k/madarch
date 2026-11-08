/**
 * The read worker (madarch-m38l.4, remark 3): `madarch knowledge-read-worker`.
 * It answers the server's statements on this process's own thread, so a page of
 * the wiki never waits for the server's thread, and it holds one *snapshot* of
 * the product's store: a repeatable-read transaction begun when the worker
 * opened. The store is the one the fill writes (madarch-8bdc.2.5, item 1): no
 * copy of it is made for a reader, because a repeatable-read transaction already
 * answers the store as it stood at its first statement, and the server starts a
 * new worker — a new transaction — for each numbered snapshot the fill
 * publishes. The old worker is ended once the new one answers.
 *
 * Messages are lines of JSON (`wire.ts`) on standard input and output.
 */
import { mkdirSync } from 'node:fs';
import { storeDatabasePath } from '../product/store.js';
import { createDatabaseOwner, type DatabaseOwner, type OuterTransaction } from '../adapters/database-owner.js';
import { createGraphStore, createRecordSchema } from '../graph/index.js';
import { decodeWire, encodeWire } from './wire.js';

export type ReadRequest =
  | { type: 'open'; path: string; create: boolean }
  /** One statement outside any transaction. */
  | { type: 'query'; id: number; sql: string; values?: unknown[] }
  | { type: 'begin'; id: number; kind: 'snapshot' | 'write' }
  /** A statement inside the open transaction `tx`. */
  | { type: 'in'; id: number; tx: number; sql: string; values?: unknown[] }
  | { type: 'end'; tx: number; commit: boolean };

export type ReadReply =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'rows'; id: number; rows: unknown[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'begun'; id: number }
  | { type: 'ended'; tx: number; error?: string };

const SCHEMA_TABLE = `CREATE TABLE IF NOT EXISTS knowledge_fill (
  repo text PRIMARY KEY, scope text, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
  commits int NOT NULL, filled_commits int NOT NULL)`;

export async function runReadWorker(io: { lines: AsyncIterable<string>; send: (reply: string) => void }): Promise<number> {
  const send = (reply: ReadReply): void => io.send(encodeWire(reply));
  let owner: DatabaseOwner | undefined;
  const transactions = new Map<number, { queue: ReadRequest[]; wake: (() => void) | undefined }>();
  /**
   * The snapshot every answer of this worker is read at: a transaction that only ran `pg_export_snapshot()`, so it holds
   * no relation lock and a fill's DDL never waits on a reader; each page imports it with `SET TRANSACTION SNAPSHOT` in a
   * transaction of its own, which is short. This is what lets a reader see one moment of the store while the fill keeps
   * writing it — and never block the writer.
   */
  let exported: { readonly id: string; finish(): void } | undefined;
  /** The statements and transactions under way; each leaves the set when it ends. */
  const work = new Set<Promise<void>>();
  const track = (operation: Promise<void>): void => {
    work.add(operation);
    void operation.finally(() => work.delete(operation));
  };
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const runStatement = async (target: { query: OuterTransaction['query'] }, id: number, sql: string, values: unknown[] | undefined): Promise<void> => {
    try {
      const result = await target.query(sql, values ?? []);
      send({ type: 'rows', id, rows: result.rows });
    } catch (error) {
      send({ type: 'error', id, message: errorText(error) });
    }
  };

  /**
   * Exports this reader's snapshot: one transaction that runs `pg_export_snapshot()` and then waits, holding no relation
   * lock. Its id is what every answer is read at, and the transaction that holds it is the only long-lived one here.
   */
  const exportSnapshot = async (): Promise<{ readonly id: string; finish(): void }> => {
    let settle!: (id: string) => void;
    const id = new Promise<string>((resolve) => { settle = resolve; });
    let release!: () => void;
    const kept = new Promise<void>((resolve) => { release = resolve; });
    track(owner!.transaction('snapshot', async (tx) => {
      const held = await tx.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
      settle(held.rows[0]!.id);
      await kept;
    }).catch(() => undefined));
    return { id: await id, finish: release };
  };

  /** Runs one transaction at the reader's snapshot: `SET TRANSACTION SNAPSHOT` first, which takes only the moment. */
  const atSnapshot = async <T>(work: (tx: OuterTransaction) => Promise<T>): Promise<T> => {
    const snapshot = exported?.id;
    return await owner!.transaction('snapshot', async (tx) => {
      if (snapshot !== undefined) await tx.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
      return await work(tx);
    });
  };

  const beginTransaction = (request: Extract<ReadRequest, { type: 'begin' }>): void => {
    const state: { queue: ReadRequest[]; wake: (() => void) | undefined } = { queue: [], wake: undefined };
    transactions.set(request.id, state);
    const snapshot = exported?.id;
    track(owner!.transaction(request.kind, async (tx) => {
      if (request.kind === 'snapshot' && snapshot !== undefined) await tx.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
      send({ type: 'begun', id: request.id });
      for (;;) {
        while (state.queue.length === 0) await new Promise<void>((resolve) => { state.wake = resolve; });
        const next = state.queue.shift()!;
        if (next.type === 'in') await runStatement(tx, next.id, next.sql, next.values);
        else if (next.type === 'end') {
          if (!next.commit) throw new Error('rolled back at the server\'s request');
          return;
        }
      }
    }).then(
      () => { transactions.delete(request.id); send({ type: 'ended', tx: request.id }); },
      (error: unknown) => { transactions.delete(request.id); send({ type: 'ended', tx: request.id, error: errorText(error) }); },
    ));
  };

  for await (const line of io.lines) {
    const request = decodeWire<ReadRequest>(line);
    if (request.type === 'open') {
      try {
        mkdirSync(request.path, { recursive: true });
        // The store folder: the reader reads the database the fill writes, never a copy of it.
        owner = await createDatabaseOwner({ store: storeDatabasePath(request.path), btreeGist: true });
        await owner.ready;
        // A reader reads the store the fill writes, so it writes nothing unless the store has no tables at all (an empty
        // folder the home made, or an earlier madarch's): then it makes them, as the fill's own schema does, so a first
        // read is an empty page and never a missing relation. A store that has them is read and not touched — a write
        // here would lock the tables a running fill is publishing into.
        const there = async (): Promise<boolean> => (await owner!.run(async (tx) => await tx.query<{ there: boolean }>("SELECT to_regclass('public.knowledge_fill') IS NOT NULL AS there"))).rows[0]?.there === true;
        if (!(await there())) {
          // A store no fill has written yet gets its tables from this reader, so a product before its first fill reads as
          // empty. A fill that is creating the same tables at the same instant holds the locks in its own order and one
          // of the two is chosen as the deadlock victim: that answer is PostgreSQL telling this side to try again, and
          // the second attempt finds the tables the other side committed.
          for (let attempt = 1; ; attempt += 1) {
            try {
              await createGraphStore(owner).createSchema();
              // This step's record tables too (madarch-8bdc.2.5): a snapshot of a store the fill has not run on is
              // read for its repository and its files, and a missing relation would be a failed page, not an empty one.
              await createRecordSchema(owner);
              await owner.transaction('write', async (tx) => { await tx.query(SCHEMA_TABLE); });
              break;
            } catch (error) {
              const retryable = /deadlock detected/i.test(errorText(error)) || /could not serialize access/i.test(errorText(error));
              if (!retryable || attempt >= 5) throw error;
              await Bun.sleep(100 * attempt);
              if (await there()) break;
            }
          }
        }
        // The snapshot: a transaction that holds nothing but an exported snapshot id.
        exported = await exportSnapshot();
        send({ type: 'ready' });
      } catch (error) {
        send({ type: 'failed', message: `the snapshot ${request.path} could not be opened: ${errorText(error)}` });
        return 1;
      }
      continue;
    }
    if (owner === undefined) {
      send({ type: 'failed', message: `src/knowledge/read-worker.ts: a ${request.type} came before the snapshot was opened` });
      return 1;
    }
    if (request.type === 'query') {
      // A bare statement is answered at the reader's snapshot, in a transaction that lasts as long as the statement.
      const { id, sql, values } = request;
      track(atSnapshot(async (tx) => await runStatement(tx, id, sql, values)));
    } else if (request.type === 'begin') {
      beginTransaction(request);
    } else {
      const state = transactions.get(request.type === 'in' ? request.tx : request.tx);
      if (state === undefined) {
        if (request.type === 'in') send({ type: 'error', id: request.id, message: `src/knowledge/read-worker.ts: transaction ${request.tx} is not open` });
        continue;
      }
      state.queue.push(request);
      state.wake?.();
    }
  }
  // The server's pipe is closed: a transaction still open will get no more words, so each is rolled back and ends,
  // and the exported snapshot's transaction ends too — a worker whose server was killed must not sit on the machine
  // holding a snapshot nothing will read.
  for (const state of transactions.values()) {
    state.queue.push({ type: 'end', tx: -1, commit: false });
    state.wake?.();
  }
  exported?.finish();
  exported = undefined;
  // The work ends with the pipe: a statement still running is given a moment, and then the process goes regardless.
  await Promise.race([
    (async () => { while (work.size > 0) await Promise.allSettled([...work]); })(),
    new Promise<void>((resolve) => { setTimeout(resolve, 2_000).unref?.(); }),
  ]);
  await owner?.close().catch(() => undefined);
  // The moment this process exists for is over: it ends now, whatever a library kept alive.
  process.exit(0);
}
