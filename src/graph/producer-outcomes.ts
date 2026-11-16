import type { SqlExecutor } from '../sql-driver.js';
import type { OrchestratorDatabase } from './fill-orchestration.js';
import { producerSucceeded, type ProducerOutcome, type ProducerRunOutcome } from '../fill/producer-outcomes.js';
import { readKindAssertions } from './records.js';

/** Producer completion is an ordinary unit assertion, never a private draft read. */
export async function readProducerOutcomesIn(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  const units = await readKindAssertions(executor, 'vertex', 'system.unit', ['unit_name', 'generation', 'produced_kind', 'producer', 'outcome', 'produced', 'reason', 'producer_version']);
  const runs = await readKindAssertions(executor, 'vertex', 'system.run', ['run_name']);
  const unitRuns = await readKindAssertions(executor, 'edge', 'system.unit-run', []);
  const inheritedUnits = await readKindAssertions(executor, 'edge', 'system.run-inherited-unit', []);
  const outcomes: ProducerRunOutcome[] = units.flatMap(unit => {
    const values = unit.values;
    if (values['outcome'] === undefined) return [];
    const runEdges = unitRuns.filter(edge => edge.from === unit.id);
    const run = runs.find(candidate => candidate.id === runEdges[0]?.to);
    if (runEdges.length !== 1 || run === undefined) throw new Error(`${import.meta.path}:17: producer unit ${unit.uid} requires exactly one active system.unit-run endpoint`);
    const runId = String(run.values['run_name']);
    const unitId = String(values['unit_name']);
    const generation = Number(values['generation']);
    if ((options.unitId !== undefined && options.unitId !== unitId) || (options.generation !== undefined && options.generation !== generation)) return [];
    const outcome: ProducerRunOutcome = { runId, unitId, generation, plugin: String(values['producer']), kind: String(values['produced_kind']), outcome: values['outcome'] as ProducerOutcome, produced: Number(values['produced']),
      ...(values['reason'] === undefined ? {} : { reason: String(values['reason']) }),
      ...(values['producer_version'] === undefined ? {} : { producerVersion: String(values['producer_version']) }),
    };
    const aliases = inheritedUnits.filter(edge => edge.to === unit.id).map(edge => {
      const inheritingRun = runs.find(candidate => candidate.id === edge.from);
      if (inheritingRun === undefined) throw new Error(`${import.meta.path}:30: inherited producer unit ${unit.uid} has no active run endpoint`);
      return { ...outcome, runId: String(inheritingRun.values['run_name']), ...(producerSucceeded(outcome.outcome) ? { outcome: 'unchanged' as const } : {}) };
    });
    return [outcome, ...aliases].filter(result => options.runId === undefined || result.runId === options.runId);
  });
  return outcomes.sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : a.generation - b.generation || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

export async function readProducerOutcomes(database: OrchestratorDatabase, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  return await database.transaction('snapshot', async (executor) => await readProducerOutcomesIn(executor, options));
}
