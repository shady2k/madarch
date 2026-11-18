/**
 * The measurement suite's one way to measure (decision 0041; plan ALX-340,
 * slice T4): run a case `runs` times, take the median, hold it against the
 * baseline recorded in `test/measure/baselines.json` with the factor two, and,
 * where the owner named an absolute limit, against that limit and the owner's
 * words it came from.
 *
 * This file and `test/measure/` are the only places a test reads an elapsed
 * clock (`check:tests`, rule 4). A measurement is deterministic in its own
 * test: the clock and the baselines are injected, and no assertion waits for
 * the wall.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The file the recorded medians stand in, by its full path. */
export const BASELINES_PATH = join(import.meta.dir, '..', 'measure', 'baselines.json');

/** How far above its recorded median a measurement may land. */
export const BASELINE_FACTOR = 2;

/** The runs a measurement takes when the case names none. */
export const DEFAULT_RUNS = 5;

/** A monotonic clock in milliseconds; a case's own test injects one. */
export interface Clock { now(): number }

/** The wall's clock: the one a real measurement reads. */
export const wallClock: Clock = { now: () => performance.now() };

/** One recorded measurement: the median of `runs` readings on CI's shape. */
export interface Baseline {
  readonly medianMs: number;
  readonly runs: number;
  readonly measuredAt?: string;
  readonly commit?: string;
  readonly note?: string;
}

/** `test/measure/baselines.json`: every recorded measurement by its case name. */
export interface Baselines {
  readonly schema: 1;
  readonly environment?: string;
  readonly baselines: Readonly<Record<string, Baseline>>;
}

/** A limit the owner named, with the owner's words it rests on. */
export interface AbsoluteLimit {
  readonly ms: number;
  /** Review reference, a pipe, then the owner's verbatim words. */
  readonly source: string;
}

export interface MeasureOptions {
  /** Readings to take; three at least, `DEFAULT_RUNS` when unnamed. */
  readonly runs?: number;
  readonly clock?: Clock;
  /** Injected by the helper's own test; the recorded file otherwise. */
  readonly baselines?: Baselines;
  /** A limit the owner named, with the owner's words. */
  readonly absolute?: AbsoluteLimit;
}

export interface Measured {
  readonly name: string;
  readonly runs: number;
  readonly samples: readonly number[];
  readonly medianMs: number;
  readonly baselineMs: number;
  readonly factor: number;
}

const here = (message: string): never => {
  throw new Error(`${import.meta.path}: ${message}`);
};

const milliseconds = (value: number): string => String(Math.round(value * 1000) / 1000);

/** The middle sample, or the mean of the two middles. */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) here('`median` needs at least one sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Read a baselines file; `test/measure/baselines.json` unless a test names another. */
export function readBaselines(path: string = BASELINES_PATH): Baselines {
  const absolutePath = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`${absolutePath}: the baselines cannot be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: the baselines are not JSON: ${(error as Error).message}`);
  }
  return parseBaselines(parsed, path);
}

const ROOT_FIELDS = ['$schema', 'schema', 'environment', 'baselines'] as const;
const ENTRY_FIELDS = ['medianMs', 'runs', 'measuredAt', 'commit', 'note'] as const;

