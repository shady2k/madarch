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
 * whole history anyway. A store that failed after the history took its
 * commit — its sidecar write, or a built engine's own update — leaves no
 * report a retry could apply, so the built engines of its graphs are
 * dropped instead (`Graphs.dropBuilt`, and `applyStore`'s own recovery)
 * and the next use rebuilds them from the history. Ids that clash across
 * the sources of one graph
 * are a join-time problem for the milestone that adds such graphs
 * (decision 0003's duplicate-id check); sending and storing never refuse
 * on them.
 */
import { CLASHABLE_KINDS } from '../history/assertions.js';
import type { AsyncQueryDatabase, AsyncQueryEngine } from '../query/types.js';
import type { AssertionRecord, HistoryStore, StoreResult } from '../history/types.js';
import { byCodePoint } from '../model/order.js';

export interface GraphsOptions {
  /** The history of one source, where a graph's engine reads its assertions. */
  historyOf(source: string): HistoryStore;
  /** One owner shared by every source-scoped graph facade. */
  database: AsyncQueryDatabase;
}

/** One named set of sources with its one query engine. */
export interface Graph {
  readonly name: string;
  /** The sources the graph is built from, in code point order. */
  readonly sources: readonly string[];
  /** The engine, built on first use from every listed source's assertions. */
  engine(): Promise<AsyncQueryEngine>;
  /** Closes this graph permanently, invalidating a pending build and releasing its engine if built. */
  close(): Promise<void>;
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
   * change nothing. A report whose application into a built engine
   * throws leaves no engine behind: the built engines of the graphs
   * listing the source are dropped for the next use to rebuild from the
   * histories, and the throw is passed on to the caller.
   */
  applyStore(source: string, result: StoreResult): Promise<void>;
  /**
   * Drops the built engines of every graph listing the source, so their
   * next use rebuilds them from the histories through the clash check; a
   * graph whose engine was never built, and a source no graph lists, each
   * change nothing. For a store that failed after the history took its
   * commit: the retry answers "already stored" and reports no rows to
   * apply, so a built engine must not be left answering from the older
   * model the history has already moved past.
   */
  dropBuilt(source: string): Promise<void>;
  /**
   * Removes every graph listing the source, closing each built engine:
   * after a rename no graph is asked about the old name again, and a
   * graph of it left behind would hold the rows of a name no source
   * holds. A source no graph lists changes nothing.
   */
  remove(source: string): Promise<void>;
  /** Closes every graph permanently and invalidates pending engine builds. */
  close(): Promise<void>;
}

/** What the set of graphs knows about each of its graphs beside `Graph` itself. */
interface GraphEntry extends Graph {
  /** Whether one store's report concerns this graph at all. */
  lists(source: string): boolean;
  /** Applies one store's report to a built engine; a graph that was never built changes nothing. */
  applyIfBuilt(result: StoreResult): Promise<void>;
  /** Invalidates a pending build and drops the built engine, if there is one; the next use rebuilds through the clash check. */
  dropIfBuilt(): Promise<void>;
  /** Clears the retired source scope from the shared SQL projection before closing this graph. */
  clear(source: string): Promise<void>;
}

/** One graph: the engine built lazily from the assertions of every listed source. */
function newGraph(name: string, sources: readonly string[], historyOf: (source: string) => HistoryStore, database: AsyncQueryDatabase): GraphEntry {
  const listed = [...sources].sort(byCodePoint);
  let engineInstance: AsyncQueryEngine | undefined;
  let enginePromise: Promise<AsyncQueryEngine> | undefined;
  let facade: AsyncQueryEngine | undefined;
  let generation = 0;
  let retired = false;
  /**
   * Drops the built engine, if there is one; the next use rebuilds it
   * from the histories through the clash check. The cache is cleared
   * before anything can fail, and the close itself is best-effort: a
   * close that throws is swallowed. A destructor failing on a recovery
   * path must not keep the dropped engine, mask the error being
   * recovered, or stop the remaining graphs from being dropped, and
   * there is no caller left whose own error is worth more than the
   * original one — the engine's memory goes back to the runtime once
   * this cache held its last reference anyway.
   */
  const dropIfBuilt = async (): Promise<void> => {
    generation++;
    enginePromise = undefined;
    const engine = facade;
    engineInstance = undefined;
    facade = undefined;
    if (engine === undefined) return;
    try {
      await engine.close();
    } catch {
      // Swallowed on purpose; see above.
    }
  };
  const engine = (): Promise<AsyncQueryEngine> => {
    if (retired) return Promise.reject(new Error(`the graph "${name}" is closed`));
    if (engineInstance !== undefined) return Promise.resolve(engineInstance);
    if (enginePromise !== undefined) return enginePromise;

    const buildGeneration = generation;
    let pending!: Promise<AsyncQueryEngine>;
    pending = (async () => {
      try {
        const assertions = (await Promise.all(listed.map((source) => historyOf(source).assertions({ source })))).flat();
        if (buildGeneration !== generation) return engine();
        const clash = clashingId(assertions);
        if (clash !== undefined) throw new Error(clash);
        const built = database.forSources(listed);
        facade = built;
        await built.rebuild(assertions);
        if (buildGeneration !== generation) return engine();
        engineInstance = built;
        return built;
      } catch (error) {
        if (buildGeneration !== generation) return engine();
        throw error;
      } finally {
        if (enginePromise === pending) enginePromise = undefined;
      }
    })();
    enginePromise = pending;
    return pending;
  };
  const close = async (): Promise<void> => {
    if (retired) return;
    retired = true;
    await dropIfBuilt();
  };
  return {
    name,
    sources: listed,
    engine,
    lists: (source) => listed.includes(source),
    applyIfBuilt: async (result) => {
      // A graph of one source cannot take a clash: its rows are the only
      // rows, and the incremental update keeps the engine in step. A
      // graph of several can — the clash is decided only when the engine
      // is built — so its built engine is dropped and the next use
      // rebuilds it through the check instead of adding the rows blind.
      if (listed.length > 1) {
        await dropIfBuilt();
        return;
      }
      if (enginePromise !== undefined) {
        await dropIfBuilt();
        return;
      }
      if (engineInstance !== undefined) await engineInstance.update(result.opened, result.closed);
    },
    dropIfBuilt,
    clear: async (source) => {
      retired = true;
      generation++;
      enginePromise = undefined;
      const old = facade;
      facade = undefined;
      engineInstance = undefined;
      // Clear only the removed source. A graph can represent a union, but
      // its borrowed facade must not erase unrelated sources' shared rows.
      const clearer = database.forSources([source]);
      let failure: unknown;
      try { await clearer.rebuild([]); } catch (error) { failure = error; }
      try { await clearer.close(); } catch (error) { failure ??= error; }
      try { await old?.close(); } catch (error) { failure ??= error; }
      if (failure !== undefined) throw failure;
    },
    close,
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
  const { historyOf, database } = options;
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
    const graph = newGraph(name, sources, historyOf, database);
    graphs.set(name, graph);
    return graph;
  }

  async function applyStore(source: string, result: StoreResult): Promise<void> {
    if (result.opened.length === 0 && result.closed.length === 0) return;
    try {
      for (const graph of graphs.values()) {
        if (graph.lists(source)) await graph.applyIfBuilt(result);
      }
    } catch (error) {
      // A built engine failed to take the report — after the history
      // committed it, so the engine may hold half the rows or none, and
      // the retry this caller will make reports no rows (already
      // stored) that could bring it back in step. Drop the built
      // engines of the graphs listing the source: the next use rebuilds
      // them from the history through the clash check, never from a
      // half-updated or older model. The throw passes on unchanged, so
      // the server's own failure answer stays what it was.
      await dropBuilt(source);
      throw error;
    }
  }

  async function dropBuilt(source: string): Promise<void> {
    for (const graph of graphs.values()) {
      if (graph.lists(source)) await graph.dropIfBuilt();
    }
  }

  async function remove(source: string): Promise<void> {
    const removed: GraphEntry[] = [];
    for (const [name, graph] of graphs) {
      if (!graph.lists(source)) continue;
      graphs.delete(name);
      removed.push(graph);
    }
    let failure: unknown;
    for (const graph of removed) {
      try {
        await graph.clear(source);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async function close(): Promise<void> {
    let failure: unknown;
    for (const graph of graphs.values()) {
      try { await graph.close(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  return {
    graphForSource: (source) => graphs.get(source) ?? addGraph(source, [source]),
    addGraph,
    get: (name) => graphs.get(name),
    applyStore,
    dropBuilt,
    remove,
    close,
  };
}
