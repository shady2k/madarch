/**
 * One instrumentation layer (madarch-8bdc.2.5, item 1): every span of a run is
 * written as one JSON line under the store's `traces/` folder, in OpenTelemetry's
 * own field names, so a standard viewer loads it and `madarch trace` answers
 * where the time went.
 *
 * The spans come from the OpenTelemetry API's tracer. The SDK (pinned in
 * `package.json`, `@opentelemetry/sdk-trace-base`, checked under bun 1.4.2 before
 * it was added) batches them and hands them to a processor that writes the
 * OTLP JSON shape. A span carries its own duration (its start and end), the
 * rows or bytes it moved, and the process's RSS and heap at its start and its
 * end; it never carries a value a statement was given, a source line, a document
 * or a prompt.
 *
 * One run's trace is one file. Runs may nest (a server's session around a fill),
 * so the run a span belongs to is kept with the span when it starts, not read
 * again when it ends.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type AttributeValue, type Span } from '@opentelemetry/api';
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** What a span may record about itself: counts, sizes, names and paths, never a value or a text it moved. */
export type SpanAttributes = Readonly<Record<string, AttributeValue>>;

/** One trace of one run: its file, its log beside it, and its buffer of lines not yet written. */
/** One reading of the process's memory, at a moment of the run's own clock (`performance.now()`). */
interface MemorySample {
  readonly at: number;
  readonly rss: number;
  readonly heap: number;
}

/** How often a run samples the process's resident memory: fine enough to meet the peaks of a step. */
const MEMORY_SAMPLE_MS = 20;

export interface TraceRun {
  readonly runId: string;
  readonly store: string;
  readonly file: string;
  readonly logFile: string;
  /** The process's memory over the run, one reading every `MEMORY_SAMPLE_MS`: what a span's peak is read from. */
  readonly samples: MemorySample[];
  /** The sampler, while the run is open. */
  timer?: ReturnType<typeof setInterval>;
  /** The moment the run's trace was opened, in epoch milliseconds. */
  readonly startedAt: number;
  /** Whether log lines are printed to the process's own streams as they are written. */
  readonly console: boolean;
  buffer: string[];
  lines: number;
  closed: boolean;
}

/** The run a piece of work belongs to: a fill, a served session, a wiki server. */
const runStorage = new AsyncLocalStorage<TraceRun>();
/** The span that is open in this piece of work, for a span started without its parent named. */
const spanStorage = new AsyncLocalStorage<Span>();
/** The run a span was started under, so a span that outlives a nested run still lands in its own file. */
const spanRuns = new WeakMap<object, TraceRun>();
/** The process's memory when a span started: its end is read when it ends, whoever started it. */
const spanStartMemory = new WeakMap<object, { rss: number; heap: number; at: number }>();

/** The latest trace opened: the fallback for a span whose start was never seen (a span of a library). */
let latest: TraceRun | undefined;

/** One memory reading now, as the run's own clock states it. */
function sampleNow(): MemorySample {
  const used = process.memoryUsage();
  return { at: performance.now(), rss: used.rss, heap: used.heapUsed };
}

/**
 * The highest resident memory the process reached between two moments of the run, as the run's
 * samples state it. A span whose end no sample falls inside keeps the reading at the boundary it
 * did reach, so a short span still answers with a measured number.
 */
function peakBetween(samples: readonly MemorySample[], from: number, to: number): number {
  let peak = 0;
  for (let at = samples.length - 1; at >= 0; at -= 1) {
    const sample = samples[at]!;
    if (sample.at > to) continue;
    if (sample.at < from) break;
    if (sample.rss > peak) peak = sample.rss;
  }
  return peak;
}

/**
 * Whether spans are made at all. `MADARCH_TRACE=off` turns the layer off so the
 * same run can be measured with it and without it; nothing of the work changes,
 * only its record.
 */
let enabled = true;

/** What `work` is handed when the layer is off: the methods a caller uses, answering nothing. */
const NOOP_SPAN = {
  setAttribute: (): unknown => undefined,
  setAttributes: (): unknown => undefined,
  addEvent: (): unknown => undefined,
  addLink: (): unknown => undefined,
  setStatus: (): unknown => undefined,
  updateName: (): unknown => undefined,
  end: (): void => undefined,
  isRecording: (): boolean => false,
  recordException: (): void => undefined,
  spanContext: (): { traceId: string; spanId: string; traceFlags: number } => ({ traceId: '', spanId: '', traceFlags: 0 }),
} as unknown as Span;

const BUFFER_LINES = 256;

