import type { CompiledModel } from '../model/compile.js';
import type { AssertionKind, ReadModel } from './assertions.js';

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
 * clash (an element, interface or relation id a second source declares over
 * an overlapping valid span — `CLASHABLE_KINDS`, still exclusive to one
 * source), `id` and `source` name the clashing id and the other source that
 * already declares it. For a commit already stored under a different time
 * or model, `id` carries the commit id. Shared vocabulary (a zone, category,
 * environment or state, or an environment's bindings) is never refused any
 * more — two sources declaring the same id differently is reported as a
 * `Discrepancy` on a successful read instead (see `ReadResult`).
 */
export interface HistoryError {
  message: string;
  id?: string;
  field?: string;
  source?: string;
}

/**
 * One shared-vocabulary id (a category, zone, environment or state) that
 * two or more sources declare differently — kept, not refused (the owner's
 * rule: "there is a connection, so we record it; it means they have
 * different endpoints"). `sources` lists every source with a definition for
 * `id` that took part in the disagreement, sorted by code point. `field` is
 * the kind's own name (`"zone"`, `"category"`, `"state"`, `"environment"`)
 * when the whole definition differs, a binding variable's name when two
 * sources bind it to different values, or `"order"` for the one
 * chain-wide discrepancy `state` can carry (`id` is then the sentinel
 * `"*"`, not one state's id): sources' chains each validate on their own at
 * compile time, but their union can still branch or cycle, and that no
 * longer refuses the store or the read — it is reported here instead.
 */
export interface Discrepancy {
  kind: AssertionKind;
  id: string;
  sources: string[];
  field?: string;
}

/**
 * One assertion a `store` call opened or closed, for a caller keeping its
 * own derived index in step. `source` is always the `StoreInput.source` the
 * call was made for: a single `store` call only ever writes rows for its own
 * source, never another's.
 */
export interface AssertionChange {
  source: string;
  kind: AssertionKind;
  id: string;
  content: string;
  validFrom: number;
  validTo: number | null;
}

export interface StoreResult {
  errors: HistoryError[];
  /**
   * Every row this store wrote with `recorded_to` left open (newly current);
   * empty on a refusal or a no-op repeat. This includes a brand-new
   * assertion, a shortened replacement (the same content, its `validTo` now
   * corrected) written in place of a row `closed` reports, and a row
   * restored to cover a span a late commit would otherwise have erased (see
   * `sqlite-history.ts`'s module doc). A caller can rebuild its own derived
   * index from `opened` and `closed` alone: together they name every row
   * this store wrote or superseded, each exactly as the database holds it.
   */
  opened: AssertionChange[];
  /**
   * Every row this store closed on the recorded axis (superseded, not
   * deleted), each reported exactly as it stood a moment before this store
   * touched it — its own `validFrom` and `validTo` as they were recorded,
   * not the point this commit now truncates it to (that corrected content,
   * when there is any duration left to state, is a separate row in
   * `opened`). Empty on a refusal or a no-op repeat.
   */
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
  /**
   * Left out only when `errors` is non-empty. A source-filtered read
   * (`ReadInput.source` given) returns a plain `CompiledModel`, byte for
   * byte what that source's own `store` was given (the `lossless`
   * requirement: a single source can never disagree with itself). The
   * union read (no `source`) returns a `ReadModel` instead: a shared id two
   * sources declare differently is kept, not refused, so `categories`,
   * `zones`, `environments` and `states` can each carry more than one
   * source's definition (see `ReadModel`, `Discrepancy`).
   */
  model?: CompiledModel | ReadModel;
  /** Shared ids two or more sources declare differently, kept in `model` rather than refused. Empty when every source agrees. */
  discrepancies: Discrepancy[];
  /** Real failures only (e.g. an id-clash safety net tripped on data written outside `store()`) — never a shared-vocabulary disagreement; see `Discrepancy`. */
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
