/** Immutable sequence fences for branch and worktree assertion layers (0039 item 25). */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';

/** All recorded writers must hold this transaction lock until commit, so fences cannot pass uncommitted writes. */
export async function nextGraphRecordedSequence(tx: SqlExecutor): Promise<string> {
  return await withSpan('graph.nextGraphRecordedSequence', {}, async () => {
    const result = await tx.query<{ seq: string }>('SELECT graph_next_recorded_sequence()::text AS seq');
    return result.rows[0]!.seq;
  });
}

/** Create once; reopening a branch never advances its parent fence. */
export async function pinContext(tx: SqlExecutor, parent: string, ref: string): Promise<string> {
  return await withSpan('graph.pinContext', {}, async () => {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO context (parent, ref, parent_recorded_seq) VALUES ($1, $2, -1)
       ON CONFLICT (parent, ref) WHERE parent IS NOT NULL DO NOTHING RETURNING id::text AS id`, [parent, ref]);
    if (result.rows[0] !== undefined) return result.rows[0].id;
    const held = await tx.query<{ id: string }>('SELECT id::text AS id FROM context WHERE parent = $1 AND ref = $2', [parent, ref]);
    return held.rows[0]!.id;
  });
}

export interface ContextLayer {
  readonly id: string;
  /** Null means the local layer has no recorded cutoff. An unpinned parent layer has no recorded cutoff. */
  readonly recordedThrough: string | null;
}

/** A grandparent cannot leak changes newer than either descendant's inherited snapshot. */
export async function contextLayers(tx: SqlExecutor, context: string): Promise<readonly ContextLayer[]> {
  return await withSpan('graph.contextLayers', {}, async () => {
    const result = await tx.query<{ id: string; cutoff: string | null }>(
      `WITH RECURSIVE layers AS (
         SELECT id, parent, parent_recorded_seq, NULL::bigint AS cutoff, 0 AS depth FROM context WHERE id = $1
         UNION ALL
         SELECT c.id, c.parent, c.parent_recorded_seq,
           least(l.cutoff, l.parent_recorded_seq), l.depth + 1
         FROM layers l JOIN context c ON c.id = l.parent
       ) SELECT id::text AS id, cutoff::text AS cutoff FROM layers ORDER BY depth`, [context]);
    if (result.rows.length === 0) throw new Error(`${import.meta.path}:43: context ${context} does not exist`);
    return result.rows.map((row) => ({ id: row.id, recordedThrough: row.cutoff }));
  });
}
