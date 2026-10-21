/**
 * Times and state spans of the graph (decision 0028, "Time").
 *
 * Valid and recorded times are `timestamptz` in the database and ISO-8601 text
 * with microseconds and a `Z` here: a JavaScript `Date` keeps milliseconds
 * only, and 0028 orders two commits that share a second by one microsecond.
 * Text of this one fixed width sorts like the instants it names, which is what
 * the coverage check relies on. `infinity` and `-infinity` are the open ends.
 */
import { GraphError, type GraphOrigin } from './errors.js';

/** An instant as a caller gives it: a `Date`, or ISO text ending in `Z` (up to six fractional digits), `infinity` or `-infinity`. */
export type Instant = Date | string;

/** A span of architecture-state keys, half-open: `from` is in, `to` is not. */
export interface StateSpan {
  from: number;
  to: number;
}

/** Every state: the span of a version that does not distinguish states. */
export const ALL_STATES: StateSpan = { from: 0, to: Number.MAX_SAFE_INTEGER };

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

/** The canonical text of an instant, or the refusal naming where it was given. */
export function instantText(value: Instant, operation: string, path: string, origin?: GraphOrigin): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new GraphError(operation, path, 'the date is invalid', origin);
    return instantText(value.toISOString(), operation, path, origin);
  }
  if (value === 'infinity' || value === '-infinity') return value;
  const match = ISO.exec(value);
  if (match === null) throw new GraphError(operation, path, `${JSON.stringify(value)} is not an instant: use a Date, infinity, -infinity, or ISO-8601 text in UTC such as 2026-10-21T10:00:00.000001Z`, origin);
  const parsed = new Date(`${match[1]}.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== match[1]) throw new GraphError(operation, path, `${JSON.stringify(value)} is not a calendar instant`, origin);
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}

/** Orders canonical instants; `-infinity` is before all, `infinity` after all. */
export function compareInstants(a: string, b: string): number {
  const key = (value: string): string => (value === 'infinity' ? '￿' : value === '-infinity' ? '' : value);
  const left = key(a);
  const right = key(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The instant one microsecond after a canonical finite instant (0028's tie rule for equal commit times). */
export function plusMicrosecond(value: string): string {
  const match = ISO.exec(value);
  if (match === null) throw new Error(`plusMicrosecond: ${value} is not a finite canonical instant`);
  const micros = Number((match[2] ?? '').padEnd(6, '0')) + 1;
  const base = new Date(`${match[1]}.000Z`);
  if (micros >= 1_000_000) base.setUTCSeconds(base.getUTCSeconds() + 1);
  return `${base.toISOString().slice(0, 19)}.${String(micros % 1_000_000).padStart(6, '0')}Z`;
}

/** SQL that selects a `timestamptz` column as canonical text. */
export function tsText(column: string): string {
  return `CASE WHEN ${column} = 'infinity' THEN 'infinity' WHEN ${column} = '-infinity' THEN '-infinity' ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;
}

/** Validates a state span: whole numbers, `from` below `to`, both inside the safe range. */
export function checkSpan(span: StateSpan, operation: string, path: string, origin?: GraphOrigin): StateSpan {
  const whole = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
  if (!whole(span.from) || !whole(span.to)) throw new GraphError(operation, path, `a state span holds whole non-negative state keys, got [${span.from}, ${span.to})`, origin);
  if (span.from >= span.to) throw new GraphError(operation, path, `a state span must not be empty, got [${span.from}, ${span.to})`, origin);
  return { from: span.from, to: span.to };
}

/** A half-open valid range, validated: `from` before `to`. */
export function checkValid(from: string, to: string, operation: string, path: string, origin?: GraphOrigin): void {
  if (from === 'infinity' || to === '-infinity' || compareInstants(from, to) >= 0) {
    throw new GraphError(operation, path, `a valid range must not be empty, got [${from}, ${to})`, origin);
  }
}

/** The microseconds since the epoch of a finite canonical instant. */
export function instantMicros(value: string): bigint {
  const match = ISO.exec(value);
  if (match === null) throw new Error(`instantMicros: ${value} is not a finite canonical instant`);
  return BigInt(new Date(`${match[1]}.000Z`).getTime()) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** The canonical instant of a count of microseconds since the epoch. */
export function microsInstant(micros: bigint): string {
  const ms = micros / 1000n;
  const rest = micros % 1000n;
  return new Date(Number(ms)).toISOString().replace(/\.(\d{3})Z$/, `.$1${String(rest).padStart(3, '0')}Z`);
}
