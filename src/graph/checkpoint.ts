/**
 * The WAL checkpoint a fill needs (madarch-8bdc.2.5, item 5): PGlite runs PostgreSQL
 * in single-user mode (`--single`), where the checkpointer process does not exist, so
 * nothing turns `max_wal_size` into a checkpoint and `pg_wal` only grows.
 *
 * **Measured.** The whole-repository fill wrote 6.9 GB of `pg_wal` while it published
 * 5 374 units (about 600 000 node versions) into a store whose `base/` was 4.6 GB, and
 * the box ran out of disk at 78 % of a 38 GB volume. On a scratch store, `CHECKPOINT`
 * keeps the segment count flat: with a checkpoint after every 5 000 inserted rows the
 * directory stayed at 32 MB (2 segments) while 30 000 rows were written, at 2-33 ms a
 * checkpoint (postgresql.conf keeps `max_wal_size` at 1 GB, which no process reads in
 * this mode). About 11 KB of WAL fell on each version of the fill's store, so a
 * checkpoint after every 20 000 versions written bounds the directory at a few hundred
 * megabytes and costs a few microseconds a row.
 *
 * A checkpoint writes the dirty buffers to the data directory and marks the point from
 * which old segments may be recycled; it writes no row of the graph, takes no lock a
 * reader waits on, and is run between publications, never inside one.
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
