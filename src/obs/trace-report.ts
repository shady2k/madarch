/**
 * What one run's trace says about its time (madarch-8bdc.2.5, item 2): the wall
 * clock, the span names that took the most time of their own, the spans that
 * grew the process most, the time no span covers, and the slowest single spans.
 *
 * It reads the JSON lines of a trace and nothing else: no store, no database,
 * no second record of the run. `madarch trace` prints this report, and the
 * wiki's run page asks the same function for the same numbers.
 *
 * Self time is a span's own duration less its children's: the time a name is
 * responsible for, summed over the spans of that name. Uncovered time is the
 * wall clock with no span open under the run's own span — a stretch nothing
 * records, which is a defect of the instrumentation, not a fact about the
 * work.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { raise } from '../model/raise.js';
import { traceFiles } from './trace.js';

/** One span as a trace line states it: OTLP's names, times in milliseconds. */
export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly failed: boolean;
}

/** One name's share of the run: how many spans it took, their own time, and what part of the wall clock that is. */
interface NameShare {
  readonly name: string;
  readonly count: number;
  readonly selfMs: number;
  readonly percent: number;
}

/** One span that made the process grow, as its start and end RSS state. */
interface MemoryGrowth {
  readonly name: string;
  readonly spanId: string;
  readonly rssStart: number;
  readonly rssEnd: number;
  readonly growth: number;
}

/** One stretch of the run no leaf span covers. */
interface UncoveredGap {
  readonly atMs: number;
  readonly ms: number;
}

/** The whole answer. */
export interface TraceReport {
  readonly file: string;
  readonly runId: string;
  readonly spanCount: number;
  /** The run's wall clock: the earliest span's start to the last span's end. */
  readonly wallMs: number;
  readonly names: readonly NameShare[];
  readonly memory: readonly MemoryGrowth[];
  /** The time outside every leaf span, and where it is. */
  readonly uncoveredMs: number;
  readonly uncoveredPercent: number;
  readonly gaps: readonly UncoveredGap[];
  readonly slowest: readonly { readonly name: string; readonly spanId: string; readonly ms: number }[];
}

function valueOf(attribute: { readonly value?: Record<string, unknown> }): unknown {
  const value = attribute.value ?? {};
  if ('stringValue' in value) return value['stringValue'];
  if ('intValue' in value) return Number(value['intValue']);
  if ('doubleValue' in value) return value['doubleValue'];
  if ('boolValue' in value) return value['boolValue'];
  if ('arrayValue' in value) return (value['arrayValue'] as { values?: { value?: Record<string, unknown> }[] } | undefined)?.values?.map(valueOf) ?? [];
  return undefined;
}

/** The spans one trace file holds, in the order it wrote them. A line that is not a span is refused by its file and line. */
export function readTraceSpans(file: string): TraceSpan[] {
  const text = readFileSync(file, 'utf8');
  const spans: TraceSpan[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    at += 1;
    if (line.trim() === '') continue;
    let held: Record<string, unknown>;
    try { held = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error(`${file}:${String(at)}: the trace line is not JSON (src/obs/trace-report.ts)`); }
    const attributes: Record<string, unknown> = {};
    for (const attribute of (held['attributes'] as { key?: string; value?: Record<string, unknown> }[] | undefined) ?? []) {
      if (typeof attribute.key === 'string') attributes[attribute.key] = valueOf(attribute);
    }
    const start = Number(held['startTimeUnixNano']);
    const end = Number(held['endTimeUnixNano']);
    if (typeof held['name'] !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`${file}:${String(at)}: the trace line is not an OTLP span (src/obs/trace-report.ts)`);
    spans.push({
      traceId: String(held['traceId'] ?? ''),
      spanId: String(held['spanId'] ?? ''),
      parentSpanId: typeof held['parentSpanId'] === 'string' ? held['parentSpanId'] : undefined,
      name: held['name'],
      start: start / 1_000_000,
      end: end / 1_000_000,
      attributes,
      failed: (held['status'] as { code?: string } | undefined)?.code === 'STATUS_CODE_ERROR',
    });
  }
  return spans;
}

interface Interval { readonly start: number; readonly end: number }

