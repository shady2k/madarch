/**
 * The canonical JSON and its digest: the one serialization a stored
 * artifact is addressed by (change registry-integrity, frozen 2026-10-01) —
 * keys sorted by code point, no insignificant whitespace, UTF-8, numbers as
 * `JSON.stringify` of the parsed value writes them. The same parsed value
 * always serializes to the same bytes and digests the same: nothing here
 * reads the clock, draws randomness or asks the locale.
 */
import { createHash } from 'node:crypto';
import { byCodePoint } from './order.js';

/** The SHA-256 hex digest of the parsed JSON value's canonical serialization. */
export function canonicalJsonDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value, '')).digest('hex');
}

/** The value's canonical JSON text, or the refusal naming where the value is not JSON. */
function canonicalJson(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // The frozen rule takes the numbers as `JSON.stringify` of the parsed
      // value writes them; `NaN` and the infinities are not JSON, and
      // `JSON.stringify` would silently write them as `null`.
      if (!Number.isFinite(value)) throw new Error(notJson(path, String(value)));
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      return Array.isArray(value)
        ? `[${value.map((each, index) => canonicalJson(each, `${path}/${index}`)).join(',')}]`
        : `{${Object.keys(value)
            .sort(byCodePoint)
            .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], `${path}/${key}`)}`)
            .join(',')}}`;
    default:
      throw new Error(notJson(path, typeof value));
  }
}

/** The refusal for a value the canonical serialization cannot hold, at the path it sits at. */
function notJson(path: string, what: string): string {
  const where = path === '' ? 'the value itself' : `the value at ${JSON.stringify(path)}`;
  return `a canonical JSON serialization holds only null, booleans, numbers, strings, arrays and objects, but ${where} is ${what}`;
}