/** A memory reading, kept for one millisecond: a span's start and end ask for it and both get the same cheap answer. */
let memoryAt = -1;
let memoryHeld: { rss: number; heap: number } = { rss: 0, heap: 0 };
function memory(): { rss: number; heap: number } {
  const now = performance.now();
  if (now - memoryAt < 1) return memoryHeld;
  const used = process.memoryUsage();
  memoryHeld = { rss: used.rss, heap: used.heapUsed };
  memoryAt = now;
  return memoryHeld;
}

function pushLine(run: TraceRun, line: string): void {
  run.buffer.push(line);
  run.lines += 1;
  if (run.buffer.length >= BUFFER_LINES) flushRun(run);
}

/** Writes what a run has buffered; a run whose file cannot be written is not the caller's to crash on. */
function flushRun(run: TraceRun): void {
  if (run.buffer.length === 0) return;
  const text = run.buffer.join('');
  run.buffer = [];
  try { appendFileSync(run.file, text, 'utf8'); } catch { /* the trace is evidence, not the work: a full disk must not fail a fill */ }
}

function otlpValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? { intValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((one) => otlpValue(one ?? '')) } };
  return { stringValue: String(value) };
}

/** One span in OTLP's JSON field names, as one JSON line. */
function otlpLine(span: ReadableSpan, run: TraceRun, startMemory: { rss: number; heap: number; at: number } | undefined, endMemory: { rss: number; heap: number }, peak: number | undefined): string {
  const parent = (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId;
  const nano = (time: readonly [number, number]): string => String(BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]));
  const status = span.status;
  return `${JSON.stringify({
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(parent === undefined || parent === '' ? {} : { parentSpanId: parent }),
    name: span.name,
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: nano(span.startTime),
    endTimeUnixNano: nano(span.endTime),
    // Every span, whoever started it, states the process's memory at its start and its end.
    attributes: [
      ...Object.entries(span.attributes).filter(([key]) => !key.startsWith('process.rss.') && !key.startsWith('process.heap.')).map(([key, value]) => ({ key, value: otlpValue(value ?? '') })),
      { key: 'process.rss.start', value: { intValue: String(startMemory?.rss ?? endMemory.rss) } },
      { key: 'process.heap.start', value: { intValue: String(startMemory?.heap ?? endMemory.heap) } },
      { key: 'process.rss.end', value: { intValue: String(endMemory.rss) } },
      { key: 'process.heap.end', value: { intValue: String(endMemory.heap) } },
      // The highest resident memory the process reached while the span was open, sampled by the run: the
      // number a reader looks for when asking where the memory went (madarch-8bdc.2.5, item 4).
      { key: 'process.rss.peak', value: { intValue: String(peak ?? endMemory.rss) } },
    ],
    ...(span.events.length === 0 ? {} : { events: span.events.map((event) => ({ name: event.name, timeUnixNano: nano(event.time), ...(event.attributes === undefined ? {} : { attributes: Object.entries(event.attributes).map(([key, value]) => ({ key, value: otlpValue(value ?? '') })) }) })) }),
    ...(status.code === SpanStatusCode.UNSET ? {} : { status: { code: status.code === SpanStatusCode.OK ? 'STATUS_CODE_OK' : 'STATUS_CODE_ERROR', ...(status.message === undefined ? {} : { message: status.message }) } }),
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'madarch' } }, { key: 'madarch.run', value: { stringValue: run.runId } }] },
  })}\n`;
}

/** Writes each finished span to the trace of the run it was started under. */
class JsonlSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const run = runStorage.getStore() ?? latest;
    if (run !== undefined && !run.closed) spanRuns.set(span, run);
    spanStartMemory.set(span, { ...memory(), at: performance.now() });
  }

  onEnd(span: ReadableSpan): void {
    const run = spanRuns.get(span as unknown as object) ?? runStorage.getStore() ?? latest;
    if (run === undefined || run.closed) return;
    const started = spanStartMemory.get(span as unknown as object);
    // The span's own window, read from the run's samples: a span whose start this processor never saw
    // (a library's) states the reading at its end alone.
    const peak = started === undefined ? undefined : Math.max(started.rss, peakBetween(run.samples, started.at, performance.now()));
    pushLine(run, otlpLine(span, run, started, memory(), peak));
  }

  forceFlush(): Promise<void> {
    if (latest !== undefined) flushRun(latest);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (latest !== undefined) flushRun(latest);
    return Promise.resolve();
  }
}

