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
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { raise } from '../model/raise.js';
import { traceFiles, withSpanSync } from './trace.js';

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

/** One kind, field and model as the run's `agent.usage` spans state it, summed over the turns that spent on it. */
export interface AgentUsageLine {
  readonly kind: string;
  readonly field: string;
  /** The model the adapter named; `''` when it named none. */
  readonly model: string;
  readonly plugin: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The tokens the agent reported for the line: the largest of its total and the sum of its parts. */
  readonly totalTokens: number;
  readonly cost: readonly { readonly currency: string; readonly amount: number }[];
  /** How many prompt turns the line took. */
  readonly turns: number;
  /** The bound that ended this line's run, and which declaration it was. */
  readonly stopped: { readonly bound: 'tokens' | 'cost'; readonly scope: 'plugin' | 'run' } | null;
}

/** What the run's model calls cost, as its `agent.usage` spans state it (madarch-stm0.4, decision 0035, item 22). */
export interface AgentUsageReport {
  readonly lines: readonly AgentUsageLine[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: readonly { readonly currency: string; readonly amount: number }[];
  readonly turns: number;
  /** The bounds the run crossed, in the order the spans were written. */
  readonly stops: readonly { readonly kind: string; readonly field: string; readonly model: string; readonly bound: 'tokens' | 'cost'; readonly scope: 'plugin' | 'run' }[];
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
  /** What the run's model calls cost, per kind, field and model; empty for a run that made none (madarch-stm0.4). */
  readonly agentUsage: AgentUsageReport;
}

/** One number a span states, or 0 when it states none. */
function spanNumber(attributes: Readonly<Record<string, unknown>>, name: string): number {
  const held = attributes[name];
  return typeof held === 'number' && Number.isFinite(held) ? held : 0;
}

/**
 * The run's model calls as its `agent.usage` spans state them (madarch-stm0.4): each span carries one turn's increment,
 * never a cumulative total, so the report adds the spans and never a store. A line is one kind, field and model; the
 * tokens are the largest of the span's total and the sum of its parts, the same reading the meter bounds by.
 */
export function agentUsageOf(spans: readonly TraceSpan[]): AgentUsageReport {
  interface Held { kind: string; field: string; model: string; plugin: string; input: number; output: number; total: number; cost: Map<string, number>; turns: number; stopped: AgentUsageLine['stopped'] }
  const lines = new Map<string, Held>();
  const stops: { kind: string; field: string; model: string; bound: 'tokens' | 'cost'; scope: 'plugin' | 'run' }[] = [];
  for (const span of spans) {
    if (span.name !== 'agent.usage') continue;
    const kind = typeof span.attributes['agent.kind'] === 'string' ? span.attributes['agent.kind'] : '';
    const field = typeof span.attributes['agent.field'] === 'string' ? span.attributes['agent.field'] : '';
    const model = typeof span.attributes['agent.model'] === 'string' ? span.attributes['agent.model'] : '';
    const plugin = typeof span.attributes['agent.plugin'] === 'string' ? span.attributes['agent.plugin'] : '';
    const key = `${kind}\u0000${field}\u0000${model}`;
    const held = lines.get(key) ?? { kind, field, model, plugin, input: 0, output: 0, total: 0, cost: new Map<string, number>(), turns: 0, stopped: null };
    const input = spanNumber(span.attributes, 'agent.tokens.input');
    const output = spanNumber(span.attributes, 'agent.tokens.output');
    held.input += input;
    held.output += output;
    held.total += Math.max(spanNumber(span.attributes, 'agent.tokens.total'), input + output);
    held.turns += 1;
    for (const [name, value] of Object.entries(span.attributes)) {
      if (!name.startsWith('agent.cost.') || typeof value !== 'number') continue;
      const currency = name.slice('agent.cost.'.length);
      held.cost.set(currency, (held.cost.get(currency) ?? 0) + value);
    }
    const bound = span.attributes['agent.bound.stop'];
    const scope = span.attributes['agent.bound.scope'];
    if ((bound === 'tokens' || bound === 'cost') && (scope === 'plugin' || scope === 'run')) {
      held.stopped = { bound, scope };
      stops.push({ kind, field, model, bound, scope });
    }
    lines.set(key, held);
  }
  const ordered = [...lines.values()].sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
    || (left.field < right.field ? -1 : left.field > right.field ? 1 : 0)
    || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
  const money = (held: readonly Held[]): { currency: string; amount: number }[] => {
    const byCurrency = new Map<string, number>();
    for (const line of held) for (const [currency, amount] of line.cost) byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
    return [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount: Number(amount.toFixed(6)) })).sort((left, right) => (left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0));
  };
  return {
    lines: ordered.map((line) => ({
      kind: line.kind, field: line.field, model: line.model, plugin: line.plugin,
      inputTokens: line.input, outputTokens: line.output, totalTokens: line.total,
      cost: money([line]), turns: line.turns, stopped: line.stopped,
    })),
    inputTokens: ordered.reduce((sum, line) => sum + line.input, 0),
    outputTokens: ordered.reduce((sum, line) => sum + line.output, 0),
    totalTokens: ordered.reduce((sum, line) => sum + line.total, 0),
    cost: money(ordered),
    turns: ordered.reduce((sum, line) => sum + line.turns, 0),
    stops,
  };
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
  return parseTraceSpans(readFileSync(file, 'utf8'), file);
}

