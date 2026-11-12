/** A named run's durable projection; trace usage never supplies lifecycle or identity. */
import { type FillStateDatabase, readRun, readRunUnitHistory } from '../fill/state-store.js';
import { readProgress, readRunPlans, readRunPublicationCount, readRunPublicationFacts } from '../fill/orchestrator-store.js';
import type { AgentUsageReport } from '../obs/trace-report.js';

const TERMINAL = new Set(['succeeded', 'completed_partial', 'failed', 'cancelled', 'blocked']);
export async function readFillRunDetail(owner: FillStateDatabase, runId: string, options: { readonly now: number; readonly agentUsage?: AgentUsageReport | null }) {
  const run = await readRun(owner, runId);
  if (run === null) return null;
  const [units, events, plans, publishedUnits, records] = await Promise.all([
    readRunUnitHistory(owner, runId), readProgress(owner, runId), readRunPlans(owner, runId, { history: true }), readRunPublicationCount(owner, runId), readRunPublicationFacts(owner, runId),
  ]);
  const finished = TERMINAL.has(run.state);
  const selected = run.context.selection;
  const groups = (selected?.groups ?? []).map((group) => {
    const ids = new Set(plans.filter((plan) => plan.stageUnitId === group.stageUnitId).map((plan) => `${plan.unitId}@${plan.generation}`));
    const matching = units.filter((unit) => ids.has(`${unit.unitId}@${unit.generation}`));
    return { kind: group.kind, group: group.group, plugin: group.plugin, done: matching.filter((unit) => unit.state === 'published').length, total: matching.length, state: matching.length === 0 ? 'unplanned' : matching.every((unit) => unit.state === 'published') ? 'published' : ['running', 'validating', 'draft', 'leased', 'waiting_children', 'ready', 'planned', 'retry_wait', 'failed', 'blocked', 'cancelled', 'stale', 'superseded'].find((state) => matching.some((unit) => unit.state === state))! };
  });
  const completed = units.filter((unit) => unit.state === 'published').length;
  const elapsedMs = Math.max(0, (finished || run.state === 'paused' ? run.updatedAt : options.now) - run.createdAt);
  // A changing plan is an approximation, not a promised completion time.
  const remainingMs = run.state === 'succeeded' ? 0
    : run.state === 'running' && run.context.planningClosed && completed > 0 && completed < units.length
      ? Math.round(elapsedMs * (units.length - completed) / completed) : null;
  return {
    runId, state: run.state, startedAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString(),
    finishedAt: finished ? new Date(run.updatedAt).toISOString() : null,
    elapsedMs, remainingMs,
    selected: selected?.selected ?? null, order: selected?.order ?? null, vertex: selected?.vertex ?? null, groups,
    units: units.map((unit) => ({ unitId: unit.unitId, stage: unit.stageId, scope: unit.scopeKey, status: unit.state, generation: unit.generation, attempts: unit.context.attempt })),
    events: events.map((event) => ({ seq: event.seq, at: new Date(event.at).toISOString(), stage: event.stage, unitId: event.unitId, type: event.kind, summary: event.summary })),
    records, publishedUnits, agentUsage: options.agentUsage ?? null,
  };
}
