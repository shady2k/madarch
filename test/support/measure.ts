/**
 * The measurement suite's one way to measure (decision 0041; plan ALX-340,
 * slice T4): run a case `runs` times, take the median, hold it against the
 * baseline recorded in `test/measure/baselines.json` with the factor two, and,
 * where a cited source line supports an absolute limit, against that limit and
 * the quote recorded at the reference.
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

/** An absolute limit supported by a verifiable source line and quote. */
export interface AbsoluteLimit {
  readonly ms: number;
  readonly source: { readonly ref: string; readonly quote: string };
}

export interface MeasureOptions {
  /** Readings to take; three at least, `DEFAULT_RUNS` when unnamed. */
  readonly runs?: number;
  readonly clock?: Clock;
  /** Injected by the helper's own test; the recorded file otherwise. */
  readonly baselines?: Baselines;
  /** A limit supported by the quoted source line. */
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

/** JSON source positions, indexed by JSON pointer. */
type Position = { line: number; column: number };

function locateJson(text: string): Map<string, Position> {
  const positions = new Map<string, Position>();
  let index = 0;
  const position = (): Position => {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    return { line, column: index - before.lastIndexOf('\n') };
  };
  const whitespace = (): void => { while (index < text.length && ' \t\r\n'.includes(text[index]!)) index += 1; };
  const string = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') break;
    }
    return JSON.parse(text.slice(start, index)) as string;
  };
  const pointer = (parts: string[]): string => '/' + parts.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  const value = (parts: string[]): void => {
    whitespace();
    if (!positions.has(pointer(parts))) positions.set(pointer(parts), position());
    if (text[index] === '{') {
      index++; whitespace();
      while (text[index] !== '}') {
        whitespace(); const keyPosition = position(); const key = string();
        whitespace(); index++; whitespace();
        positions.set(pointer([...parts, key]), keyPosition);
        value([...parts, key]); whitespace();
        if (text[index] === ',') { index++; continue; }
        break;
      }
      index++; return;
    }
    if (text[index] === '[') {
      index++; whitespace(); let item = 0;
      while (text[index] !== ']') { value([...parts, String(item++)]); whitespace(); if (text[index] === ',') { index++; continue; } break; }
      index++; return;
    }
    if (text[index] === '"') { string(); return; }
    while (index < text.length && !',}:] \t\r\n'.includes(text[index]!)) index++;
  };
  value([]);
  return positions;
}

function syntaxOffset(text: string): number {
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];
  let afterRoot = false;
  let previousComma = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (' \t\r\n'.includes(ch)) continue;
    if (afterRoot) return index;
    if (ch === '"') { quoted = true; previousComma = false; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); previousComma = false; continue; }
    if (ch === '}' || ch === ']') {
      if (previousComma) return index;
      stack.pop(); if (stack.length === 0) afterRoot = true;
      previousComma = false; continue;
    }
    if (ch === ',') { previousComma = true; continue; }
    if (ch === ':' || ch === 't' || ch === 'f' || ch === 'n' || ch === '-' || (ch >= '0' && ch <= '9')) { previousComma = false; continue; }
    if (stack.length > 0) return index;
    return index;
  }
  return text.length;
}