let provider: BasicTracerProvider | undefined;
function tracerOf(): ReturnType<BasicTracerProvider['getTracer']> {
  if (provider === undefined) {
    provider = new BasicTracerProvider({ spanProcessors: [new JsonlSpanProcessor()] });
    trace.setGlobalTracerProvider(provider);
  }
  return provider.getTracer('madarch', '1.0.0');
}

/** How a run id becomes a file name: every character a path would read as a separator is one dash. */
function traceFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/gu, '-')}.jsonl`;
}

/** Opens one run's trace: its file starts empty and its lines are buffered. */
export function openTrace(options: { readonly store: string; readonly runId: string; readonly console?: boolean }): TraceRun {
  enabled = process.env['MADARCH_TRACE'] !== 'off';
  const folder = join(options.store, 'traces');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, traceFileName(options.runId));
  const logFile = join(folder, `${options.runId.replace(/[^A-Za-z0-9._-]/gu, '-')}.log.jsonl`);
  // A trace is this run's own record: a second start of one run id replaces the first, never appends to it.
  writeFileSync(file, '', 'utf8');
  writeFileSync(logFile, '', 'utf8');
  const run: TraceRun = {
    runId: options.runId, store: options.store, file, logFile, startedAt: Date.now(), console: options.console === true,
    buffer: [], lines: 0, closed: !enabled, samples: [],
  };
  if (enabled) {
    // The run samples the process's memory as it goes: a span's peak is the highest reading of its
    // own window, never the two readings at its ends, which miss what a step reached in between.
    run.samples.push(sampleNow());
    run.timer = setInterval(() => { run.samples.push(sampleNow()); }, MEMORY_SAMPLE_MS);
    run.timer.unref?.();
  }
  latest = enabled ? run : undefined;
  return run;
}

/** Runs `work` as part of one trace: every span started inside lands in that run's file. */
export function runInTrace<T>(run: TraceRun, work: () => Promise<T>): Promise<T> {
  return enabled ? runStorage.run(run, work) : work();
}

/** Ends a run's trace: what is buffered is written, and later spans of the run are dropped rather than written after its end. */
export function closeTrace(run: TraceRun): void {
  if (run.timer !== undefined) { clearInterval(run.timer); run.timer = undefined; }
  flushRun(run);
  run.closed = true;
  if (latest === run) latest = undefined;
}

/** The trace open in this piece of work, when one is. */
export function currentTrace(): TraceRun | undefined {
  return runStorage.getStore() ?? latest;
}

/** The span open in this piece of work, when one is. */
export function currentSpan(): Span | undefined {
  return spanStorage.getStore();
}

/**
 * Runs `work` inside one span and answers what it answered. Every span carries
 * the process's RSS and heap at its start and its end; a failure marks the span
 * failed and is thrown on, never turned into a smaller answer.
 */
export async function withSpan<T>(name: string, attributes: SpanAttributes, work: (span: Span) => Promise<T> | T): Promise<T> {
  if (!enabled) return await work(NOOP_SPAN);
  const run = runStorage.getStore();
  const parent = spanStorage.getStore();
  const tracer = tracerOf();
  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes: attributes as Attributes,
  }, parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent));
  if (run !== undefined && !run.closed) spanRuns.set(span, run);
  try {
    return await spanStorage.run(span, () => work(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  } finally {
    span.end();
  }
}

/** The synchronous form of `withSpan`, for a call that cannot wait: a child process read whole, a small git answer. */
export function withSpanSync<T>(name: string, attributes: SpanAttributes, work: (span: Span) => T): T {
  if (!enabled) return work(NOOP_SPAN);
  const run = runStorage.getStore();
  const parent = spanStorage.getStore();
  const span = tracerOf().startSpan(name, { kind: SpanKind.INTERNAL, attributes: attributes as Attributes }, parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent));
  if (run !== undefined && !run.closed) spanRuns.set(span, run);
  try {
    return spanStorage.run(span, () => work(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  } finally {
    span.end();
  }
}

/** Adds one attribute to the span open here, when one is: a span that recorded what it moved says so without a second span. */
export function annotateSpan(attributes: SpanAttributes): void {
  const span = spanStorage.getStore();
  if (span === undefined) return;
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
}

/** The number of bytes a value takes as JSON: a span records sizes, never the text itself. */
export function bytesOf(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); } catch { return 0; }
}

/** The trace files a store holds, newest first. */
export function traceFiles(store: string): { file: string; runId: string; modifiedAt: number }[] {
  const folder = join(store, 'traces');
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.log.jsonl'))
    .map((name) => {
      const file = join(folder, name);
      return { file, runId: name.slice(0, -'.jsonl'.length), modifiedAt: (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })() };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt || (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
}