function parseTraceSpans(text: string, file: string, line = 0): TraceSpan[] {
  const spans: TraceSpan[] = [];
  let at = line;
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

/** A live trace is append-only. Keep its parsed prefix, not another record of the run's counters. */
export class TraceSpanReader {
  private held: { file: string; dev: number; ino: number; size: number; mtime: number; offset: number; lines: number; spans: TraceSpan[] } | undefined;

  read(file: string): TraceSpan[] {
    const fd = openSync(file, 'r');
    try {
      const stat = fstatSync(fd);
      const previous = this.held;
      const held = previous !== undefined && previous.file === file && previous.dev === stat.dev && previous.ino === stat.ino
        && stat.size >= previous.size && (stat.size !== previous.size || stat.mtimeMs === previous.mtime)
        ? previous : { file, dev: stat.dev, ino: stat.ino, size: 0, mtime: 0, offset: 0, lines: 0, spans: [] };
      const bytes = Buffer.alloc(stat.size - held.offset);
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, held.offset + read);
        if (count === 0) break;
        read += count;
      }
      const content = bytes.subarray(0, read);
      const end = content.lastIndexOf(10) + 1;
      const text = content.subarray(0, end).toString('utf8');
      const added = parseTraceSpans(text, file, held.lines);
      // Leave the unterminated suffix unread until its writer completes the line.
      held.spans.push(...added);
      held.offset += end;
      held.lines += text.split('\n').length - 1;
      held.size = stat.size;
      held.mtime = stat.mtimeMs;
      this.held = held;
      const tail = content.subarray(end).toString('utf8');
      if (tail.trim() === '') return held.spans;
      // A complete record need not have its newline yet. An incomplete append is retried next time.
      try { JSON.parse(tail); } catch { return held.spans; }
      return [...held.spans, ...parseTraceSpans(tail, file, held.lines)];
    } finally {
      closeSync(fd);
    }
  }
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

/** The first ten under the same stable order as a full sort, without retaining a result per span. */
function topSpans(spans: readonly TraceSpan[], compare: (left: TraceSpan, right: TraceSpan) => number): TraceSpan[] {
  const top: TraceSpan[] = [];
  for (const span of spans) {
    let at = top.length;
    while (at > 0 && compare(span, top[at - 1]!) < 0) at -= 1;
    if (at >= 10) continue;
    top.splice(at, 0, span);
    if (top.length > 10) top.pop();
  }
  return top;
}

function rssOf(span: TraceSpan, boundary: 'start' | 'end'): number {
  const value = span.attributes[boundary === 'start' ? 'process.rss.start' : 'process.rss.end'];
  return typeof value === 'number' ? value : 0;
}

