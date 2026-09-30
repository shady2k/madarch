/**
 * The server's graphs: a graph is a named set of sources, and each graph
 * has one query engine built from the assertions of every source it lists
 * (decision 0013, amended 2026-09-30: in this milestone every graph lists
 * exactly one source and is named after it, but the set — and this module
 * — provides for a product of several repositories; the union seam is
 * exercised by a test, not only described).
 *
 * The engine is built lazily, on first use: a server that only stores
 * never pays for an engine, and after a restart the engine of a graph is
 * rebuilt from the histories the first time something asks the graph a
 * question. While a graph's engine is built, every store's own
 * `opened`/`closed` report keeps it in step (`Graphs.applyStore`); while
 * it is not, there is nothing to keep in step — the later build reads the
 * whole history anyway. Ids that clash across the sources of one graph
 * are a join-time problem for the milestone that adds such graphs
 * (decision 0003's duplicate-id check); sending and storing never refuse
 * on them.
 */
import { CLASHABLE_KINDS } from '../history/assertions.js';
import { createLadybugEngine } from '../adapters/ladybug-engine.js';
import type { AssertionRecord, Clock, HistoryStore, StoreResult } from '../history/types.js';
import type { QueryEngine } from '../query/types.js';
import { byCodePoint } from '../model/order.js';

export interface GraphsOptions {
  /** The history of one source, where a graph's engine reads its assertions. */
  historyOf(source: string): HistoryStore;
  /** The clock the engine answers queries for by default; tests inject a fake clock. */
  clock?: Clock;
}

/** One named set of sources with its one query engine. */
export interface Graph {
  readonly name: string;
  /** The sources the graph is built from, in code point order. */
  readonly sources: readonly string[];
  /** The engine, built on first use from every listed source's assertions. */
  engine(): QueryEngine;
  /** Releases the engine, if it was ever built. */
  close(): void;
}

export interface Graphs {
  /** The graph of one source: named after it, listing only it. */
  graphForSource(source: string): Graph;
  /** A graph with an explicit list of sources, for a product of several; the name must be new. */
  addGraph(name: string, sources: readonly string[]): Graph;
  /** The graph with that name, if there is one. */
  get(name: string): Graph | undefined;
  /**
   * Keeps every built graph that lists the source in step with one
   * store's report; a graph whose engine was never built, a report with
   * nothing opened or closed, and a source the graph does not list each
   * change nothing.
   */
  applyStore(source: string, result: StoreResult): void;
  /** Closes every graph's engine. */
  close(): void;
}

/** What the set of graphs knows about each of its graphs beside `Graph` itself. */
interface GraphEntry extends Graph {
  /** Whether one store's report concerns this graph at all. */
  lists(source: string): boolean;
  /** Applies one store's report to a built engine; a graph that was never built changes nothing. */
  applyIfBuilt(result: StoreResult): void;
}

/** One graph: the engine built lazily from the assertions of every listed source. */
function newGraph(name: string, sources: readonly string[], historyOf: (source: string) => HistoryStore, clock: Clock): GraphEntry {
  const listed = [...sources].sort(byCodePoint);
  let engineInstance: QueryEngine | undefined;
  return {
    name,
    sources: listed,
    engine(): QueryEngine {
      let engine = engineInstance;
      if (engine === undefined) {
        const assertions: AssertionRecord[] = listed.flatMap((source) => historyOf(source).assertions({ source }));
        const clash = clashingId(assertions);
        if (clash !== undefined) throw new Error(clash);
        engine = createLadybugEngine({ clock });
        engine.rebuild(assertions);
        engineInstance = engine;
      }
      return engine;
    },
    lists: (source) => listed.includes(source),
    applyIfBuilt: (result) => {
      engineInstance?.update(result.opened, result.closed);
    },
    close: () => {
      engineInstance?.close();
      engineInstance = undefined;
    },
  };
}

/**
 * The message naming every id (in code point order) that two sources of
 * one graph declare over overlapping valid spans — an element, interface
 * or relation id belongs to one source only (decision 0003) — or
 * `undefined` when no id clashes. A clashing union is never built: the
 * engine would hold duplicate rows for the id and answer no graph's
 * question.
 */
function clashingId(assertions: readonly AssertionRecord[]): string | undefined {
  const groups = new Map<string, AssertionRecord[]>();
  for (const row of assertions) {
    if (!CLASHABLE_KINDS.includes(row.kind)) continue;
    const key = `${row.kind}\u0000${row.id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  const clashes: { id: string; kind: string; sources: string[] }[] = [];
  for (const group of groups.values()) {
    const sources = new Set<string>();
    for (const row of group) {
      for (const other of group) {
        if (row.source === other.source) continue;
        // Two declarations can only disagree where both were believed
        // (the recorded axis) and both were true (the valid axis): a row
        // a later store closed on the recorded axis is history, not a
        // live clash.
        if (
          row.validFrom < (other.validTo ?? Infinity) && other.validFrom < (row.validTo ?? Infinity) &&
          row.recordedFrom < (other.recordedTo ?? Infinity) && other.recordedFrom < (row.recordedTo ?? Infinity)
        ) {
          sources.add(row.source);
          sources.add(other.source);
        }
      }
    }
    if (sources.size > 0) clashes.push({ id: group[0]!.id, kind: group[0]!.kind, sources: [...sources].sort(byCodePoint) });
  }
  if (clashes.length === 0) return undefined;
  clashes.sort((a, b) => byCodePoint(a.id, b.id));
  const named = clashes.map((each) => `"${each.id}" (${each.kind}: ${each.sources.join(', ')})`);
  return `the graph would hold ${named.join(', ')} more than once: an element, interface or relation id is declared by one source only (decision 0003)`;
}

export function createGraphs(options: GraphsOptions): Graphs {
  const { historyOf } = options;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const graphs = new Map<string, GraphEntry>();

  function addGraph(name: string, sources: readonly string[]): Graph {
    if (graphs.has(name)) throw new Error(`a graph named "${name}" already exists: one graph per name`);
    if (sources.length === 0) throw new Error(`the graph "${name}" lists no source: a graph is built from the sources it lists`);
    const listed = new Set<string>();
    const duplicated = new Set<string>();
    for (const source of sources) {
      if (listed.has(source)) duplicated.add(source);
      listed.add(source);
    }
    if (duplicated.size > 0) {
      throw new Error(`the graph "${name}" lists ${[...duplicated].sort(byCodePoint).map((each) => `"${each}"`).join(', ')} more than once: a graph is a set of sources, each listed once`);
    }
    const graph = newGraph(name, sources, historyOf, clock);
    graphs.set(name, graph);
    return graph;
  }

  function applyStore(source: string, result: StoreResult): void {
    if (result.opened.length === 0 && result.closed.length === 0) return;
    for (const graph of graphs.values()) {
      if (graph.lists(source)) graph.applyIfBuilt(result);
    }
  }

  function close(): void {
    for (const graph of graphs.values()) graph.close();
  }

  return {
    graphForSource: (source) => graphs.get(source) ?? addGraph(source, [source]),
    addGraph,
    get: (name) => graphs.get(name),
    applyStore,
    close,
  };
}
