/**
 * The read worker (madarch-m38l.4, remark 3): `madarch knowledge-read-worker`.
 * It holds one snapshot of a product's graph store open (see `fill-protocol.ts`)
 * and answers the server's statements, so the statements run on this process's
 * thread and a page of the wiki never waits for the server's own thread, which
 * the opening of a database blocks for hundreds of milliseconds. The server
 * starts one for each new snapshot and ends the old one once the new answers.
 *
 * Messages are lines of JSON (`wire.ts`) on standard input and output.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner, type OuterTransaction } from '../adapters/database-owner.js';
import { createGraphStore } from '../graph/index.js';
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
  repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
  commits int NOT NULL, filled_commits int NOT NULL)`;

export async function runReadWorker(io: { lines: AsyncIterable<string>; send: (reply: string) => void }): Promise<number> {
  const send = (reply: ReadReply): void => io.send(encodeWire(reply));
  let owner: DatabaseOwner | undefined;
  const transactions = new Map<number, { queue: ReadRequest[]; wake: (() => void) | undefined }>();
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
        mkdirSync(dirname(request.path), { recursive: true });
        owner = createPGliteDatabaseOwner({ path: request.path, btreeGist: true });
        await owner.ready;
        if (request.create) {
          await createGraphStore(owner).createSchema();
          await owner.transaction('write', async (tx) => { await tx.query(SCHEMA_TABLE); });
        }
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
      track(owner.run((executor) => runStatement(executor, request.id, request.sql, request.values)));
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
  // The server's pipe is closed: a transaction still open will get no more words, so each is rolled back and ends.
  for (const state of transactions.values()) {
    state.queue.push({ type: 'end', tx: -1, commit: false });
    state.wake?.();
  }
  while (work.size > 0) await Promise.allSettled([...work]);
  await owner?.close().catch(() => undefined);
  return 0;
}