/** Read a baselines file; locations come from scanning the original JSON, never parser stacks. */
export function readBaselines(path: string = BASELINES_PATH): Baselines {
  const absolutePath = resolve(path);
  let text: string;
  try { text = readFileSync(absolutePath, 'utf8'); }
  catch (error) { throw new Error(`${absolutePath}: the baselines cannot be read: ${(error as Error).message}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    const offset = syntaxOffset(text);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    throw new Error(`${absolutePath}:${line}:${column} /: the baselines are not valid JSON`);
  }
  const positions = locateJson(text);
  return validateBaselines(parsed, absolutePath, positions);
}

const ROOT_FIELDS = ['$schema', 'schema', 'environment', 'baselines'] as const;
const ENTRY_FIELDS = ['medianMs', 'runs', 'measuredAt', 'commit', 'note'] as const;

/** Check a parsed file against the runtime schema and identify the offending JSON pointer. */
export function parseBaselines(value: unknown, path: string = BASELINES_PATH): Baselines {
  return validateBaselines(value, path, new Map());
}

function validateBaselines(value: unknown, path: string, positions: Map<string, Position>): Baselines {
  const fail = (pointer: string, message: string): never => {
    const parent = pointer.slice(0, pointer.lastIndexOf('/')) || '/';
    const loc = positions.get(pointer) ?? positions.get(parent) ?? positions.get('/') ?? { line: 1, column: 1 };
    throw new Error(`${path}:${loc.line}:${loc.column} ${pointer}: ${message}`);
  };
  const object = (candidate: unknown, pointer: string): Record<string, unknown> => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) fail(pointer, 'must be an object');
    return candidate as Record<string, unknown>;
  };
  const root = object(value, '/');
  for (const key of Object.keys(root)) if (!(ROOT_FIELDS as readonly string[]).includes(key)) fail(`/${key}`, 'unknown field');
  if (Object.hasOwn(root, '$schema') && typeof root['$schema'] !== 'string') fail('/$schema', 'must be a string');
  if (!Object.hasOwn(root, 'schema') || root['schema'] !== 1) fail('/schema', 'must be 1');
  if (root['environment'] !== undefined && typeof root['environment'] !== 'string') fail('/environment', 'must be a string');
  const entries = object(root['baselines'], '/baselines');
  const baselines = Object.create(null) as Record<string, Baseline>;
  for (const [name, candidate] of Object.entries(entries)) {
    const base = `/baselines/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const entry = object(candidate, base);
    for (const key of Object.keys(entry)) if (!(ENTRY_FIELDS as readonly string[]).includes(key)) fail(`${base}/${key}`, 'unknown field');
    const medianValue = entry['medianMs'];
    if (typeof medianValue !== 'number' || !Number.isFinite(medianValue) || medianValue <= 0) fail(`${base}/medianMs`, 'must be a positive number');
    const medianMs = medianValue as number;
    const runsValue = entry['runs'];
    if (typeof runsValue !== 'number' || !Number.isInteger(runsValue) || runsValue < 3) fail(`${base}/runs`, 'must be an integer of at least 3');
    const runs = runsValue as number;
    const optional: { measuredAt?: string; commit?: string; note?: string } = {};
    for (const key of ['measuredAt', 'commit', 'note'] as const) {
      const field = entry[key];
      if (field !== undefined && typeof field !== 'string') fail(`${base}/${key}`, 'must be a string');
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
    const { ref, quote } = absolute.source;
    const colon = ref.lastIndexOf(':');
    const filePart = colon < 1 ? '' : ref.slice(0, colon);
    const lineText = colon < 0 ? '' : ref.slice(colon + 1);
    let lineNumber = 0;
    let validDigits = lineText.length > 0;
    for (const character of lineText) {
      const digit = character.charCodeAt(0) - 48;
      if (digit < 0 || digit > 9) { validDigits = false; break; }
      lineNumber = lineNumber * 10 + digit;
    }
    if (filePart === '' || !validDigits || lineNumber < 1 || quote === '' || ['TODO', 'TBD', '…'].includes(quote)) here(`${import.meta.path}: invalid absolute source reference \`${ref}\``);
    const sourcePath = resolve(filePart);
    let sourceLines: string[] = [];
    try { sourceLines = readFileSync(sourcePath, 'utf8').split('\n'); }
    catch { here(`${sourcePath}:${lineNumber}: reference \`${ref}\` from ${import.meta.path} cannot be read`); }
    const line = sourceLines[lineNumber - 1];
    if (line === undefined || !line.includes(quote)) here(`${sourcePath}:${lineNumber}: reference \`${ref}\` from ${import.meta.path} does not contain the quote on that line`);
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
    throw new Error(`${BASELINES_PATH}: \`${name}\` took ${milliseconds(medianMs)} ms as its median of ${String(runs)} runs, above the absolute limit ${milliseconds(absolute.ms)} ms — source ${absolute.source.ref}: “${absolute.source.quote}”`);
  }
  if (medianMs > allowed) {
    throw new Error(`${BASELINES_PATH}: \`${name}\` took ${milliseconds(medianMs)} ms as its median of ${String(runs)} runs, above ${String(BASELINE_FACTOR)} × ${milliseconds(baseline.medianMs)} ms = ${milliseconds(allowed)} ms`);
  }
  return { name, runs, samples, medianMs, baselineMs: baseline.medianMs, factor: BASELINE_FACTOR };
}
