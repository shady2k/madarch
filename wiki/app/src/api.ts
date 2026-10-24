/**
 * The wiki's reading of the server: one JSON answer, with the failure named for a reader.
 */
import { appPath } from './app-base.js';

/** A request the server refused or could not answer: what a reader was waiting for, why, and the status when there was one. */
export class RequestError extends Error {
  /** The status the server answered, when it answered at all; a failed request that never reached it carries none. */
  readonly status?: number;
  /** `compose` says the failure in the reader's own words, given the server's reason; without it the sentence is English. */
  constructor(what: string, reason: string, status?: number, compose?: (reason: string) => string) {
    super(compose === undefined ? `Could not ${what}: ${reason}` : compose(reason));
    this.name = 'RequestError';
    this.status = status;
  }
}

/** Reads one JSON answer from the API, naming `what a reader was waiting for` on failure. */
export async function readJson<T>(what: string, url: string, signal?: AbortSignal, compose?: (reason: string) => string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(appPath(url), { signal });
  } catch (error: unknown) {
    // An aborted read is rethrown as itself, so the caller can tell its own
    // timeout abort from a real failure (finding 2.10).
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the request to ${url} failed (${reason})`, undefined, compose);
  }
  if (!response.ok) {
    let reason = `the server answered ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'message' in (body as Record<string, unknown>) &&
        typeof (body as Record<string, unknown>).message === 'string'
      ) {
        reason = String((body as Record<string, unknown>).message);
      }
    } catch (error: unknown) {
      // A body read that the abort interrupted is the timeout, not a
      // refusal: rethrow it as itself so the caller names the timeout
      // instead of "the server answered 503" (finding 2.11).
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // keep the status line as the reason
    }
    throw new RequestError(what, reason, response.status, compose);
  }
  try {
    return (await response.json()) as T;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the answer from ${url} was not JSON (${reason})`, undefined, compose);
  }
}
