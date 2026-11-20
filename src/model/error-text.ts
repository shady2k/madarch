import { inspect, types } from 'node:util';

/** The words a stage or a plugin raised, without letting its formatting raise again. */
export function errorText(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  try {
    // Inspect proxies directly: even checking their message can invoke a trap.
    if (!types.isProxy(thrown)) {
      if (Error.isError(thrown)) {
        const message: unknown = thrown.message;
        if (typeof message === 'string') return message;
      } else if (thrown !== null && typeof thrown === 'object') {
        const held = thrown as { readonly code?: unknown; readonly message?: unknown };
        const message = held.message;
        if (typeof message === 'string') {
          const code = held.code;
          return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message;
        }
      }
    }
  } catch {
    // A getter that refuses to answer is still visible in the inspected shape.
  }
  try {
    return inspect(thrown, { customInspect: false, getters: false, showProxy: true, depth: 4, breakLength: Infinity, sorted: true });
  } catch {
    return `an unprintable thrown ${typeof thrown}`;
  }
}
