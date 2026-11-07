/**
 * What a fill has done so far, read from its trace (madarch-8bdc.2.5, item 1):
 * the units each step planned and each stage published, failed or blocked, the
 * last thing the run did, and the last pass of the scheduler.
 *
 * This is what the MCP server's "graph building" answer says: the trace is the
 * one record, and this reads it as it is written rather than keeping a second
 * count beside it.
 */
import { readTraceSpans, type TraceSpan } from './trace-report.js';
import { traceFiles } from './trace.js';

/** What one stage has done so far. */
interface StageProgress {
  readonly planned: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
}

/** One scheduler pass, as its span states it. */
interface PassProgress {
  readonly pass: number;
  readonly units: number;
  readonly ms: number;
  readonly phases: Readonly<Record<string, number>>;
}

/** The fill's state as its trace tells it. */
export interface FillProgress {
  readonly planned: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
  readonly stages: Readonly<Record<string, StageProgress>>;
  readonly last: string | null;
  readonly pass: PassProgress | null;
}

function textOf(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function numberOf(span: TraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

/** The progress the spans state: one pass over them, in the order the trace wrote them. */
function fillProgressOf(spans: readonly TraceSpan[]): FillProgress {
  const stages = new Map<string, { planned: number; published: number; failed: number; blocked: number }>();
  const plannedByStep = new Map<string, number>();
  let published = 0;
  let failed = 0;
  let blocked = 0;
  let last: string | null = null;
  let pass: PassProgress | null = null;
  const stageOf = (stage: string) => {
    const held = stages.get(stage) ?? { planned: 0, published: 0, failed: 0, blocked: 0 };
    stages.set(stage, held);
    return held;
  };
  for (const span of spans) {
    if (span.name === 'fill.step') {
      const step = textOf(span, 'madarch.step');
      const units = numberOf(span, 'madarch.units');
      if (step !== undefined && units !== undefined) plannedByStep.set(step, Math.max(plannedByStep.get(step) ?? 0, units));
    }
    if (span.name === 'fill.unit') {
      const stage = textOf(span, 'madarch.stage') ?? '';
      const outcome = textOf(span, 'madarch.outcome') ?? 'none';
      const held = stageOf(stage);
      if (outcome === 'published' || outcome === 'replayed') { held.published += 1; published += 1; }
      if (outcome === 'failed') { held.failed += 1; failed += 1; }
      if (outcome === 'blocked') { held.blocked += 1; blocked += 1; }
      last = `${span.name} ${textOf(span, 'madarch.unit') ?? ''} (${outcome})`;
    }
    if (span.name === 'scheduler.pass') {
      const phases: Record<string, number> = {};
      for (const [key, value] of Object.entries(span.attributes)) {
        if (key.startsWith('madarch.phase.') && typeof value === 'number') phases[key.slice('madarch.phase.'.length)] = value;
      }
      pass = {
        pass: numberOf(span, 'madarch.pass') ?? 0,
        units: numberOf(span, 'madarch.units') ?? 0,
        ms: span.end - span.start,
        phases,
      };
      last = `scheduler pass ${String(pass.pass)} on ${String(pass.units)} units took ${(pass.ms / 1000).toFixed(1)}s`;
    }
  }
  for (const [step, units] of plannedByStep) stageOf(step).planned = units;
  const held: Record<string, StageProgress> = {};
  for (const [stage, progress] of [...stages].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) held[stage] = { ...progress };
  return { planned: [...plannedByStep.values()].reduce((sum, units) => sum + units, 0), published, failed, blocked, stages: held, last, pass };
}

/** The progress of one trace file. */
export function readFillProgress(file: string): FillProgress {
  return fillProgressOf(readTraceSpans(file));
}

/**
 * The progress of the newest trace in a store: a store a fill is writing into
 * holds the run's trace from its start, so a reader between two spans still
 * sees what the run has done.
 */
export function readLatestFillProgress(store: string): FillProgress {
  const files = traceFiles(store);
  if (files.length === 0) return { planned: 0, published: 0, failed: 0, blocked: 0, stages: {}, last: null, pass: null };
  return readFillProgress(files[0]!.file);
}

