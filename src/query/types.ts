/**
 * The graph-queries capability's interface: answering what a view or an
 * agent asks of the graph at a time, from the model history (see
 * design.md, "From files to answers"). This module touches no Bun-specific
 * API and no LadybugDB import; `src/adapters/ladybug-engine.ts` is the only
 * implementation so far, built from `HistoryStore`'s `AssertionRecord`s and
 * kept in step with `AssertionChange`s (see `HistoryStore.store`'s
 * `opened`/`closed`).
 */
import type { AssertionChange, AssertionRecord } from '../history/types.js';

/**
 * The time and state every query answers for: both time axes, defaulting
 * to the clock's current moment (the `as-of` requirement), and a state,
 * defaulting to the first state of the chain when every source agrees on
 * it (the coordinator's reading of a state-order discrepancy, see
 * design.md "Readings decided during the run").
 */
export interface QueryTime {
  /** UTC epoch milliseconds; defaults to the clock's current moment. */
  valid?: number;
  /** UTC epoch milliseconds; defaults to the clock's current moment. */
  known?: number;
  /** Defaults to the first state of the chain; an error if that is ambiguous and none is given. */
  state?: string;
}

/** One problem that kept a query from answering: an unknown element, or an ambiguous default state. */
export interface QueryError {
  message: string;
  /** The element id the query could not find, when that is the problem. */
  id?: string;
  /** The `valid` time the element could not be found at, when that is the problem. */
  time?: number;
  /** The state ids visible at this time, when the problem is that their chains disagree and none was named explicitly — any one of these can be passed as `QueryTime.state` instead. */
  states?: string[];
}

/** One element as a query answers it: only the fields views and chains need. */
export interface ElementAnswer {
  id: string;
  kind: string;
  name?: string;
  parent?: string;
}

export interface ChildrenResult {
  /** Left out only when `error` is set. */
  elements?: ElementAnswer[];
  error?: QueryError;
}

export interface ViewInput {
  /** The element to scope the view to; left out, the whole graph. */
  scope?: string;
  /** How many levels deep from the scope (or from the roots, unscoped) to show. */
  depth: number;
  /**
   * Also answer the view's neighbours: the elements outside the scope that
   * relations cross its boundary to or from, and those crossing relations.
   * Only meaningful with a scope; without one there is nothing outside and
   * it adds nothing. Default `false`.
   */
  context?: boolean;
}

/** One relation a view shows: the shown pair it was lifted and merged into, and every relation id behind it. */
export interface ViewRelation {
  from: string;
  to: string;
  relationIds: string[];
}

export interface ViewResult {
  /** The elements inside the scope (or the whole graph) down to the depth. Left out only when `error` is set. */
  elements?: ElementAnswer[];
  /**
   * Present only for a view asked with its context and a scope: the
   * elements outside the scope that crossing relations are drawn to or
   * from, each end outside lifted to its ancestor (or itself) whose parent
   * is the scope's parent or one of its ancestors, or which has no parent.
   * Kept apart from `elements` so a reader that knows nothing of context
   * never takes a neighbour for an element inside the scope.
   */
  neighbours?: ElementAnswer[];
  /** Between shown elements, and with context also between a shown element and a neighbour. */
  relations?: ViewRelation[];
  error?: QueryError;
}

export interface DependenciesInput {
  /** Follow the relation graph past one hop; default `false`. */
  transitive?: boolean;
  /** Caps how many hops a transitive search follows; ignored when `transitive` is not set. */
  maxHops?: number;
}

/** One element a dependents/dependencies query answers, with the chain of relation ids joining it to the asked element. */
export interface DependencyAnswer {
  id: string;
  /**
   * Relation ids, in hop order — but the direction that order walks
   * differs with which query asked for it, since each walks the relation
   * graph the opposite way: `dependencies(x)` walks from `x` outward, so
   * a chain here reads from the asked element `x` to `this` one;
   * `dependents(x)` walks other elements reaching `x`, so a chain here
   * reads from `this` element to the asked element `x` — the direction
   * dependency naturally reads in either case (what `x` depends on, or
   * what depends on `x`, each followed from its own start).
   */
  chain: string[];
}

export interface DependenciesResult {
  /** Left out only when `error` is set. */
  elements?: DependencyAnswer[];
  error?: QueryError;
}

/**
 * Built from the model history and kept in step with it (the `rebuild`
 * requirement): `rebuild` replaces everything the engine holds from a full
 * `AssertionRecord` list; `update` applies one store's own `opened`/`closed`
 * report instead of a full rebuild, for the common case of keeping step
 * after every stored version. Every query answers `{ valid, known, state }`
 * (see `QueryTime`); an element the query cannot find at that time is a
 * `QueryError`, never a thrown exception.
 */
export interface QueryEngine {
  children(elementId: string, at?: QueryTime): ChildrenResult;
  view(input: ViewInput, at?: QueryTime): ViewResult;
  dependents(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult;
  dependencies(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult;
  /** Replaces everything the engine holds, built from scratch from a full assertions list. */
  rebuild(assertions: readonly AssertionRecord[]): void;
  /** Applies one `store()` call's own report instead of a full rebuild. */
  update(opened: readonly AssertionChange[], closed: readonly AssertionChange[]): void;
  /** Releases the underlying database connection. */
  close(): void;
}
