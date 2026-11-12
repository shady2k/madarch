/** Observable producer results, retained in the existing unit generation's draft header. */
import type { SqlExecutor } from '../sql-driver.js';
import type { OrchestratorDatabase } from './orchestrator-store.js';

export type ProducerOutcome = 'completed' | 'unchanged' | 'empty' | 'abstained' | 'failed';
export interface ProducerOutcomeDraft {
  readonly plugin: string;
  readonly kind: string;
  readonly outcome: ProducerOutcome;
  readonly produced: number;
  readonly reason?: string;
  readonly producerVersion?: string;
}
export interface ProducerRunOutcome extends ProducerOutcomeDraft {
  readonly runId: string;
  readonly unitId: string;
  readonly generation: number;
}

export function producerSucceeded(outcome: ProducerOutcome): boolean {
  return outcome === 'completed' || outcome === 'unchanged' || outcome === 'empty';
}

/** Retain plugin generation snapshots for explicit earlier-version reads, never static bulk drafts. */
export function retainedProducerOutcomes(writes: readonly { readonly kind: string; readonly value: unknown }[], facts: number): readonly { readonly kind: string; readonly value: unknown }[] {
  if (!writes.some((write) => write.kind === 'producer-outcome')) return [];
  return writes.filter((write) => ['producer-outcome', 'vertex', 'edge'].includes(write.kind)).map((write) => {
    if (write.kind !== 'producer-outcome') return write;
    const value = write.value as ProducerOutcomeDraft;
    return { kind: write.kind, value: { ...value, outcome: value.outcome === 'completed' && facts === 0 ? 'unchanged' : value.outcome } };
  });
}

type OutcomeRow = Record<string, unknown> & { run_id: string; unit_id: string; generation: unknown; scope_key: string; state: string; writes: unknown; published: boolean; reason: string | null };

/** Reads committed completion metadata; a failed attempt never substitutes its private draft. */
export async function readProducerOutcomesIn(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  const found = await executor.query<OutcomeRow>(
    `SELECT g.run_id, g.unit_id, g.generation, u.scope_key, g.state,
       (SELECT jsonb_agg(w) FROM jsonb_array_elements(d.writes) w WHERE w->>'kind' = 'producer-outcome') AS writes,
       (p.unit_id IS NOT NULL) AS published,
       (SELECT e.summary FROM fill_event e WHERE e.unit_id = g.unit_id AND e.generation = g.generation
         AND e.kind IN ('unit-failed', 'unit-blocked', 'unit-cancelled') ORDER BY e.seq DESC LIMIT 1) AS reason
     FROM fill_unit_generation g JOIN fill_unit u ON u.unit_id = g.unit_id
     LEFT JOIN fill_unit_draft d ON d.unit_id = g.unit_id AND d.generation = g.generation
     LEFT JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
     WHERE u.stage_id = 'plugin-turns' AND ($1::text IS NULL OR g.run_id = $1)
       AND ($2::text IS NULL OR g.unit_id = $2) AND ($3::integer IS NULL OR g.generation = $3)
     ORDER BY g.unit_id COLLATE "C", g.generation, g.run_id COLLATE "C"`,
    [options.runId ?? null, options.unitId ?? null, options.generation ?? null],
  );
  return found.rows.flatMap((row) => {
    const identity = { runId: row.run_id, unitId: row.unit_id, generation: Number(row.generation) };
    if (row.published) {
      const writes = (typeof row.writes === 'string' ? JSON.parse(row.writes) : row.writes) as { kind: string; value: ProducerOutcomeDraft }[] | null;
      return (writes ?? []).filter((write) => write.kind === 'producer-outcome').map((write) => ({ ...write.value, ...identity }));
    }
    if (!['failed', 'blocked', 'cancelled'].includes(row.state)) return [];
    const cut = row.scope_key.indexOf(':');
    return [{ ...identity, plugin: row.scope_key.slice(0, cut), kind: row.scope_key.slice(cut + 1).split('@')[0]!, outcome: 'failed' as const, produced: 0, reason: row.reason ?? `producer generation ${row.state}` }];
  });
}

export async function readProducerOutcomes(database: OrchestratorDatabase, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  return await database.transaction('snapshot', async (executor) => await readProducerOutcomesIn(executor, options));
}