/** The union of intervals, as the stretches it leaves covered. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter((one) => one.end > one.start).sort((left, right) => left.start - right.start);
  const out: Interval[] = [];
  for (const one of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || one.start > last.end) out.push({ start: one.start, end: one.end });
    else out[out.length - 1] = { start: last.start, end: Math.max(last.end, one.end) };
  }
  return out;
}

function coveredMs(intervals: readonly Interval[]): number {
  return union(intervals).reduce((sum, one) => sum + (one.end - one.start), 0);
}

/** What the spans say: the one function the command and the wiki's page both call. */
function traceReportOf(spans: readonly TraceSpan[], file: string): TraceReport {
  const runId = file.split('/').pop()?.replace(/\.jsonl$/u, '') ?? '';
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined || !byId.has(span.parentSpanId)) continue;
    children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  }
  // The wall clock runs from the earliest span of the run to the last: the trace of one run is one window.
  const from = spans.length === 0 ? 0 : Math.min(...spans.map((span) => span.start));
  const to = spans.length === 0 ? 0 : Math.max(...spans.map((span) => span.end));
  const wallMs = Math.max(0, to - from);

  const selfBy = new Map<string, { count: number; selfMs: number }>();
  for (const span of spans) {
    const childMs = coveredMs((children.get(span.spanId) ?? []).map((child) => ({ start: child.start, end: child.end })));
    const selfMs = Math.max(0, span.end - span.start - childMs);
    const held = selfBy.get(span.name) ?? { count: 0, selfMs: 0 };
    selfBy.set(span.name, { count: held.count + 1, selfMs: held.selfMs + selfMs });
  }
  const names = [...selfBy.entries()]
    .map(([name, held]) => ({ name, count: held.count, selfMs: held.selfMs, percent: wallMs === 0 ? 0 : (held.selfMs / wallMs) * 100 }))
    .sort((left, right) => right.selfMs - left.selfMs || (left.name < right.name ? -1 : 1))
    .slice(0, 20);

  const memory = spans
    .map((span) => {
      const start = typeof span.attributes['process.rss.start'] === 'number' ? span.attributes['process.rss.start'] : 0;
      const end = typeof span.attributes['process.rss.end'] === 'number' ? span.attributes['process.rss.end'] : 0;
      return { name: span.name, spanId: span.spanId, rssStart: start, rssEnd: end, growth: end - start };
    })
    .sort((left, right) => right.growth - left.growth || right.rssEnd - left.rssEnd)
    .slice(0, 10);

  // The run's own span covers everything by construction, so it is the one span that does not count as
  // coverage: it is the interval whose inside must be accounted for. Every other span — a phase, a
  // statement, a child process, a library's own operation — covers the time it was open.
  const ids = new Set(spans.map((span) => span.spanId));
  const roots = spans.filter((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId));
  const runSpan = roots.find((span) => roots.every((other) => other === span || (other.start >= span.start && other.end <= span.end)));
  const covering = runSpan === undefined ? spans : spans.filter((span) => span !== runSpan);
  const covered = union(covering.map((span) => ({ start: span.start, end: span.end })));
  const gaps: UncoveredGap[] = [];
  let uncoveredMs = 0;
  if (spans.length > 0) {
    let at = from;
    for (const one of covered) {
      if (one.end <= from || one.start >= to) continue;
      if (one.start > at) gaps.push({ atMs: at - from, ms: one.start - at });
      at = Math.max(at, one.end);
    }
    if (to > at) gaps.push({ atMs: at - from, ms: to - at });
    uncoveredMs = Math.max(0, wallMs - coveredMs(covered));
  }
  gaps.sort((left, right) => right.ms - left.ms);

  const slowest = [...spans]
    .map((span) => ({ name: span.name, spanId: span.spanId, ms: span.end - span.start }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 10);

  return {
    file, runId, spanCount: spans.length, wallMs,
    names, memory,
    uncoveredMs, uncoveredPercent: wallMs === 0 ? 0 : (uncoveredMs / wallMs) * 100,
    gaps: gaps.slice(0, 10),
    slowest,
  };
}

/** One step of a run, as the spans that name it state it. */
interface StepReport {
  readonly step: string;
  /** The step's plan span, when the trace holds one. */
  readonly spanId: string;
  /** The step's wall clock: its first span's start to its last span's end. */
  readonly wallMs: number;
  /** The process's resident memory when the step's highest span ended, and when its first began. */
  readonly peakRssBytes: number;
  readonly startRssBytes: number;
  /** The names that took the most time of their own under the step, the slowest first. */
  readonly slowest: readonly { readonly name: string; readonly count: number; readonly selfMs: number }[];
}

