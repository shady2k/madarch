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
export function canonicalJson(value: unknown, path = ''): string {
  return canonicalJsonAt(value, path, new Set());
}

function canonicalJsonAt(value: unknown, path: string, ancestors: Set<object>): string {
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
      if (ancestors.has(value)) throw new Error(notJson(path, 'a cycle'));
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const entries: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) throw new Error(notJson(`${path}/${index}`, 'a missing array element'));
            entries.push(canonicalJsonAt(value[index], `${path}/${index}`, ancestors));
          }
          return `[${entries.join(',')}]`;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(notJson(path, 'a non-plain object'));
        return `{${Object.keys(value).sort(byCodePoint).map((key) => `${JSON.stringify(key)}:${canonicalJsonAt((value as Record<string, unknown>)[key], `${path}/${key}`, ancestors)}`).join(',')}}`;
      } finally { ancestors.delete(value); }
    default:
      throw new Error(notJson(path, typeof value));
  }
}

/** The refusal for a value the canonical serialization cannot hold, at the path it sits at. */
function notJson(path: string, what: string): string {
  const where = path === '' ? 'the value itself' : `the value at ${JSON.stringify(path)}`;
  return `a canonical JSON serialization holds only null, booleans, numbers, strings, arrays and objects, but ${where} is ${what}`;
}
