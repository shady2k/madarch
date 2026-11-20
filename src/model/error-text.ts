/**
 * The words a thrown value carries (ALX-649). A stage, a plugin or an agent is code
 * madarch runs but does not write, so a throw from it may be any value, not an `Error`:
 * an `Error` answers its message as before, a string stands as itself, a value that
 * names a `code` and a `message` — the shape the plugin host throws — answers
 * `code: message`, and every other value is written as canonical JSON — or, where
 * JSON cannot hold it, as its inspected shape. A journal or a report that asks this
 * helper never says `[object Object]`.
 */
import { inspect } from 'node:util';
import { canonicalJson } from './canonical.js';

/** The words `thrown` carries, for a place that must name what a stage or a plugin raised. */
export function errorText(thrown: unknown): string {
  try {
    if (thrown instanceof Error) return thrown.message;
    if (typeof thrown === 'string') return thrown;
    if (thrown !== null && typeof thrown === 'object') {
      const held = thrown as { readonly code?: unknown; readonly message?: unknown };
      if (typeof held.message === 'string') return typeof held.code === 'string' && held.code !== '' ? `${held.code}: ${held.message}` : held.message;
      try {
        return canonicalJson(thrown);
      } catch {
        return inspect(thrown, { depth: 2, breakLength: Infinity, sorted: true, customInspect: false });
      }
    }
    return typeof thrown === 'bigint' ? `${thrown}n` : String(thrown);
  } catch {
    try { return thrown !== null && typeof thrown === 'object' ? Object.getPrototypeOf(thrown)?.constructor?.name ?? 'object' : typeof thrown; }
    catch { return 'unprintable thrown value'; }
  }
}
