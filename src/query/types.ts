import type { AssertionChange, AssertionRecord } from '../history/types.js';
import type { AsyncVectorIndex } from '../vector/types.js';

/**
 * The graph-queries capability's asynchronous interface: answering what a view or an
 * agent asks of the graph at a time, from the model history. This module touches no
 * database-specific API.
 */
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
 * Query-only view of one stable graph revision. The reader is valid only for
 * the lifetime of `AsyncQueryEngine.withSnapshot`'s callback; every method is
 * asynchronous so a database adapter never has to pretend its queries are
 * synchronous.
 */
export interface QuerySnapshot {
  children(elementId: string, at?: QueryTime): Promise<ChildrenResult>;
  view(input: ViewInput, at?: QueryTime): Promise<ViewResult>;
  dependents(elementId: string, options: DependenciesInput, at?: QueryTime): Promise<DependenciesResult>;
  dependencies(elementId: string, options: DependenciesInput, at?: QueryTime): Promise<DependenciesResult>;
}

/** The asynchronous graph-query port. */
export interface AsyncQueryEngine extends QuerySnapshot {
  /**
   * Runs several reads against one revision; use only the supplied reader
   * inside the callback, and prevent queued writes from starving.
   */
  withSnapshot<T>(work: (snapshot: QuerySnapshot) => Promise<T>): Promise<T>;
  /** Replaces everything the engine holds, built from a full assertion list. */
  rebuild(assertions: readonly AssertionRecord[]): Promise<void>;
  /** Applies one store report instead of a full rebuild. */
  update(opened: readonly AssertionChange[], closed: readonly AssertionChange[]): Promise<void>;
  /** Waits for this scope's in-flight work and closes it. A borrowed scope leaves the shared connection to its database owner. */
  close(): Promise<void>;
}

/** Owner of a shared query database from which graph-scoped query engines borrow access. */
export interface AsyncQueryDatabase {
  /** Creates a query engine restricted to the given source set. */
  forSources(sources: readonly string[]): AsyncQueryEngine;
  /** Creates an exact vector index restricted to the given source set. */
  vectorIndexForSources(sources: readonly string[]): AsyncVectorIndex;
  /** Rejects new scopes, drains active work and closes the shared database resources once. */
  close(): Promise<void>;
}