/** How many span names a step's report names as its slowest. */
const STEP_NAMES = 5;

/**
 * The steps of one run, in the order their work started. A span belongs to a
 * step when it says so — the plan's `fill.step` span names `madarch.step`, a
 * unit's `fill.unit` span names `madarch.stage` — and everything under such a
 * span belongs to the same step. A step's wall clock runs from its first span
 * to its last, its peak memory is the highest resident memory of anything it
 * ran, and its slowest names are ranked by the time each took of its own. The
 * numbers are the spans' own: nothing here reads a store or a second record.
 */
function stepReportsOf(spans: readonly TraceSpan[]): StepReport[] {
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined || !spans.some((one) => one.spanId === span.parentSpanId)) continue;
    children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  }
  const stepOf = (span: TraceSpan): string | undefined => {
    const named = span.attributes['madarch.step'] ?? span.attributes['madarch.stage'];
    return typeof named === 'string' && named !== '' ? named : undefined;
  };
  const subtree = (root: TraceSpan): TraceSpan[] => {
    const out: TraceSpan[] = [];
    const seen = new Set<string>();
    const walk = (span: TraceSpan): void => {
      if (seen.has(span.spanId)) return;
      seen.add(span.spanId);
      out.push(span);
      for (const child of children.get(span.spanId) ?? []) walk(child);
    };
    walk(root);
    return out;
  };
  // One entry per step, in the order the trace first names it.
  const steps = new Map<string, { spans: TraceSpan[]; plan: TraceSpan | undefined }>();
  for (const span of spans) {
    const step = stepOf(span);
    if (step === undefined) continue;
    const held = steps.get(step) ?? { spans: [], plan: undefined };
    for (const one of subtree(span)) if (!held.spans.includes(one)) held.spans.push(one);
    if (span.name === 'fill.step' && held.plan === undefined) held.plan = span;
    steps.set(step, held);
  }
  const reports: StepReport[] = [];
  for (const [step, held] of steps) {
    const selfBy = new Map<string, { count: number; selfMs: number }>();
    for (const one of held.spans) {
      const childMs = coveredMs((children.get(one.spanId) ?? []).map((child) => ({ start: child.start, end: child.end })));
      const selfMs = Math.max(0, one.end - one.start - childMs);
      const known = selfBy.get(one.name) ?? { count: 0, selfMs: 0 };
      selfBy.set(one.name, { count: known.count + 1, selfMs: known.selfMs + selfMs });
    }
    const slowest = [...selfBy.entries()]
      .map(([name, known]) => ({ name, count: known.count, selfMs: known.selfMs }))
      .sort((left, right) => right.selfMs - left.selfMs || (left.name < right.name ? -1 : 1))
      .slice(0, STEP_NAMES);
    const start = Math.min(...held.spans.map((one) => one.start));
    const end = Math.max(...held.spans.map((one) => one.end));
    // A span states the highest resident memory of its own window (`process.rss.peak`, sampled while
    // it ran), so the step's peak is the highest of its spans'. A trace written before the spans
    // sampled falls back to the readings at their ends, which is the smaller number and is said so.
    const peaks = held.spans.map((one) => (typeof one.attributes['process.rss.peak'] === 'number' ? one.attributes['process.rss.peak'] as number : 0));
    const ends = held.spans.map((one) => (typeof one.attributes['process.rss.end'] === 'number' ? one.attributes['process.rss.end'] : 0));
    const rss = peaks.some((one) => one > 0) ? peaks : ends;
    const first = held.spans.find((one) => one.start === start);
    const startRss = typeof first?.attributes['process.rss.start'] === 'number' ? first.attributes['process.rss.start'] as number : 0;
    reports.push({
      step,
      spanId: held.plan?.spanId ?? '',
      wallMs: Math.max(0, end - start),
      peakRssBytes: Math.max(startRss, ...rss),
      startRssBytes: startRss,
      slowest,
    });
  }
  const startOf = new Map(reports.map((report) => [report.step, Math.min(...(steps.get(report.step)?.spans ?? []).map((one) => one.start))]));
  return reports.sort((left, right) => (startOf.get(left.step) ?? 0) - (startOf.get(right.step) ?? 0) || (left.step < right.step ? -1 : left.step > right.step ? 1 : 0));
}

