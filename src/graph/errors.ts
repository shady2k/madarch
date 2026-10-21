/**
 * The graph store's one error type (decision 0028). Every refusal names the
 * operation, the path of the offending part inside the caller's input and, when
 * the caller gave one, the file and line the input came from, so a refusal
 * found in a log can be traced to the input that caused it.
 */

/** Where a caller's input came from; carried by items that name a source. */
export interface GraphOrigin {
  file: string;
  line?: number;
}

export class GraphError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly origin: GraphOrigin | undefined;

  constructor(operation: string, path: string, message: string, origin?: GraphOrigin) {
    const from = origin === undefined ? '' : `; from ${origin.file}${origin.line === undefined ? '' : `:${origin.line}`}`;
    super(`${operation}: ${message} (path ${path}${from})`);
    this.name = 'GraphError';
    this.operation = operation;
    this.path = path;
    this.origin = origin;
  }
}

/** The PostgreSQL error code of a driver failure (`pg` and PGlite both set `code`). */
export function databaseCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

export function databaseMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * Thrown inside a write transaction whose recorded instant is earlier than a
 * version it has to close, because another store instance (another process
 * with its own clock) recorded that version first. The store that owns the
 * transaction retries the whole write with a clock moved past `after`; it is
 * never swallowed halfway, so no publication holds two recorded instants.
 */
export class GraphClockBehind extends GraphError {
  readonly after: string;

  constructor(operation: string, path: string, after: string, origin?: GraphOrigin) {
    super(operation, path, `the recorded instant is earlier than ${after}, when another writer recorded the version to close; the write is retried with a later clock`, origin);
    this.name = 'GraphClockBehind';
    this.after = after;
  }
}
