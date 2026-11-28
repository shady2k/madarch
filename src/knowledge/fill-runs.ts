/** A named run's durable projection; trace usage never supplies lifecycle or identity. */
import { type FillStateSnapshotDatabase, readRun, readRunUnitHistory } from '../graph/fill-state.js';
import { readProgress, readRunEntityCounts, readRunPlans, readRunPublicationCount, readRunPublicationFacts, type RunEntityCounts } from '../graph/fill-orchestration.js';
import { readProducerOutcomes } from '../graph/producer-outcomes.js';
import type { ProducerRunOutcome } from '../fill/producer-outcomes.js';
import type { AgentUsageReport } from '../obs/trace-report.js';
import type { FillRunView } from './model.js';
import { SKIPPED_UNIT_PHASE, type UnitState, isFinalRunPhase, isFinalUnitPhase, runPhaseOf, unitPhaseOf } from '../fill/fsm.js';
import { engineDisplay } from '../server/engine-location.js';


export interface FillRunDetailOptions {
  readonly now: number;
  readonly agentUsage?: AgentUsageReport | null;
  readonly summary?: FillRunView;
  /**
   * Read the run's own detail: what each producer answered, and what the run wrote in entities (madarch-64o5.106). The
   * runs list leaves it out, so a history of many runs spends no read on each one's entities.
   */
  readonly detail?: boolean;
  /**
   * The product the run belongs to, when the reader knows it: a location under it is the product's own, even where the
   * product stands inside the engine checkout (madarch-64o5.200).
   */
  readonly product?: string;
}

export async function readFillRunDetail(owner: FillStateSnapshotDatabase, runId: string, options: FillRunDetailOptions) {
  const run = await readRun(owner, runId);
  if (run === null) return null;
  const [units, events, plans, publishedUnits, records, outcomes, counts] = await Promise.all([
    readRunUnitHistory(owner, runId), readProgress(owner, runId), readRunPlans(owner, runId, { history: true }), readRunPublicationCount(owner, runId), readRunPublicationFacts(owner, runId),
    options.detail === true ? readProducerOutcomes(owner, { runId }) : Promise.resolve([] as readonly ProducerRunOutcome[]),
    options.detail === true ? readRunEntityCounts(owner, runId) : Promise.resolve<RunEntityCounts>({ producers: [], totals: [] }),
  ]);
  // The journal is shown the way the Logs page shows the engine's texts: an event an older engine wrote keeps the place
  // it failed in and loses the file that engine was bundled into. The stored event itself is read, never rewritten.
  const shown = engineDisplay(options.product);
  const phase = runPhaseOf(run.state);
  const finished = isFinalRunPhase(phase);
  const selected = run.context.selection;
  const statePriority: readonly (UnitState | 'superseded')[] = ['running', 'waiting_children', 'ready', 'planned', 'retry_wait', 'failed', 'blocked', 'cancelled', 'stale', 'superseded', 'skipped'];
  const groups = (selected?.groups ?? []).map((group) => {
    const ids = new Set(plans.filter((plan) => plan.stageUnitId === group.stageUnitId).map((plan) => `${plan.unitId}@${plan.generation}`));
    const matching = units.filter((unit) => ids.has(`${unit.unitId}@${unit.generation}`));
    const state = matching.length === 0 ? 'unplanned' : matching.every((unit) => unit.state === 'published') ? 'published' : statePriority.find((held) => matching.some((unit) => unit.state === held))!;
    return { kind: group.kind, group: group.group, plugin: group.plugin, done: matching.filter((unit) => unit.state === 'published').length, total: matching.length, state, phase: state === 'unplanned' ? 'waiting' : state === 'published' ? 'done' : state === 'superseded' ? SKIPPED_UNIT_PHASE : unitPhaseOf(state as import('../fill/fsm.js').UnitState) };
  });
  const completed = units.filter((unit) => unit.state === 'published').length;
  const elapsedMs = Math.max(0, (finished || run.state === 'paused' ? run.updatedAt : options.now) - run.createdAt);
  // A changing plan is an approximation, not a promised completion time.
  const remainingMs = run.state === 'succeeded' ? 0
    : run.state === 'running' && run.context.planningClosed && completed > 0 && completed < units.length
      ? Math.round(elapsedMs * (units.length - completed) / completed) : null;
  return {
    runId, state: run.state, phase, final: finished, startedAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString(),
    finishedAt: finished ? new Date(run.updatedAt).toISOString() : null,
    elapsedMs, remainingMs,
    selected: selected?.selected ?? null,
    order: selected === undefined ? options.summary?.selection?.kinds ?? null : selected.order,
    vertex: selected === undefined ? options.summary?.selection?.vertex ?? null : selected.vertex ?? null,
    groups,
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    units: units.map((unit) => ({ unitId: unit.unitId, stage: unit.stageId, scope: unit.scopeKey, status: unit.state, phase: unitPhaseOf(unit.state), final: isFinalUnitPhase(unitPhaseOf(unit.state)), ...(unit.context.skippedBecause === undefined || unit.context.skippedBecause === null ? {} : { skippedBecause: unit.context.skippedBecause }), generation: unit.generation, attempts: unit.context.attempt })),
    events: events.map((event) => ({ seq: event.seq, at: new Date(event.at).toISOString(), stage: event.stage, unitId: event.unitId, type: event.kind, summary: shown(event.summary) })),
    records, publishedUnits, agentUsage: options.summary?.agentUsage ?? options.agentUsage ?? null,
    ...(options.detail === true ? {
      outcomes: outcomes.map((outcome) => ({ unitId: outcome.unitId, generation: outcome.generation, kind: outcome.kind, plugin: outcome.plugin, outcome: outcome.outcome, produced: outcome.produced, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) })),
      entities: counts.producers,
      entityTotals: counts.totals,
    } : {}),
  };
}
