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