/** Check a parsed baselines file against the schema beside it. */
export function parseBaselines(value: unknown, path: string = BASELINES_PATH): Baselines {
  const object = (candidate: unknown, where: string): Record<string, unknown> => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw new Error(`${where} must be an object`);
    return candidate as Record<string, unknown>;
  };
  const root = object(value, `${path}: the root`);
  for (const key of Object.keys(root)) {
    if (!(ROOT_FIELDS as readonly string[]).includes(key)) throw new Error(`${path}: unknown field \`${key}\``);
  }
  if (Object.hasOwn(root, '$schema') && typeof root['$schema'] !== 'string') throw new Error(`${path}: \`$schema\` must be a string`);
  if (!Object.hasOwn(root, 'schema') || root['schema'] !== 1) throw new Error(`${path}: \`schema\` must be 1`);
  if (root['environment'] !== undefined && typeof root['environment'] !== 'string') throw new Error(`${path}: \`environment\` must be a string`);
  const entries = object(root['baselines'], `${path}: \`baselines\``);
  const baselines = Object.create(null) as Record<string, Baseline>;
  for (const [name, candidate] of Object.entries(entries)) {
    const where = `${path}: baseline \`${name}\``;
    const entry = object(candidate, where);
    for (const key of Object.keys(entry)) {
      if (!(ENTRY_FIELDS as readonly string[]).includes(key)) throw new Error(`${where}: unknown field \`${key}\``);
    }
    const medianMs = entry['medianMs'];
    if (typeof medianMs !== 'number' || !Number.isFinite(medianMs) || medianMs <= 0) throw new Error(`${where}: \`medianMs\` must be a positive number`);
    const runs = entry['runs'];
    if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 3) throw new Error(`${where}: \`runs\` must be an integer of at least 3`);
    const optional: { measuredAt?: string; commit?: string; note?: string } = {};
    for (const key of ['measuredAt', 'commit', 'note'] as const) {
      const field = entry[key];
      if (field !== undefined && typeof field !== 'string') throw new Error(`${where}: \`${key}\` must be a string`);
      if (typeof field === 'string') optional[key] = field;
    }
    baselines[name] = { medianMs, runs, ...optional };
  }
  const environment = root['environment'];
  return { schema: 1, ...(typeof environment === 'string' ? { environment } : {}), baselines };
}

/** Run `run` `runs` times and hold its median clock reading against both bounds. */
export async function measure(name: string, run: () => void | Promise<void>, options: MeasureOptions = {}): Promise<Measured> {
  const runs = options.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 3) here(`\`${name}\`: \`runs\` must be an integer of at least 3, got ${String(runs)}`);
  const absolute = options.absolute;
  if (absolute !== undefined) {
    if (!Number.isFinite(absolute.ms) || absolute.ms <= 0) here(`\`${name}\`: the absolute limit must be a positive number of milliseconds`);
    const separator = absolute.source.indexOf(' | ');
    if (separator < 1 || absolute.source.slice(separator + 3).trim() === '') here(`\`${name}\`: absolute source must be \`review-reference | verbatim-owner-quote\``);
  }
  const baselines = options.baselines ?? readBaselines();
  const baseline = Object.hasOwn(baselines.baselines, name) ? baselines.baselines[name] : undefined;
  if (baseline === undefined) throw new Error(`${BASELINES_PATH}: no baseline for \`${name}\`; record one in the commit that measures it`);
  const clock = options.clock ?? wallClock;
  const samples: number[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const started = clock.now();
    await run();
    const elapsed = clock.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) here(`\`${name}\`: run ${String(runIndex + 1)} read a clock that went back (${milliseconds(elapsed)} ms)`);
    samples.push(elapsed);
  }
  const medianMs = median(samples);
  const allowed = baseline.medianMs * BASELINE_FACTOR;
  if (absolute !== undefined && medianMs > absolute.ms) {
    throw new Error(`${BASELINES_PATH}: \`${name}\` took ${milliseconds(medianMs)} ms as its median of ${String(runs)} runs, above the absolute limit ${milliseconds(absolute.ms)} ms — source: ${absolute.source}`);
  }
  if (medianMs > allowed) {
    throw new Error(`${BASELINES_PATH}: \`${name}\` took ${milliseconds(medianMs)} ms as its median of ${String(runs)} runs, above ${String(BASELINE_FACTOR)} × ${milliseconds(baseline.medianMs)} ms = ${milliseconds(allowed)} ms`);
  }
  if (absolute !== undefined && medianMs > absolute.ms) {
    throw new Error(`${BASELINES_PATH}: \`${name}\` took ${milliseconds(medianMs)} ms as its median of ${String(runs)} runs, above the absolute limit ${milliseconds(absolute.ms)} ms — the owner's words: ${absolute.source}`);
  }
  return { name, runs, samples, medianMs, baselineMs: baseline.medianMs, factor: BASELINE_FACTOR };
}
