import type { SqlExecutor } from '../sql-driver.js';
import type { OrchestratorDatabase } from '../fill/orchestrator-store.js';
import { producerSucceeded, type ProducerOutcomeDraft, type ProducerRunOutcome } from '../fill/producer-outcomes.js';

type OutcomeRow = Record<string, unknown> & { run_id: string; unit_id: string; generation: unknown; scope_key: string; state: string; writes: unknown; published: boolean; reason: string | null };

/** Reads committed completion metadata; a failed attempt never substitutes its private draft. */
export async function readProducerOutcomesIn(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  const found = await executor.query<OutcomeRow>(
    `SELECT COALESCE($1::text, g.run_id) AS run_id, g.unit_id, g.generation, u.scope_key, g.state,
       ($1::text IS NOT NULL AND g.run_id <> $1) AS inherited,
       (SELECT jsonb_agg(w) FROM jsonb_array_elements(d.writes) w WHERE w->>'kind' = 'producer-outcome') AS writes,
       (p.unit_id IS NOT NULL) AS published,
       (SELECT e.summary FROM fill_event e WHERE e.unit_id = g.unit_id AND e.generation = g.generation
         AND e.kind IN ('unit-failed', 'unit-blocked', 'unit-cancelled') ORDER BY e.seq DESC LIMIT 1) AS reason
     FROM fill_unit_generation g JOIN fill_unit u ON u.unit_id = g.unit_id
     LEFT JOIN fill_unit_draft d ON d.unit_id = g.unit_id AND d.generation = g.generation
     LEFT JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
     WHERE u.stage_id = 'plugin-turns' AND ($1::text IS NULL OR g.run_id = $1 OR EXISTS (
       SELECT 1 FROM fill_event inherited WHERE inherited.run_id = $1 AND inherited.unit_id = g.unit_id
         AND inherited.generation = g.generation AND inherited.kind = 'unit-inherited'))
       AND ($2::text IS NULL OR g.unit_id = $2) AND ($3::integer IS NULL OR g.generation = $3)
     ORDER BY g.unit_id COLLATE "C", g.generation, g.run_id COLLATE "C"`,
    [options.runId ?? null, options.unitId ?? null, options.generation ?? null],
  );
  return found.rows.flatMap((row) => {
    const identity = { runId: row.run_id, unitId: row.unit_id, generation: Number(row.generation) };
    if (row.published) {
      const writes = (typeof row.writes === 'string' ? JSON.parse(row.writes) : row.writes) as { kind: string; value: ProducerOutcomeDraft }[] | null;
      return (writes ?? []).filter((write) => write.kind === 'producer-outcome').map((write) => ({ ...write.value, ...(row.inherited === true && producerSucceeded(write.value.outcome) ? { outcome: 'unchanged' as const } : {}), ...identity }));
    }
    if (!['failed', 'blocked', 'cancelled'].includes(row.state)) return [];
    const cut = row.scope_key.indexOf(':');
    return [{ ...identity, plugin: row.scope_key.slice(0, cut), kind: row.scope_key.slice(cut + 1).split('@')[0]!, outcome: 'failed' as const, produced: 0, reason: row.reason ?? `producer generation ${row.state}` }];
  });
}

export async function readProducerOutcomes(database: OrchestratorDatabase, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  return await database.transaction('snapshot', async (executor) => await readProducerOutcomesIn(executor, options));
}