interface SpanIndex {
  readonly byId: ReadonlyMap<string, TraceSpan>;
  readonly childMs: ReadonlyMap<string, number>;
}

function indexSpans(spans: readonly TraceSpan[]): SpanIndex {
  const byId = new Map<string, TraceSpan>();
  for (const span of spans) byId.set(span.spanId, span);
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined || !byId.has(span.parentSpanId)) continue;
    const held = children.get(span.parentSpanId) ?? [];
    held.push(span);
    children.set(span.parentSpanId, held);
  }
  const childMs = new Map<string, number>();
  for (const [spanId, spans] of children) childMs.set(spanId, coveredMs(spans));
  return { byId, childMs };
}

export type TraceSummary = Pick<TraceReport, 'spanCount' | 'wallMs' | 'names' | 'agentUsage'>;

/** The live run's projection shares the detailed report's self-time calculation without its diagnostics. */
export function traceSummaryOf(spans: readonly TraceSpan[], index = indexSpans(spans)): TraceSummary {
  const { childMs } = index;
  // The wall clock runs from the earliest span of the run to the last: the trace of one run is one window.
  const from = spans.length === 0 ? 0 : spans.reduce((first, span) => Math.min(first, span.start), Number.POSITIVE_INFINITY);
  const to = spans.length === 0 ? 0 : spans.reduce((last, span) => Math.max(last, span.end), Number.NEGATIVE_INFINITY);
  const wallMs = Math.max(0, to - from);

  const selfBy = new Map<string, { count: number; selfMs: number }>();
  for (const span of spans) {
    const selfMs = Math.max(0, span.end - span.start - (childMs.get(span.spanId) ?? 0));
    const held = selfBy.get(span.name) ?? { count: 0, selfMs: 0 };
    selfBy.set(span.name, { count: held.count + 1, selfMs: held.selfMs + selfMs });
  }
  const names = [...selfBy.entries()]
    .map(([name, held]) => ({ name, count: held.count, selfMs: held.selfMs, percent: wallMs === 0 ? 0 : (held.selfMs / wallMs) * 100 }))
    .sort((left, right) => right.selfMs - left.selfMs || (left.name < right.name ? -1 : 1))
    .slice(0, 20);

  return { spanCount: spans.length, wallMs, names, agentUsage: agentUsageOf(spans) };
}

/** What the spans say: the one function the command and the wiki's page both call. */
export function traceReportOf(spans: readonly TraceSpan[], file: string): TraceReport {
  return traceReportFrom(spans, file, indexSpans(spans));
}

function traceReportFrom(spans: readonly TraceSpan[], file: string, index: SpanIndex): TraceReport {
  const runId = file.split('/').pop()?.replace(/\.jsonl$/u, '') ?? '';
  const { byId } = index;
  const summary = traceSummaryOf(spans, index);
  const { wallMs, names } = summary;
  const from = spans.length === 0 ? 0 : spans.reduce((first, span) => Math.min(first, span.start), Number.POSITIVE_INFINITY);
  const to = spans.length === 0 ? 0 : spans.reduce((last, span) => Math.max(last, span.end), Number.NEGATIVE_INFINITY);

  const memory = topSpans(spans, (left, right) =>
    (rssOf(right, 'end') - rssOf(right, 'start')) - (rssOf(left, 'end') - rssOf(left, 'start')) || rssOf(right, 'end') - rssOf(left, 'end'))
    .map((span) => {
      const start = rssOf(span, 'start');
      const end = rssOf(span, 'end');
      return { name: span.name, spanId: span.spanId, rssStart: start, rssEnd: end, growth: end - start };
    });

  // The run's own span covers everything by construction, so it is the one span that does not count as
  // coverage: it is the interval whose inside must be accounted for. Every other span — a phase, a
  // statement, a child process, a library's own operation — covers the time it was open.
  const roots = spans.filter((span) => span.parentSpanId === undefined || !byId.has(span.parentSpanId));
  const rootStart = roots.reduce((first, span) => Math.min(first, span.start), Number.POSITIVE_INFINITY);
  const rootEnd = roots.reduce((last, span) => Math.max(last, span.end), Number.NEGATIVE_INFINITY);
  const runSpan = roots.find((span) => span.start === rootStart && span.end === rootEnd);
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

  const slowest = topSpans(spans, (left, right) => (right.end - right.start) - (left.end - left.start))
    .map((span) => ({ name: span.name, spanId: span.spanId, ms: span.end - span.start }));

  return {
    file, runId, spanCount: spans.length, wallMs,
    names, memory,
    uncoveredMs, uncoveredPercent: wallMs === 0 ? 0 : (uncoveredMs / wallMs) * 100,
    gaps: gaps.slice(0, 10),
    slowest,
    agentUsage: summary.agentUsage,
  };
}