/** How a run id becomes a trace file name: every character a path would read as a separator is one dash. */
function traceFileNameOf(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/gu, '-')}.jsonl`;
}

/** One run's trace as the run page and the report read it: the spans' report and their steps, from one read of the file. */
export interface TraceRunReport {
  readonly file: string;
  readonly runId: string;
  readonly report: TraceReport;
  readonly steps: readonly StepReport[];
  /** When the run's first span started and its last ended, in epoch milliseconds. */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

/** One run of a store's trace: the named run, or the newest. The file is read once for both reports. */
export function readTraceRun(options: { readonly store: string; readonly runId?: string }): TraceRunReport {
  const files = traceFiles(options.store);
  if (files.length === 0) raise(`the store holds no trace: its traces are one JSON lines file per run in ${join(options.store, 'traces')}, and a fill writes one`);
  const chosen = options.runId === undefined ? files[0]! : files.find((one) => one.runId === options.runId || one.file.endsWith(`/${traceFileNameOf(options.runId!)}`));
  if (chosen === undefined) raise(`the store holds no trace of run ${JSON.stringify(options.runId)}; its runs are ${files.map((one) => JSON.stringify(one.runId)).join(', ')}`);
  const spans = readTraceSpans(chosen.file);
  const startedAt = spans.length === 0 ? 0 : Math.min(...spans.map((span) => span.start));
  const endedAt = spans.length === 0 ? 0 : Math.max(...spans.map((span) => span.end));
  return {
    file: chosen.file,
    runId: chosen.runId,
    report: traceReportOf(spans, chosen.file),
    steps: stepReportsOf(spans),
    startedAtMs: startedAt,
    endedAtMs: endedAt,
  };
}

/** The report of one store's trace: `--run` names it, and the newest one is read when it does not. */
export function readTraceReport(options: { readonly store: string; readonly runId?: string }): TraceReport {
  const files = traceFiles(options.store);
  if (files.length === 0) throw new Error(`${join(options.store, 'traces')}:1: the store holds no trace; its traces are one JSON lines file per run there, and one is written by a fill (src/obs/trace-report.ts)`);
  const chosen = options.runId === undefined ? files[0]! : files.find((one) => one.runId === options.runId || one.file.endsWith(`/${traceFileNameOf(options.runId!)}`));
  if (chosen === undefined) throw new Error(`${join(options.store, 'traces')}:1: the store holds no trace of run ${JSON.stringify(options.runId)}; its runs are ${files.map((one) => JSON.stringify(one.runId)).join(', ')} (src/obs/trace-report.ts)`);
  return traceReportOf(readTraceSpans(chosen.file), chosen.file);
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The report in plain words, as `madarch trace` prints it. */
export function renderTraceReport(report: TraceReport): string {
  const lines: string[] = [];
  lines.push(`Trace: ${report.file}`);
  lines.push(`Run ${report.runId}: ${ms(report.wallMs)} wall clock over ${String(report.spanCount)} spans`);
  lines.push('');
  lines.push('The names that took the most time of their own (self time; children counted under their own names):');
  for (const name of report.names) lines.push(`  ${ms(name.selfMs).padStart(11)}  ${name.percent.toFixed(1).padStart(5)}%  ${String(name.count).padStart(6)}x  ${name.name}`);
  lines.push('');
  lines.push('The spans that made the process grow the most (resident memory, start to end):');
  for (const held of report.memory) lines.push(`  ${`${held.growth >= 0 ? '+' : ''}${mb(held.growth)}`.padStart(12)}  ${mb(held.rssStart)} → ${mb(held.rssEnd)}  ${held.name}`);
  lines.push('');
  lines.push(`Time no span covers: ${ms(report.uncoveredMs)} (${report.uncoveredPercent.toFixed(1)}% of the wall clock)`);
  for (const gap of report.gaps) lines.push(`  ${ms(gap.ms).padStart(11)} at ${ms(gap.atMs)} into the run`);
  lines.push('');
  lines.push('The slowest single spans:');
  for (const held of report.slowest) lines.push(`  ${ms(held.ms).padStart(11)}  ${held.name}  (${held.spanId})`);
  return `${lines.join('\n')}\n`;
}
