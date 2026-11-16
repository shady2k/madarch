/** Bitemporal source selection and semantic resolution pins (decision 0039, items 25–27). */
import { createHash } from 'node:crypto';
import { byCodePoint } from '../model/order.js';

export interface AssertionRow {
  readonly id: string;
  readonly subject: { readonly type: 'vertex'; readonly uid: string } | { readonly type: 'edge'; readonly id: string; readonly kind: string; readonly from: string; readonly to: string };
  readonly property: string;
  readonly context: number;
  readonly language: string | null;
  readonly source: string;
  readonly value: unknown;
  readonly operation: 'assert' | 'retract';
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly recordedSequence: bigint;
}

function refusal(message: string): never {
  throw new Error(`${import.meta.path}:25: ${message}`);
}

function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) refusal('RFC 8785 strings cannot contain unpaired surrogates');
    } else if (point >= 0xdc00 && point <= 0xdfff) refusal('RFC 8785 strings cannot contain unpaired surrogates');
  }
}

/** RFC 8785: ECMAScript number serialization and UTF-16 property order, not locale order. */
export function canonicalAssertionValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') { validString(value); return JSON.stringify(value); }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refusal('an assertion value must be a finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) refusal('an assertion JSON array cannot contain holes');
      values.push(canonicalAssertionValue(value[i]));
    }
    return `[${values.join(',')}]`;
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) refusal('an assertion JSON object must have JSON properties only');
    return `{${Object.keys(value).sort().map((key) => {
      validString(key);
      return `${JSON.stringify(key)}:${canonicalAssertionValue((value as Record<string, unknown>)[key])}`;
    }).join(',')}}`;
  }
  return refusal(`an assertion value cannot contain ${typeof value}`);
}

function instant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) refusal(`invalid assertion instant ${JSON.stringify(value)}`);
  return result;
}

export function assertionStreamKey(row: AssertionRow): string {
  return JSON.stringify([row.subject.type, row.subject.type === 'vertex' ? row.subject.uid : row.subject.id, row.property, row.language, row.source]);
}

function newerRecorded(left: AssertionRow, right: AssertionRow): number {
  return left.recordedSequence < right.recordedSequence ? -1 : left.recordedSequence > right.recordedSequence ? 1 : byCodePoint(left.id, right.id);
}

export interface AssertionSelection {
  readonly selected: AssertionRow | null;
  readonly candidates: readonly AssertionRow[];
  readonly contested: boolean;
}

/** Select one subject/property/language slot; contexts are nearest layer first. */
export function selectAssertions(rows: readonly AssertionRow[], options: { readonly validAt: string; readonly recordedAt: string; readonly contexts: readonly number[]; readonly contextRecordedThrough?: Readonly<Record<number, string | null>> }): AssertionSelection {
  const validAt = instant(options.validAt);
  const recordedAt = instant(options.recordedAt);
  const streams = new Map<string, AssertionRow[]>();
  for (const row of rows) {
    if (!options.contexts.includes(row.context) || instant(row.recordedAt) > recordedAt || (options.contextRecordedThrough?.[row.context] != null && row.recordedSequence > BigInt(options.contextRecordedThrough[row.context]!))) continue;
    const key = assertionStreamKey(row);
    const stream = streams.get(key) ?? [];
    stream.push(row);
    streams.set(key, stream);
  }
  const candidates: AssertionRow[] = [];
  for (const stream of streams.values()) {
    const nearest = Math.min(...stream.map((row) => options.contexts.indexOf(row.context)));
    let latest: AssertionRow | undefined;
    for (const row of stream) {
      if (options.contexts.indexOf(row.context) !== nearest || instant(row.validFrom) > validAt || (row.validTo !== null && validAt >= instant(row.validTo))) continue;
      if (latest === undefined || newerRecorded(row, latest) > 0) latest = row;
    }
    if (latest !== undefined && latest.operation === 'assert') candidates.push(latest);
  }
  candidates.sort((left, right) => instant(right.validFrom) - instant(left.validFrom) || newerRecorded(right, left));
  const selected = candidates[0] ?? null;
  const values = new Set(candidates.map((row) => canonicalAssertionValue(row.value)));
  return { selected, candidates, contested: values.size > 1 };
}

export interface CandidateFingerprint { readonly tuple: string; readonly digest: string }

/** The caller supplies the exact dispute segment, not a pass or assertion identity. */
export function candidateFingerprint(row: AssertionRow, segment: { readonly from: string; readonly to: string | null }): CandidateFingerprint {
  const tuple = canonicalAssertionValue([row.source, row.operation, row.operation === 'assert' ? row.value : null, segment.from, segment.to]);
  return { tuple, digest: createHash('sha256').update(tuple).digest('hex') };
}

/** Compare tuples too: a digest collision is not agreement. */
export function resolutionMatches(pin: readonly CandidateFingerprint[], current: readonly CandidateFingerprint[], evidenceValid: boolean): boolean {
  if (!evidenceValid || pin.length !== current.length) return false;
  const ordered = (values: readonly CandidateFingerprint[]) => [...values].sort((a, b) => byCodePoint(a.tuple, b.tuple) || byCodePoint(a.digest, b.digest));
  const left = ordered(pin);
  const right = ordered(current);
  return left.every((value, index) => value.tuple === right[index]!.tuple && value.digest === right[index]!.digest);
}

/** A resolution protects semantic values, never a particular execution's assertion uid. */
export interface SemanticResolution {
  readonly pins: readonly CandidateFingerprint[];
  readonly segment: { readonly from: string; readonly to: string | null };
  readonly chosenSource: string;
  readonly chosenValue: unknown;
  readonly evidenceValid: boolean;
}
export function applySemanticResolution(selection: AssertionSelection, resolution: SemanticResolution | null): AssertionSelection {
  if (resolution === null || !resolutionMatches(resolution.pins, selection.candidates.map(row => candidateFingerprint(row, resolution.segment)), resolution.evidenceValid)) return selection;
  const selected = selection.candidates.find(row => row.source === resolution.chosenSource && canonicalAssertionValue(row.value) === canonicalAssertionValue(resolution.chosenValue));
  return selected === undefined ? selection : { ...selection, selected, contested: false };
}
