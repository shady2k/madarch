/**
 * The WAL checkpoint a fill runs (madarch-8bdc.2.5, item 5): `CHECKPOINT` after enough versions were written, so a
 * fill's `pg_wal` never grows to `max_wal_size` (1 GB by default) before its segments are recycled.
 *
 * **What it was written for, and what it is now.** The rule was written for the in-process database, which ran
 * PostgreSQL in single-user mode (`--single`), where no checkpointer process exists: nothing turned `max_wal_size` into
 * a checkpoint and `pg_wal` grew without bound — the whole-repository fill wrote 6.9 GB of it while publishing 5 374
 * units into a store whose `base/` was 4.6 GB, and the box ran out of disk. A store now runs on a PostgreSQL server of
 * its own, whose checkpointer recycles segments: measured there, 30 000 rows written in six transactions left
 * `pg_wal` at 32 MB and it never grew. So what remains is maintenance rather than a necessity: a checkpoint marks the
 * point from which old segments may be reused, writes no row of the graph, takes no lock a reader waits on, and runs
 * between publications, never inside one.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';

/**
 * Versions written since the last checkpoint after which another one is due: about
 * 200 MB of WAL at the fill's measured rate, and a few microseconds a row of cost.
 */
export const CHECKPOINT_ROWS = 20_000;

export interface CheckpointRun {
  /** The versions written since the previous checkpoint, which made this one due. */
  readonly written: number;
  /** What the statement took, in milliseconds. */
  readonly ms: number;
}

export interface GraphCheckpoints {
  /** Versions written since the last checkpoint. */
  readonly written: number;
  /** Counts rows one publication wrote; the next checkpoint is due once they reach `CHECKPOINT_ROWS`. */
  note(rows: number): void;
  /** Runs `CHECKPOINT` when it is due, and answers what it did; null when nothing was due. */
  checkpoint(): Promise<CheckpointRun | null>;
}

export const CHECKPOINT_SQL = 'CHECKPOINT';

export function createGraphCheckpoints(owner: DatabaseOwner): GraphCheckpoints {
  let written = 0;
  let running: Promise<CheckpointRun | null> | undefined;
  const run = async (): Promise<CheckpointRun | null> => {
    if (written < CHECKPOINT_ROWS) return null;
    const count = written;
    // The counter is reset before the statement runs, so rows a publication writes while it is queued
    // are counted towards the next checkpoint rather than lost with this one.
    written = 0;
    const started = performance.now();
    await owner.transaction('write', async (tx) => { await tx.query(CHECKPOINT_SQL); });
    return { written: count, ms: Math.round(performance.now() - started) };
  };
  return {
    get written() { return written; },
    note(rows: number): void {
      if (Number.isFinite(rows) && rows > 0) written += rows;
    },
    async checkpoint(): Promise<CheckpointRun | null> {
      if (running !== undefined) await running.catch(() => undefined);
      running = run();
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
  };
}
