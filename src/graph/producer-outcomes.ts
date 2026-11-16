/**
 * The producers' own results, as the run records them (decision 0039, item 11):
 * what a unit answered of its kind — completed, empty, unchanged or abstained,
 * with how many facts and why — is the unit generation's own record, kept in its
 * context when the generation publishes, and the generation's own state and the
 * run's events say why one ended failed. There is no draft set to read back
 * (item 13): the writes went through the one writer, and the record of what they
 * amounted to stands with the unit.
 */
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import type { OrchestratorDatabase } from '../fill/orchestrator-store.js';
import { producerSucceeded, type ProducerOutcomeDraft, type ProducerRunOutcome } from '../fill/producer-outcomes.js';

type OutcomeRow = Record<string, unknown> & { run_id: string; unit_id: string; generation: unknown; scope_key: string; state: string; context: unknown; published: boolean; reason: string | null };

/** The context a generation stores, read as an object: a row that is not one states no outcome. */
function contextOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Reads the outcomes the run's generations recorded; a failed attempt records its own failure, never a private answer. */
export async function readProducerOutcomesIn(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const sql = `SELECT COALESCE($1::text, g.run_id) AS run_id, g.unit_id, g.generation, u.scope_key, g.state, g.context,
       ($1::text IS NOT NULL AND g.run_id <> $1) AS inherited,
       (p.unit_id IS NOT NULL) AS published,
       (SELECT e.summary FROM fill_event e WHERE e.unit_id = g.unit_id AND e.generation = g.generation
         AND e.kind IN ('unit-failed', 'unit-blocked', 'unit-cancelled') ORDER BY e.seq DESC LIMIT 1) AS reason
     FROM fill_unit_generation g JOIN fill_unit u ON u.unit_id = g.unit_id
     JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
     WHERE u.stage_id = 'plugin-turns' AND ($1::text IS NULL OR g.run_id = $1 OR EXISTS (
       SELECT 1 FROM fill_event inherited WHERE inherited.run_id = $1 AND inherited.unit_id = g.unit_id
         AND inherited.generation = g.generation AND inherited.kind = 'unit-inherited'))
       AND ($2::text IS NULL OR g.unit_id = $2) AND ($3::integer IS NULL OR g.generation = $3)
     ORDER BY g.unit_id COLLATE "C", g.generation, g.run_id COLLATE "C"`;
    span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
    const result = await executor.query<OutcomeRow>(sql, [options.runId ?? null, options.unitId ?? null, options.generation ?? null]);
    span.setAttribute('db.rows', result.rows.length);
    return result;
  });
  return found.rows.flatMap((row) => {
    const identity = { runId: row.run_id, unitId: row.unit_id, generation: Number(row.generation) };
    const outcome = contextOf(row.context)['unitOutcome'] as ProducerOutcomeDraft | null | undefined;
    if (row.published) {
      if (outcome === null || outcome === undefined) return [];
      return [{ ...outcome, ...(row.inherited === true && producerSucceeded(outcome.outcome) ? { outcome: 'unchanged' as const } : {}), ...identity }];
    }
    if (!['failed', 'blocked', 'cancelled'].includes(row.state)) return [];
    const cut = row.scope_key.indexOf(':');
    return [{ ...identity, plugin: row.scope_key.slice(0, cut), kind: row.scope_key.slice(cut + 1).split('@')[0]!, outcome: 'failed' as const, produced: 0, reason: row.reason ?? `producer generation ${row.state}` }];
  });
}

export async function readProducerOutcomes(database: OrchestratorDatabase, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  return await database.transaction('snapshot', async (executor) => await readProducerOutcomesIn(executor, options));
}
