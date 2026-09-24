import type { CompiledModel } from '../model/compile.js';
import type { AssertionKind } from './assertions.js';

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
 * One problem that kept a store, or a read, from succeeding. For an id
 * clash, `id` and `source` name the clashing id and the other source that
 * already declares it. For a shared-vocabulary conflict (a zone, category,
 * environment or state two sources declare differently), `id` names the
 * entity, `field` the part of its definition that disagrees (the kind
 * itself when the whole definition differs, or a binding variable's name),
 * and `source` the other source. For a commit already stored under a
 * different time or model, `id` carries the commit id.
 */
export interface HistoryError {
  message: string;
  id?: string;
  field?: string;
  source?: string;
}

/** One assertion a `store` call opened or closed, for a caller keeping its own derived index in step. */
export interface AssertionChange {
  kind: AssertionKind;
  id: string;
  content: string;
  validFrom: number;
  validTo: number | null;
}

export interface StoreResult {
  errors: HistoryError[];
  /** Rows newly current (`recorded_to` left open) after this store; empty on a refusal or a no-op repeat. */
  opened: AssertionChange[];
  /** Rows this store closed on the recorded axis (superseded, not deleted); empty on a refusal or a no-op repeat. */
  closed: AssertionChange[];
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

export interface ReadResult {
  /** Left out only when `errors` is non-empty: the union read never picks silently between disagreeing sources. */
  model?: CompiledModel;
  errors: HistoryError[];
}

/** One raw assertion as recorded, with its four times, for rebuilding a derived index (e.g. a query engine). */
export interface AssertionRecord {
  source: string;
  kind: AssertionKind;
  id: string;
  content: string;
  validFrom: number;
  validTo: number | null;
  recordedFrom: number;
  recordedTo: number | null;
}

export interface AssertionsInput {
  /** Restricts the result to one source; left out, every source's assertions are returned. */
  source?: string;
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
  read(input?: ReadInput): ReadResult;
  /** The raw assertions behind every read, with their four times, for a source or for all of them. */
  assertions(input?: AssertionsInput): AssertionRecord[];
  /** Every source name that has ever stored a commit. */
  sources(): string[];
  /** Whether a source's commit is already stored (regardless of what it asserts). */
  hasCommit(source: string, commit: string): boolean;
  /** Releases the underlying database connection. */
  close(): void;
}
