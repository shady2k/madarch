import type { CompiledModel } from '../model/compile.js';

/**
 * Supplies the current moment for recorded time. Injected rather than read
 * from the system clock directly, so a test can hold time still or move it
 * by hand instead of racing the real clock.
 */
export interface Clock {
  /** The current moment, as UTC epoch milliseconds. */
  now(): number;
}

/** One version of one source's model, ready to be recorded in the history. */
export interface StoreInput {
  /** The source's name, given by the caller (see the model-history capability's coverage limits). */
  source: string;
  /** The commit's identifier, used to recognize a version already stored. */
  commit: string;
  /** The commit's time, UTC epoch milliseconds: the start of this version's valid time. */
  committedAt: number;
  model: CompiledModel;
}

/**
 * One problem that kept a store from succeeding. For an id clash, `id` and
 * `source` name the clashing id and the other source that already declares
 * it.
 */
export interface HistoryError {
  message: string;
  id?: string;
  source?: string;
}

export interface StoreResult {
  errors: HistoryError[];
}

/** What to read: a moment on each time axis, and which source (or, left out, every source). */
export interface ReadInput {
  /** Restricts the read to one source; left out, `read` returns the union of every source. */
  source?: string;
  /** UTC epoch milliseconds; defaults to the clock's current moment. */
  valid?: number;
  /** UTC epoch milliseconds; defaults to the clock's current moment. */
  known?: number;
}

/**
 * Keeps every version of every source's compiled model, with both time
 * axes, from the first write: nothing is ever overwritten or deleted (see
 * the model-history capability). `src/adapters/sqlite-history.ts` is the
 * only implementation so far; this interface itself touches no Bun-specific
 * API.
 */
export interface HistoryStore {
  store(input: StoreInput): StoreResult;
  read(input?: ReadInput): CompiledModel;
}
