import type { SqlExecutor } from '../sql-driver.js';
import type { FillStateSnapshotDatabase } from './fill-state.js';
import { producerSucceeded, type ProducerOutcome, type ProducerRunOutcome } from '../fill/producer-outcomes.js';
import { edgeRowsIn, readNodeIdIn, readRecordsIn, readRunGraphUidIn, readSubjectsByValueIn, readUnitsIn } from './fill-state.js';
import type { AssertionRecord } from './records.js';

/** The units a request is about: the run's own, the named unit's, or — for no subject — every unit. */
async function producerUnits(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<AssertionRecord[]> {
  if (options.runId !== undefined) {
    const uid = await readRunGraphUidIn(executor, options.runId);
    if (uid === undefined) return [];
    const run = await readNodeIdIn(executor, uid);
    if (run === undefined) return [];
    // The run's own units and the published units it inherited: both answer for this run.
    const ids = [...(await edgeRowsIn(executor, 'system.unit-run', 'to', [run])).map((edge) => edge.from),
      ...(await edgeRowsIn(executor, 'system.run-inherited-unit', 'from', [run])).map((edge) => edge.to)];
    return await readUnitsIn(executor, [...new Set(ids)]);
  }
  if (options.unitId !== undefined) {
    const subjects = await readSubjectsByValueIn(executor, 'system.unit', 'unit_name', options.unitId);
    const units = await readUnitsIn(executor, subjects.map((subject) => subject.id));
    return units.filter((unit) => options.generation === undefined || unit.values['generation'] === options.generation);
  }
  // No subject is named: every unit is what the request is about.
  return await readUnitsIn(executor);
}

/** Producer completion is an ordinary unit assertion, never a private draft read. */
export async function readProducerOutcomesIn(executor: SqlExecutor, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  const units = (await producerUnits(executor, options)).filter((unit) => unit.values.outcome !== undefined);
  if (units.length === 0) return [];
  // Each unit's run is its own edge, and the units it was inherited into are its own incoming edges.
  const links = await edgeRowsIn(executor, 'system.unit-run', 'from', units.map((unit) => unit.id));
  const runs = new Map((await readRecordsIn(executor, 'vertex', 'system.run', ['run_name'], links.map((link) => link.to))).map((run) => [run.id, run]));
  const inherited = await edgeRowsIn(executor, 'system.run-inherited-unit', 'to', units.map((unit) => unit.id));
  const inheriting = new Map((await readRecordsIn(executor, 'vertex', 'system.run', ['run_name'], inherited.map((link) => link.from))).map((run) => [run.id, run]));
  const outcomes: ProducerRunOutcome[] = units.flatMap(unit => {
    const values = unit.values;
    const runEdges = links.filter(edge => edge.from === unit.id);
    const run = runEdges.length === 1 ? runs.get(runEdges[0]!.to) : undefined;
    if (runEdges.length !== 1 || run === undefined) throw new Error(`${import.meta.path}:17: producer unit ${unit.uid} requires exactly one active system.unit-run endpoint`);
    const runId = String(run.values['run_name']);
    const unitId = String(values['unit_name']);
    const generation = Number(values['generation']);
    if (options.unitId !== undefined && options.unitId !== unitId) return [];
    if (options.generation !== undefined && options.generation !== generation) return [];
    const outcome: ProducerRunOutcome = { runId, unitId, generation, plugin: String(values['producer']), kind: String(values['produced_kind']), outcome: values.outcome as ProducerOutcome, produced: Number(values['produced']),
      ...(values['reason'] === undefined ? {} : { reason: String(values['reason']) }),
      ...(values['producer_version'] === undefined ? {} : { producerVersion: String(values['producer_version']) }),
    };
    const aliases = inherited.filter(edge => edge.to === unit.id).map(edge => {
      const inheritingRun = inheriting.get(edge.from);
      if (inheritingRun === undefined) throw new Error(`${import.meta.path}:30: inherited producer unit ${unit.uid} has no active run endpoint`);
      return { ...outcome, runId: String(inheritingRun.values['run_name']), ...(producerSucceeded(outcome.outcome) ? { outcome: 'unchanged' as const } : {}) };
    });
    return [outcome, ...aliases].filter(result => options.runId === undefined || result.runId === options.runId);
  });
  return outcomes.sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : a.generation - b.generation || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

export async function readProducerOutcomes(database: FillStateSnapshotDatabase, options: { readonly runId?: string; readonly unitId?: string; readonly generation?: number }): Promise<ProducerRunOutcome[]> {
  return await database.transaction('snapshot', async (executor) => await readProducerOutcomesIn(executor, options));
}
