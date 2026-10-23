/**
 * A database owner whose database lives in another process (the read worker of
 * `read-worker.ts`): the same two shapes of work as a local owner, `transaction`
 * and `run`, with every statement sent over a pipe. The wiki's reads use only
 * `query`, so that is all a transaction hands to its work. One transaction is
 * open at a time, as in a PGlite owner, in the order they were asked for.
 */
import type { DatabaseOwner, DatabaseBackend, OuterTransaction } from '../adapters/database-owner.js';
import type { SqlTransactionKind } from '../query/sql-driver.js';
import { linesOf } from './lines.js';
import type { ReadReply, ReadRequest } from './read-worker.js';
import { decodeWire, encodeWire } from './wire.js';
import { selfCommand } from '../product/self-command.js';

/** A started read worker: lines in, lines out. */
export interface ReadWorkerProcess {
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  stderr(): string;
  kill(): void;
}

export type ReadWorkerFactory = () => ReadWorkerProcess;

export function spawnReadWorker(): ReadWorkerProcess {
  const { command, args } = selfCommand(['knowledge-read-worker']);
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

/** How many distinct statements are kept to warm a successor with. */
const RECENT_STATEMENTS = 300;

export class RemoteOwner implements DatabaseOwner {
  readonly allowConcurrentSnapshots = false;
  readonly backend: DatabaseBackend = 'pglite';
  readonly hasVector = false;
  readonly ready: Promise<void>;
  private readonly process: ReadWorkerProcess;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: ReadReply) => void; reject: (error: Error) => void }>();
  private readonly ending = new Map<number, (reply: Extract<ReadReply, { type: 'ended' }>) => void>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  /** The statements the reads made last, by their text: what a successor is warmed with (see `warm`). */
  private readonly recentStatements = new Map<string, unknown[]>();
  private failure: Error | undefined;

  constructor(readonly location: string, options: { create: boolean; factory?: ReadWorkerFactory }) {
    const proc = (options.factory ?? spawnReadWorker)();
    this.process = proc;
    let opened!: () => void;
    let refused!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { opened = resolve; refused = reject; });
    void this.ready.catch(() => undefined);
    void (async () => {
      try {
        for await (const line of proc.lines) {
          const reply = decodeWire<ReadReply>(line);
          if (reply.type === 'ready') opened();
          else if (reply.type === 'failed') { this.failure = new Error(reply.message); refused(this.failure); }
          else if (reply.type === 'ended') this.ending.get(reply.tx)?.(reply);
          else {
            const id = reply.type === 'rows' || reply.type === 'error' || reply.type === 'begun' ? reply.id : -1;
            this.waiting.get(id)?.resolve(reply);
            this.waiting.delete(id);
          }
        }
      } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      }
      const code = await proc.exited;
      this.failure ??= new Error(`src/knowledge/remote-owner.ts: the read worker for ${location} ended with exit code ${code}${this.closed ? '' : `: ${proc.stderr().trim().split('\n').slice(-4).join(' | ') || 'it said nothing on standard error'}`}`);
      refused(this.failure);
      for (const entry of this.waiting.values()) entry.reject(this.failure);
      this.waiting.clear();
      // A transaction waiting for its end is over with the worker: it ends with the failure.
      for (const ended of [...this.ending.values()]) ended({ type: 'ended', tx: -1, error: this.failure.message });
      this.ending.clear();
    })();
    this.send({ type: 'open', path: location, create: options.create });
  }

  private send(request: ReadRequest): void {
    this.process.write(encodeWire(request));
  }

  private ask(build: (id: number) => ReadRequest): Promise<ReadReply> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<ReadReply>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send(build(id));
    });
  }

  private rowsOf(reply: ReadReply): { rows: never[] } {
    if (reply.type === 'error') throw new Error(reply.message);
    if (reply.type !== 'rows') throw new Error(`src/knowledge/remote-owner.ts: the read worker answered ${reply.type} to a statement`);
    return { rows: reply.rows as never[] };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`the database owner "${this.location}" is closed`));
    const result = this.tail.then(async () => {
      await this.ready;
      return await work();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  transaction<T>(kind: SqlTransactionKind, work: (transaction: OuterTransaction) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const begun = await this.ask((id) => ({ type: 'begin', id, kind }));
      if (begun.type !== 'begun') throw new Error('src/knowledge/remote-owner.ts: the read worker did not begin the transaction');
      const tx = (begun as Extract<ReadReply, { type: 'begun' }>).id;
      const over = new Promise<Extract<ReadReply, { type: 'ended' }>>((resolve) => { this.ending.set(tx, resolve); });
      const transaction: OuterTransaction = {
        query: async (sql, values) => {
          if (kind === 'snapshot') {
            this.recentStatements.delete(sql);
            this.recentStatements.set(sql, values === undefined ? [] : [...values]);
            if (this.recentStatements.size > RECENT_STATEMENTS) this.recentStatements.delete(this.recentStatements.keys().next().value as string);
          }
          return this.rowsOf(await this.ask((id) => ({ type: 'in', id, tx, sql, values: values === undefined ? [] : [...values] }))) as never;
        },
      };
      try {
        const value = await work(transaction);
        this.send({ type: 'end', tx, commit: true });
        const ended = await over;
        if (ended.error !== undefined) throw new Error(ended.error);
        return value;
      } catch (error) {
        this.send({ type: 'end', tx, commit: false });
        await over;
        throw error;
      } finally {
        this.ending.delete(tx);
      }
    });
  }

  run<T>(work: (executor: OuterTransaction) => Promise<T>): Promise<T> {
    return this.serialize(() => work({ query: async (sql, values) => this.rowsOf(await this.ask((id) => ({ type: 'query', id, sql, values: values === undefined ? [] : [...values] }))) as never }));
  }

  /** The statements the reads made last, oldest first. */
  recent(): { sql: string; values: unknown[] }[] {
    return [...this.recentStatements].map(([sql, values]) => ({ sql, values }));
  }

  /**
   * Runs statements a predecessor answered, to the worker's own account: a process that has just opened a database
   * answers the first statement of each shape slowly (it loads the catalogs and plans), and a page that waits for that
   * is a slow page. The successor is warmed before the reads move to it. A statement that fails is skipped.
   */
  async warm(statements: readonly { sql: string; values: unknown[] }[], budgetMs = 5_000): Promise<void> {
    const until = Date.now() + budgetMs;
    for (const statement of statements) {
      if (Date.now() > until) return;
      await this.transaction('snapshot', (tx) => tx.query(statement.sql, statement.values)).catch(() => undefined);
    }
  }

  exec(): never {
    throw new Error('src/knowledge/remote-owner.ts: a remote owner runs statements one at a time; exec is for the schema of a local owner');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => undefined);
    this.process.kill();
  }
}
