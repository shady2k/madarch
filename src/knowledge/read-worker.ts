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
  /** The snapshot the worker answers from: one repeatable-read transaction, begun at the open. */
  let snapshot: { queue: ReadRequest[]; wake: (() => void) | undefined } | undefined;
  /** The transaction ids the server named, mapped onto that one snapshot. */
  const named = new Set<number>();
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

  const beginTransaction = (request: Extract<ReadRequest, { type: 'begin' }>): void => {
    const state: { queue: ReadRequest[]; wake: (() => void) | undefined } = { queue: [], wake: undefined };
    transactions.set(request.id, state);
    track(owner!.transaction(request.kind, async (tx) => {
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
        const there = await owner.run(async (tx) => await tx.query<{ there: boolean }>("SELECT to_regclass('public.knowledge_fill') IS NOT NULL AS there"));
        if (there.rows[0]?.there !== true) {
          await createGraphStore(owner).createSchema();
          // This step's record tables too (madarch-8bdc.2.5): a snapshot of a store the fill has not run on is
          // read for its repository and its files, and a missing relation would be a failed page, not an empty one.
          await createRecordSchema(owner);
          await owner.transaction('write', async (tx) => { await tx.query(SCHEMA_TABLE); });
        }
        // The snapshot itself: a repeatable-read transaction held for this process's life, so every page it answers
        // agrees with the moment the fill published it.
        const held: { queue: ReadRequest[]; wake: (() => void) | undefined } = { queue: [], wake: undefined };
        snapshot = held;
        track(owner.transaction('snapshot', async (tx) => {
          for (;;) {
            while (held.queue.length === 0) await new Promise<void>((resolve) => { held.wake = resolve; });
            const next = held.queue.shift()!;
            if (next.type === 'in') await runStatement(tx, next.id, next.sql, next.values);
            else if (next.type === 'end') return;
          }
        }).then(
          () => undefined,
          (error: unknown) => { send({ type: 'failed', message: `the reader's snapshot ended: ${errorText(error)}` }); },
        ));
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
      // Every statement of a reader is answered from its snapshot: the store it reads is the one a fill may be writing.
      snapshot!.queue.push({ type: 'in', id: request.id, tx: 0, sql: request.sql, values: request.values });
      snapshot!.wake?.();
    } else if (request.type === 'begin') {
      if (request.kind === 'write') beginTransaction(request);
      else {
        // A snapshot transaction the server opens is this worker's own held snapshot.
        named.add(request.id);
        send({ type: 'begun', id: request.id });
      }
    } else if (named.has(request.tx)) {
      if (request.type === 'in') {
        snapshot!.queue.push(request);
        snapshot!.wake?.();
      } else {
        named.delete(request.tx);
        send({ type: 'ended', tx: request.tx });
      }
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
  // The server's pipe is closed: a transaction still open will get no more words, so each is rolled back and ends.
  for (const state of transactions.values()) {
    state.queue.push({ type: 'end', tx: -1, commit: false });
    state.wake?.();
  }
  while (work.size > 0) await Promise.allSettled([...work]);
  await owner?.close().catch(() => undefined);
  return 0;
}