/** One step of a run, as the spans that name it state it. */
export interface StepReport {
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
export function stepReportsOf(spans: readonly TraceSpan[], index: SpanIndex = indexSpans(spans)): StepReport[] {
  const { byId, childMs } = index;
  const namedStep = (span: TraceSpan): string | undefined => {
    const named = span.attributes['madarch.step'] ?? span.attributes['madarch.stage'];
    return typeof named === 'string' && named !== '' ? named : undefined;
  };
  // A span belongs to the nearest step on its own branch: one walk up the parents per span, cached per span.
  const stepOfSpan = new Map<string, string | undefined>();
  const stepFor = (span: TraceSpan): string | undefined => {
    const held = stepOfSpan.get(span.spanId);
    if (held !== undefined || stepOfSpan.has(span.spanId)) return held;
    const own = namedStep(span);
    if (own !== undefined) { stepOfSpan.set(span.spanId, own); return own; }
    const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    const answer = parent === undefined ? undefined : stepFor(parent);
    stepOfSpan.set(span.spanId, answer);
    return answer;
  };
  // One entry per step, in the order the trace first names it.
  const steps = new Map<string, { spans: TraceSpan[]; plan: TraceSpan | undefined }>();
  for (const span of spans) {
    const step = stepFor(span);
    if (step === undefined) continue;
    const held = steps.get(step) ?? { spans: [], plan: undefined };
    held.spans.push(span);
    if (span.name === 'fill.step' && held.plan === undefined) held.plan = span;
    steps.set(step, held);
  }
  const reports: StepReport[] = [];
  for (const [step, held] of steps) {
    const selfBy = new Map<string, { count: number; selfMs: number }>();
    for (const one of held.spans) {
      const selfMs = Math.max(0, one.end - one.start - (childMs.get(one.spanId) ?? 0));
      const known = selfBy.get(one.name) ?? { count: 0, selfMs: 0 };
      selfBy.set(one.name, { count: known.count + 1, selfMs: known.selfMs + selfMs });
    }
    const slowest = [...selfBy.entries()]
      .map(([name, known]) => ({ name, count: known.count, selfMs: known.selfMs }))
      .sort((left, right) => right.selfMs - left.selfMs || (left.name < right.name ? -1 : 1))
      .slice(0, STEP_NAMES);
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    const peaks: number[] = [];
    const ends: number[] = [];
    for (const one of held.spans) {
      start = Math.min(start, one.start);
      end = Math.max(end, one.end);
      peaks.push(typeof one.attributes['process.rss.peak'] === 'number' ? one.attributes['process.rss.peak'] as number : 0);
      ends.push(typeof one.attributes['process.rss.end'] === 'number' ? one.attributes['process.rss.end'] : 0);
    }
    const rss = peaks.some((one) => one > 0) ? peaks : ends;
    const first = held.spans.find((one) => one.start === start);
    const startRss = typeof first?.attributes['process.rss.start'] === 'number' ? first.attributes['process.rss.start'] as number : 0;
    reports.push({
      step,
      spanId: held.plan?.spanId ?? '',
      wallMs: Math.max(0, end - start),
      peakRssBytes: rss.reduce((highest, one) => Math.max(highest, one), startRss),
      startRssBytes: startRss,
      slowest,
    });
  }
  const startOf = new Map(reports.map((report) => [report.step, (steps.get(report.step)?.spans ?? []).reduce((first, one) => Math.min(first, one.start), Number.POSITIVE_INFINITY)]));
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
export function readTraceRun(options: { readonly store: string; readonly runId?: string }, reader?: TraceSpanReader): TraceRunReport {
  return readRun(options, reader, traceReportFrom);
}

/** The exact report fields the live run page consumes; the detailed CLI diagnostics are not collected. */
export function readTraceRunSummary(options: { readonly store: string; readonly runId?: string }, reader?: TraceSpanReader): Omit<TraceRunReport, 'report'> & { report: TraceSummary } {
  return readRun(options, reader, (spans, _file, index) => traceSummaryOf(spans, index));
}

function readRun<T>(options: { readonly store: string; readonly runId?: string }, reader: TraceSpanReader | undefined, report: (spans: readonly TraceSpan[], file: string, index: SpanIndex) => T): Omit<TraceRunReport, 'report'> & { report: T } {
  const files = traceFiles(options.store);
  if (files.length === 0) raise(`the store holds no trace: its traces are one JSON lines file per run in ${join(options.store, 'traces')}, and a fill writes one`);
  const chosen = options.runId === undefined ? files[0]! : files.find((one) => one.runId === options.runId || one.file.endsWith(`/${traceFileNameOf(options.runId!)}`));
  if (chosen === undefined) raise(`the store holds no trace of run ${JSON.stringify(options.runId)}; its runs are ${files.map((one) => JSON.stringify(one.runId)).join(', ')}`);
  const spans = withSpanSync('trace.read', {}, () => reader === undefined ? readTraceSpans(chosen.file) : reader.read(chosen.file));
  const index = withSpanSync('trace.index', {}, () => indexSpans(spans));
  const startedAt = spans.length === 0 ? 0 : spans.reduce((first, span) => Math.min(first, span.start), Number.POSITIVE_INFINITY);
  const endedAt = spans.length === 0 ? 0 : spans.reduce((last, span) => Math.max(last, span.end), Number.NEGATIVE_INFINITY);
  return {
    file: chosen.file,
    runId: chosen.runId,
    report: withSpanSync('trace.report', {}, () => report(spans, chosen.file, index)),
    steps: withSpanSync('trace.steps', {}, () => stepReportsOf(spans, index)),
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
  if (report.agentUsage.lines.length > 0) {
    const usage = report.agentUsage;
    lines.push('');
    lines.push(`Agent usage: ${String(usage.turns)} prompt turns, ${String(usage.inputTokens)} tokens in, ${String(usage.outputTokens)} out, ${String(usage.totalTokens)} total${usage.cost.length === 0 ? '' : `, cost ${usage.cost.map((one) => `${String(one.amount)} ${one.currency}`).join(', ')}`}`);
    for (const line of usage.lines) {
      const where = `${line.plugin} ${line.kind}${line.field === '' ? '' : `/${line.field}`}${line.model === '' ? '' : ` on ${line.model}`}`;
      lines.push(`  ${String(line.inputTokens).padStart(9)} in  ${String(line.outputTokens).padStart(9)} out  ${String(line.totalTokens).padStart(9)} total${line.cost.length === 0 ? '' : `  ${line.cost.map((one) => `${String(one.amount)} ${one.currency}`).join(', ')}`}  ${where}${line.stopped === null ? '' : `  [stopped: ${line.stopped.bound}, ${line.stopped.scope} bound]`}`);
    }
    for (const stop of usage.stops) lines.push(`  stopped: the ${stop.scope} ${stop.bound} bound ended the ${stop.kind}${stop.field === '' ? '' : `/${stop.field}`} turn${stop.model === '' ? '' : ` of ${stop.model}`}`);
  }
  return `${lines.join('\n')}\n`;
}
