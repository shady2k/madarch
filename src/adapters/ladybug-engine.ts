import lbug from '@ladybugdb/core';
import type { LbugValue, PreparedStatement, QueryResult } from '@ladybugdb/core';
import type { AssertionChange, AssertionRecord, Clock } from '../history/types.js';
import { isOneStateChain } from '../history/assertions.js';
import { byCodePoint } from '../model/order.js';
import type {
  ChildrenResult,
  DependenciesInput,
  DependenciesResult,
  ElementAnswer,
  QueryEngine,
  QueryError,
  QueryTime,
  ViewInput,
  ViewRelation,
  ViewResult,
} from '../query/types.js';

const { Database, Connection } = lbug;

/**
 * `Connection.executeSync` returns one `QueryResult`, or an array when the
 * statement is a batch of several — this module always executes one
 * statement, so the array case never arises in practice; the helper still
 * narrows it defensively rather than asserting it away. The result is
 * always closed once its rows are read: an unclosed `QueryResult` holds its
 * own slice of the buffer pool, and a long-lived engine answering many
 * queries (a repository's whole working life) leaks that pool to
 * exhaustion otherwise (`Buffer manager exception: Unable to allocate
 * memory!`, tried and confirmed after a few hundred queries — see the
 * module doc's own account of `Database`'s fixed-size pool).
 */
function rowsOf(result: QueryResult | QueryResult[]): Record<string, LbugValue>[] {
  const single = Array.isArray(result) ? result[result.length - 1] : result;
  if (single === undefined) return [];
  const rows = single.getAllSync();
  single.close();
  return rows;
}

/**
 * How far a transitive search follows the relation graph when `maxHops` is
 * left out, and the hard ceiling any caller-given `maxHops` is clamped to.
 * A plain (non-`SHORTEST`) recursive relationship pattern refuses an upper
 * bound past 30 outright in this LadybugDB build (`Binder exception: Upper
 * bound of rel r exceeds maximum: 30`, tried and confirmed); the `SHORTEST`
 * pattern `dependencyQuery` now uses (see its own doc) accepts a far higher
 * bound, but 30 is kept anyway as this module's own deliberate limit — the
 * `graph-queries` capability itself never asks for more, and an unbounded
 * hop count would let one query walk the whole graph regardless of what
 * the caller meant by "transitive".
 */
const MAX_HOPS_CEILING = 30;

/** One element assertion's content, the fields the engine's queries need (see `CompiledElement`). */
interface ElementContent {
  id: string;
  kind: string;
  name?: string;
  parent?: string;
  ancestors: string[];
  states: string[];
}

/** One relation assertion's content, the fields the engine's queries need (see `CompiledRelation`). */
interface RelationContent {
  id: string;
  from: string;
  to: string;
  refines?: string;
  states: string[];
}

/** One state assertion's content: only `after` decides the chain's order. */
interface StateContent {
  id: string;
  after?: string;
}

/**
 * A row's own primary key inside the engine: `(source, kind, id,
 * validFrom)` alone is `store()`'s own identity for a row (`AssertionChange`
 * never needs more, since only one row can ever be open for that tuple at
 * once — the `sources` requirement's own invariant), but `rebuild` loads
 * every row `assertions()` holds, current or not, for `known`-axis time
 * travel to work through the engine at all: the very "closed, then a
 * shortened replacement reopened at the same `validFrom`" pattern
 * `store()` itself produces (see `sqlite-history.ts`) can leave several
 * historical rows sharing one `(source, kind, id, validFrom)`, told apart
 * only by `recordedFrom`. It is folded into the key so two such rows never
 * collide on a node table's own primary key.
 */
function rowKey(source: string, kind: string, id: string, validFrom: number, recordedFrom: number): string {
  return [source, kind, id, validFrom, recordedFrom].join('\u0000');
}

/** An element id, restricted to `ID_PATTERN` in `model/schema.ts` (letters, digits, `.`, `_`, `-`): never a Cypher-quote-breaking character. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A Cypher list literal of ids, e.g. `['a','b']`, for text a query is built with (see `viewRelationsQuery`). Every id is checked against `SAFE_ID` first: this is what makes inlining safe, not merely convenient. */
function literalIdList(ids: readonly string[]): string {
  return `[${ids.map(literalId).join(', ')}]`;
}

/** One id as a quoted Cypher string literal, checked against `SAFE_ID` the same way (see `literalIdList`). */
function literalId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`refusing to build a query around an id outside the model's own id pattern: ${JSON.stringify(id)}`);
  return `'${id}'`;
}

/** The bitemporal and state filter every hop of every query carries, over an alias already bound in scope, as query parameters. */
function filterOf(alias: string): string {
  return `${alias}.validFrom <= $valid AND (${alias}.validTo IS NULL OR ${alias}.validTo > $valid) AND ${alias}.recordedFrom <= $known AND (${alias}.recordedTo IS NULL OR ${alias}.recordedTo > $known) AND list_contains(${alias}.states, $state)`;
}

/**
 * The same filter as `filterOf`, but with `valid`/`known`/`state` built
 * into the query text as literals rather than referenced as `$`
 * parameters — needed inside a lambda body (`all(x IN rels(p) WHERE
 * ...)`), where this LadybugDB build's binder cannot resolve a parameter at
 * all: not a refused query but a native panic (`Assertion failed ...
 * UNREACHABLE_CODE`, tried and confirmed, the same failure `viewRelationsQuery`
 * hit for `list_filter`'s lambda — see its own comment). `valid`/`known`
 * are numbers (never a string a query could break out of); `state` is
 * checked against `SAFE_ID` first, the same guard `literalIdList` uses.
 */
function filterOfLiteral(alias: string, valid: number, known: number, state: string): string {
  if (!SAFE_ID.test(state)) throw new Error(`refusing to build a query around a state outside the model's own id pattern: ${JSON.stringify(state)}`);
  return `${alias}.validFrom <= ${valid} AND (${alias}.validTo IS NULL OR ${alias}.validTo > ${valid}) AND ${alias}.recordedFrom <= ${known} AND (${alias}.recordedTo IS NULL OR ${alias}.recordedTo > ${known}) AND list_contains(${alias}.states, '${state}')`;
}

/** What a view asked with its context needs to tell inside from outside: the scope and its own root-to-parent ancestors, both already known model ids. */
interface ViewContext {
  scope: string;
  scopeAncestors: string[];
}

/** Whether the element bound to `alias` is the scope or inside it, as Cypher over its own row. */
function insideScope(alias: string, context: ViewContext): string {
  const scope = literalId(context.scope);
  return `(${alias}.elementId = ${scope} OR list_contains(${alias}.ancestors, ${scope}))`;
}

/**
 * Cypher for the list whose first entry is what the element bound to
 * `alias` is drawn as in a view (empty when it is drawn as nothing), over
 * the literal shown-id list `shown`. Inside the scope (or everywhere, with
 * no context): the nearest shown ancestor, itself included. Outside it,
 * with context: its ancestor (or itself) whose parent is the scope's parent
 * or one of the scope's ancestors, or which has no parent — which is the
 * first entry of its own root-to-self chain that is not one of the scope's
 * ancestors, since two ancestor chains share exactly a common prefix; when
 * every entry is one (the element is itself an ancestor of the scope), the
 * element itself, appended last for that case.
 */
function liftExpression(alias: string, shown: string, context: ViewContext | undefined): string {
  const nearestShown = `list_filter([${alias}.elementId] + list_reverse(${alias}.ancestors), x -> list_contains(${shown}, x))`;
  if (context === undefined) return nearestShown;
  const outside = `list_filter(${alias}.ancestors + [${alias}.elementId], x -> NOT list_contains(${literalIdList(context.scopeAncestors)}, x)) + [${alias}.elementId]`;
  return `CASE WHEN ${insideScope(alias, context)} THEN ${nearestShown} ELSE ${outside} END`;
}

/**
 * The relations a view draws, from `viewRelationsQuery`'s rows (one per
 * drawable relation): a refinement whose own ends are not both shown is
 * dropped when the relation it refines is drawn here too, and the rest
 * merge per lifted pair, by `from`, then `to`, their ids in code point
 * order.
 *
 * With context, a relation whose lifted end is the scope itself is not
 * drawn when one of its refinements has its own end on that side shown
 * below the scope: the refinement is drawn instead, so an element's own
 * view shows the part that does the work (`refinement-in-own-view`). Any
 * other refinement of it then stands for itself, since the relation it
 * refines is no longer drawn.
 */
function drawnRelations(rows: readonly Record<string, LbugValue>[], context?: { scope: string; shown: ReadonlySet<string> }): ViewRelation[] {
  const byId = new Map(rows.map((row) => [row.relationId as string, row]));
  const replaced = new Set<string>();
  if (context !== undefined) {
    const below = (id: LbugValue | undefined): boolean => id !== context.scope && context.shown.has(id as string);
    for (const row of rows) {
      const general = row.refines === null ? undefined : byId.get(row.refines as string);
      if (general === undefined) continue;
      if ((general.fromId === context.scope && below(row.ownFrom)) || (general.toId === context.scope && below(row.ownTo))) replaced.add(general.relationId as string);
    }
  }
  const drawn = (id: string): boolean => byId.has(id) && !replaced.has(id);
  const byPair = new Map<string, ViewRelation>();
  for (const row of rows) {
    if (replaced.has(row.relationId as string)) continue;
    if (row.refines !== null && row.endsShown !== true && drawn(row.refines as string)) continue;
    const from = row.fromId as string;
    const to = row.toId as string;
    const key = JSON.stringify([from, to]);
    const pair = byPair.get(key) ?? { from, to, relationIds: [] };
    if (!pair.relationIds.includes(row.relationId as string)) pair.relationIds.push(row.relationId as string);
    byPair.set(key, pair);
  }
  return [...byPair.values()]
    .sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to))
    .map((pair) => ({ from: pair.from, to: pair.to, relationIds: pair.relationIds.sort(byCodePoint) }));
}

interface ResolvedTime {
  valid: number;
  known: number;
  state: string;
}

/** One live state row (as `update`/`rebuild` track it) — enough to resolve a query's default state without a graph traversal (not one of the owner's listed Cypher traversals; see design.md's "Readings decided during the run"). */
interface LiveStateRow {
  source: string;
  id: string;
  after?: string;
  validFrom: number;
  validTo: number | null;
  recordedFrom: number;
  recordedTo: number | null;
}

/**
 * Two sources declaring the very same state row (the same id, the same
 * `after`, or its absence) agree — one declaration, not two — so it must
 * count once towards `isOneStateChain`'s own "did every state get reached
 * from the one root" tally, not once per source. Without this, two sources
 * that simply agree on a trivial single-state model (both declaring the
 * default `as-is` with no `after`, the ordinary case) would each contribute
 * their own "root" (`after === undefined`) row, `isOneStateChain` would see
 * two roots where there is truly one, and every default-state query would
 * refuse with "the chains disagree" even though nothing disagrees at all
 * (tried and confirmed: two sources storing nothing but the implicit
 * default state already triggered this). Two rows sharing an id but
 * naming a genuinely different `after` are kept apart (their keys differ),
 * exactly the real disagreement `isOneStateChain` must still catch.
 */
function dedupeStateRows<T extends { id: string; after?: string }>(states: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const state of states) {
    const key = `${state.id}\u0000${state.after ?? ''}`;
    if (!seen.has(key)) seen.set(key, state);
  }
  return [...seen.values()];
}

/**
 * The chain's first state — the query default (design.md: "Readings
 * decided during the run") — or `undefined` when the states visible at the
 * asked time do not form one chain (`isOneStateChain`, the same check
 * `assembleCompiledModel` in `history/assertions.ts` uses for the union
 * read's own chain-wide discrepancy), once rows every source agrees on are
 * folded together (`dedupeStateRows`) so only a real disagreement ever
 * counts as one. A chain's one root is the one state naming no `after`;
 * `isOneStateChain` having already confirmed there is exactly one such
 * state and that every state is reached from it makes finding it here just
 * `find`, not a second walk of the chain.
 */
function chainRoot(states: readonly { id: string; after?: string }[]): string | undefined {
  const deduped = dedupeStateRows(states);
  if (!isOneStateChain(deduped)) return undefined;
  return deduped.find((s) => s.after === undefined)?.id;
}

/**
 * LadybugDB behind `QueryEngine` (see design.md, "From files to answers"
 * and the graph-queries capability). Bun-specific in spirit only through
 * `@ladybugdb/core`'s native binding — this is the boundary decision 0008
 * draws for the query engine, the counterpart to `sqlite-history.ts` for
 * the history.
 *
 * Three node tables and one relationship table, built from the history's
 * `AssertionRecord`s (`rebuild`) and kept in step with `store()`'s own
 * `opened`/`closed` report (`update`):
 * - `Element`: one row per element assertion (kind `"element"`), keyed by
 *   `pk` (`source`+`kind`+`id`+`validFrom`, `store()`'s own identity for a
 *   row — see `rowKey`). Carries `ancestors` (already the full root-to-
 *   parent chain, computed once at compile time) and `states`, so `view`'s
 *   ancestor-lifting and every query's state filter need no recursive
 *   parent walk of their own.
 * - `Relation`: one row per relation assertion, the same way, carrying
 *   `fromId`/`toId`/`refines`.
 * - `Anchor`: one node per element id, with no time-varying data of its
 *   own — purely so `RELATES_TO` (below) has a stable pair of physical
 *   nodes to connect, since a relation's own validity already implies its
 *   ends exist then (the model compiler refuses a relation whose end does
 *   not — see design.md's presence rules), so the transitive traversal
 *   never needs a specific *version* row of an end, only its stable anchor.
 * - `RELATES_TO` (`Anchor` -> `Anchor`): one edge per relation assertion,
 *   carrying the same bitemporal and state fields as `Relation`, so a
 *   multi-hop `dependents`/`dependencies` walk can filter every hop as it
 *   explores, through the pattern's own `SHORTEST`
 *   relationship-filter clause (`*... (r, n | WHERE ...)`, see
 *   `dependencyQuery`'s own doc) — the recursive Cypher traversal the
 *   owner's constraint asks for (see stage3-brief.md).
 *
 * `view`'s own traversal (lifting each relation's ends to the nearest
 * *shown* ancestor, merging per shown pair, dropping a relation whose ends
 * land on the same shown element, and drawing a refinement beside the
 * relation it refines only once its own lifted pair differs from that
 * relation's — see `viewRelationsQuery`'s own doc) needs no multi-hop walk
 * at all: with `ancestors` already a precomputed, ordered list, "the
 * nearest shown ancestor of X" is simply the first entry of `[X] +
 * reverse(X's ancestors)` that is a member of the shown set — a single
 * Cypher `list_filter` over already-materialized data, still every bit "a
 * LadybugDB Cypher query" (see `viewRelationsQuery`).
 *
 * `interfaces`, `categories`, `zones` and `environments` carry nothing this
 * capability's five requirements ever query (per-environment queries are
 * explicitly out of the graph-queries capability's coverage), so they are
 * not modeled here at all — only elements, relations and (for resolving a
 * query's default state) states.
 */
export interface LadybugEngineOptions {
  /**
   * Supplies `valid`/`known`'s default when a query's own `at` leaves
   * either out (the same convention `createSqliteHistory` uses, and the
   * same `Clock` interface): a test injects a fake one to hold time still
   * or move it by hand, the same way it would for the history this engine
   * is built from. Left out, `Date.now()` is used directly.
   */
  clock?: Clock;
}

export function createLadybugEngine(options: LadybugEngineOptions = {}): QueryEngine {
  const clock = options.clock ?? { now: () => Date.now() };
  // `Database`'s own defaults reserve an enormous virtual-memory mapping
  // (observed: an 8 TiB `mmap`) sized for a large on-disk deployment;
  // opening more than a handful of instances in one process — one engine
  // per test, run's own tests included — exhausted the process's mapping
  // budget outright (`Buffer manager exception: Mmap for size ... failed`,
  // tried and confirmed). This engine is in-memory and built from a model
  // history, never larger than what one repository's graph needs, so a few
  // hundred MiB of buffer pool and a few GiB of address space are ample,
  // and keep every instance's footprint small enough that many can coexist.
  const db = new Database(':memory:', 256 * 1024 * 1024, false, false, 4 * 1024 * 1024 * 1024);
  const conn = new Connection(db);
  conn.initSync();

  conn.querySync(
    `CREATE NODE TABLE Element(pk STRING, elementId STRING, kind STRING, name STRING, parentId STRING, ancestors STRING[], states STRING[], validFrom INT64, validTo INT64, recordedFrom INT64, recordedTo INT64, source STRING, PRIMARY KEY(pk))`,
  );
  conn.querySync(
    `CREATE NODE TABLE Relation(pk STRING, relationId STRING, fromId STRING, toId STRING, refines STRING, states STRING[], validFrom INT64, validTo INT64, recordedFrom INT64, recordedTo INT64, source STRING, PRIMARY KEY(pk))`,
  );
  conn.querySync(`CREATE NODE TABLE Anchor(elementId STRING, PRIMARY KEY(elementId))`);
  conn.querySync(
    `CREATE REL TABLE RELATES_TO(FROM Anchor TO Anchor, pk STRING, relationId STRING, states STRING[], validFrom INT64, validTo INT64, recordedFrom INT64, recordedTo INT64, source STRING)`,
  );

  const insertElement = conn.prepareSync(
    `CREATE (e:Element {pk: $pk, elementId: $elementId, kind: $kind, name: $name, parentId: $parentId, ancestors: $ancestors, states: $states, validFrom: $validFrom, validTo: $validTo, recordedFrom: $recordedFrom, recordedTo: $recordedTo, source: $source})`,
  );
  // `update`'s own closed rows are never deleted, only closed (`recordedTo`
  // set, the same single mutation the history itself ever applies to a
  // row — see the module doc): a row `store()` has since closed is still
  // exactly what a `known` time before that closing must see (the same
  // known-axis requirement `rebuild`'s own module doc already argues from
  // loading every historical row). Matched by identity, not by `pk` (which
  // now includes `recordedFrom` — see `rowKey`'s own comment, which
  // `AssertionChange` never carries): `recordedTo IS NULL` picks out the
  // one row that can ever be open for this `(source, elementId, validFrom)`
  // at once instead.
  const closeElement = conn.prepareSync(
    `MATCH (e:Element) WHERE e.source = $source AND e.elementId = $id AND e.validFrom = $validFrom AND e.recordedTo IS NULL SET e.recordedTo = $recordedTo`,
  );
  const insertRelation = conn.prepareSync(
    `CREATE (r:Relation {pk: $pk, relationId: $relationId, fromId: $fromId, toId: $toId, refines: $refines, states: $states, validFrom: $validFrom, validTo: $validTo, recordedFrom: $recordedFrom, recordedTo: $recordedTo, source: $source})`,
  );
  const closeRelation = conn.prepareSync(
    `MATCH (r:Relation) WHERE r.source = $source AND r.relationId = $id AND r.validFrom = $validFrom AND r.recordedTo IS NULL SET r.recordedTo = $recordedTo`,
  );
  const mergeAnchor = conn.prepareSync(`MERGE (a:Anchor {elementId: $elementId})`);
  const insertEdge = conn.prepareSync(
    `MATCH (f:Anchor {elementId: $fromId}), (t:Anchor {elementId: $toId})
     CREATE (f)-[:RELATES_TO {pk: $pk, relationId: $relationId, states: $states, validFrom: $validFrom, validTo: $validTo, recordedFrom: $recordedFrom, recordedTo: $recordedTo, source: $source}]->(t)`,
  );
  const closeEdge = conn.prepareSync(
    `MATCH ()-[r:RELATES_TO]->() WHERE r.source = $source AND r.relationId = $id AND r.validFrom = $validFrom AND r.recordedTo IS NULL SET r.recordedTo = $recordedTo`,
  );

  const existsQuery = conn.prepareSync(`MATCH (e:Element) WHERE e.elementId = $id AND ${filterOf('e')} RETURN e.elementId AS id LIMIT 1`);
  const scopeAncestorsQuery = conn.prepareSync(`MATCH (e:Element) WHERE e.elementId = $id AND ${filterOf('e')} RETURN e.ancestors AS ancestors LIMIT 1`);
  const childrenQuery = conn.prepareSync(
    `MATCH (e:Element) WHERE e.parentId = $id AND ${filterOf('e')} RETURN e.elementId AS id, e.kind AS kind, e.name AS name, e.parentId AS parent ORDER BY e.elementId`,
  );
  const shownQuery = conn.prepareSync(
    `MATCH (e:Element) WHERE ${filterOf('e')}
       AND (size(e.ancestors) - $scopeDepth) <= $depth
       AND ($hasScope = false OR e.elementId = $scope OR list_contains(e.ancestors, $scope))
     RETURN e.elementId AS id, e.kind AS kind, e.name AS name, e.parentId AS parent ORDER BY e.elementId`,
  );
  const elementsByIdQuery = conn.prepareSync(
    `MATCH (e:Element) WHERE list_contains($ids, e.elementId) AND ${filterOf('e')}
     RETURN e.elementId AS id, e.kind AS kind, e.name AS name, e.parentId AS parent ORDER BY e.elementId`,
  );

  // `viewRelationsQuery` and `dependencyQuery` both build their own query
  // text per call (a literal shown-id list, or a literal hop bound and
  // time/state filter — see each's own doc for why a `$` parameter cannot
  // stand in for them here; tried again for `dependencyQuery`'s own
  // relationship-filter clause specifically, not only assumed from
  // `viewRelationsQuery`'s `list_filter` case — this build's binder refuses
  // it too, cleanly this time: `Binder exception: Cannot evaluate $_..._
  // because it does not depend on n or r`) — `conn.prepareSync` on the very
  // same text twice reprepares it from scratch, and this LadybugDB build
  // never frees a prepared statement's own share of the buffer pool on its
  // own (there is no `PreparedStatement.close`): asking it to reprepare
  // the same query text again and again, the ordinary case for an engine
  // answering the same shape of question repeatedly (a view kept open, an
  // agent polling the same dependents query), exhausted the pool outright
  // after a few hundred calls (tried and confirmed). Caching by the exact
  // query text — the same text can only ever mean the same statement —
  // keeps a repeated call to one bounded amount of memory instead.
  //
  // `dependencyQuery`'s own text embeds `valid`/`known` as literals (see
  // its own doc), so a caller that queries "now" through a clock that keeps
  // advancing (the ordinary case for an agent watching the graph, or for
  // `resolveTime`'s own default when no `at` is given) builds a distinct
  // query text on every single call, forever — an unbounded cache would
  // just move the same unbounded-growth problem from "reprepare every
  // call" to "cache every distinct text forever" instead of actually
  // bounding it. `preparedByText` is therefore a small LRU (insertion
  // order in a `Map` already gives this for free: a hit is deleted and
  // re-set to move it to the newest end, and the oldest entry — the map's
  // first key — is dropped once the cache grows past `PREPARED_CACHE_LIMIT`).
  // "Closed" on eviction can only mean dropping this module's own
  // reference, the same limit `close()`'s own doc already notes: this
  // build exposes no native release for a `PreparedStatement`, so an
  // evicted entry's native memory is reclaimed only once nothing else
  // reaches it, not synchronously — still strictly better than never
  // dropping the reference at all, which is what an unbounded cache did.
  const PREPARED_CACHE_LIMIT = 200;
  const preparedByText = new Map<string, PreparedStatement>();
  function cachedPrepare(text: string): PreparedStatement {
    const cached = preparedByText.get(text);
    if (cached !== undefined) {
      preparedByText.delete(text);
      preparedByText.set(text, cached);
      return cached;
    }
    const prepared = conn.prepareSync(text);
    preparedByText.set(text, prepared);
    if (preparedByText.size > PREPARED_CACHE_LIMIT) {
      const oldest = preparedByText.keys().next().value;
      if (oldest !== undefined) preparedByText.delete(oldest);
    }
    return prepared;
  }

  /**
   * `view`'s relation query needs the shown-id set *inside* a `list_filter`
   * lambda (to find, for each end, the nearest ancestor — itself included —
   * that is shown). A query parameter referenced from inside a lambda body
   * crashes this LadybugDB build's binder outright (tried and confirmed: an
   * `Assertion failed ... UNREACHABLE_CODE` panic, not a refused query, for
   * `list_filter(..., x -> list_contains($shownIds, x))` — a parameter used
   * directly, outside any lambda, works fine). So the shown-id set is
   * built into the query text as a literal list instead, cached (see
   * `cachedPrepare`) by that literal text; safe because every element id is
   * already restricted to `ID_PATTERN` (`schema.ts`: letters, digits, `.`,
   * `_`, `-`) by the model schema, so none can ever break out of a quoted
   * Cypher string literal — `literalIdList` still asserts that pattern
   * rather than trusting it silently, in case a row ever reached the engine
   * unvalidated.
   *
   * The query answers every relation this view could draw on its own, one
   * row each: its lifted pair, what it refines, and whether both its own
   * real ends (`f.elementId`/`t.elementId`) are drawn as themselves — an
   * end is its own lift exactly when it is in the shown-id set (the first
   * entry of `[X] + reverse(ancestors)` is `X` itself) or, with context,
   * when it is a neighbour itself (see `liftExpression`). A relation is
   * drawable when both its ends exist at this time, both lift into the
   * view, it crosses the scope's boundary (with context), and its lifted
   * ends differ (`inside-one-box`). With context, the crossing test comes
   * before the lifting, so only crossing relations are lifted at all.
   *
   * A refinement (`r.refines` naming another relation) is drawn on its own
   * only when both its own ends (not their lifted ancestors) are shown, or
   * when the relation it refines is not drawn in this view at all;
   * otherwise it is dropped and counted once under its general relation,
   * which already stands for it there (the owner's corrected reading of
   * `graph-queries/view`'s `refinement-counted-once` scenario: a
   * refinement whose own ends are still both hidden can lift to a pair
   * that differs from the general's, e.g. a service-level general relation
   * next to a still-more-specific module one; only "are the refinement's
   * own real ends shown" decides it). "The general relation is drawn here"
   * is exactly "it is drawable", the test every row already passed, so
   * `drawnRelations` decides it from these rows instead of the query
   * looking the general relation and its ends up again: those three
   * `OPTIONAL MATCH`es and their lifts made each view's query about three
   * times as slow to run whether or not any relation refines another
   * (measured: 21 ms against 6 ms a view on a 990-element model), which
   * kept rendering every view of a 1 000-element model over ten seconds.
   */
  function viewRelationsQuery(shownIds: readonly string[], context?: ViewContext): PreparedStatement {
    const shown = literalIdList(shownIds);
    const lift = (alias: string): string => liftExpression(alias, shown, context);
    // With context, a relation is drawn only when it has an end inside the
    // scope: one between two outside elements would otherwise lift to a
    // pair of neighbours, and the context shows only what crosses the
    // scope's boundary.
    const crosses = context === undefined ? '' : `WHERE ${insideScope('f', context)} OR ${insideScope('t', context)}`;
    return cachedPrepare(
      `MATCH (r:Relation) WHERE ${filterOf('r')}
       MATCH (f:Element) WHERE f.elementId = r.fromId AND ${filterOf('f')}
       MATCH (t:Element) WHERE t.elementId = r.toId AND ${filterOf('t')}
       WITH r, f, t ${crosses}
       WITH r, f, t, ${lift('f')} AS fLift, ${lift('t')} AS tLift
       WHERE size(fLift) > 0 AND size(tLift) > 0
       WITH r, fLift[1] AS fromId, tLift[1] AS toId, fLift[1] = f.elementId AND tLift[1] = t.elementId AS endsShown
       WHERE fromId <> toId
       RETURN DISTINCT r.relationId AS relationId, r.refines AS refines, fromId, toId, endsShown, r.fromId AS ownFrom, r.toId AS ownTo`,
    );
  }

  // Direction is the only difference between `dependents` and
  // `dependencies`: dependents walks other-elements-that-reach `x`,
  // dependencies walks `x`-reaches-other-elements. `SHORTEST` (not a plain
  // `*1..N` pattern matching every walk, and not `ALL SHORTEST`) is what
  // makes this the recursive Cypher traversal the owner's constraint asks
  // for actually answer on a realistic graph: a plain variable-length
  // pattern enumerates every walk up to `maxHops` hops, which explodes
  // combinatorially the moment the graph has any cycle at all (a `Buffer
  // manager exception: Unable to allocate memory!` from just ten nodes and
  // thirty edges with a cycle among them, tried and confirmed), and even
  // acyclic, revisits the same prefix once per continuation; `SHORTEST`
  // explores each node no more than its shortest distance from the start
  // and returns one shortest chain per reachable element, so it stays
  // polynomial on shapes `ALL SHORTEST` still chokes on: a layered graph
  // many ties deep (e.g. 1000 nodes wide, 10 layers, 37 000 relations —
  // `ALL SHORTEST` there enumerates every tied shortest path per node,
  // combinatorial in the layer width even though the *node* count visited
  // is not; `SHORTEST` returns exactly one row per node). Which one of
  // several equally short paths `SHORTEST` picks for a node is this
  // build's own unspecified choice among ties — not a choice this module
  // makes or a specific one it documents further: the requirement this
  // engine answers is one shortest chain for each reachable element, not a
  // particular one among equally short candidates, so this module never
  // claims a determinism it does not itself control. `bestChainById`
  // below still keeps its own deterministic tie-break (the
  // lexicographically least chain) rather than trusting the native row
  // order outright, the one part of "shape the rows into the answer" this
  // module can still promise on its own. The per-hop filter is threaded through the pattern's own
  // relationship-filter clause (`(r, n | WHERE ...)`), so a hop the time or
  // state filter rejects is pruned during the walk itself, not after
  // enumerating it — the one construct this build has ever accepted a
  // reference to the *per-hop* relationship variable from at all (a plain
  // `WHERE` after the pattern, or `all(x IN rels(p) WHERE ...)`, both see
  // only the finished path). `other.elementId <> $id` drops the one
  // remaining case a cycle can produce: the start reaching itself back
  // around, which must never count as its own dependent or dependency.
  // Both the hop bound and the per-hop filter's `valid`/`known`/`state`
  // must be literals here, not `$` parameters: a variable-length bound
  // parameter is refused outright (`Parser exception` on `*1..$maxHops`,
  // tried and confirmed), and a parameter referenced from inside the
  // relationship-filter lambda panics the binder the same way `filterOfLiteral`'s
  // own doc already found for `all(...)` — so the whole query is built
  // fresh per distinct `(direction, maxHops, valid, known, state)` and
  // cached by that text (`cachedPrepare`), from values this module computes
  // itself (`maxHops` clamped in `dependencyAnswer`, `state` checked by
  // `filterOfLiteral`), never from caller-supplied text.
  function dependencyQuery(direction: 'dependents' | 'dependencies', maxHops: number, valid: number, known: number, state: string): PreparedStatement {
    const hopFilter = `(r, n | WHERE ${filterOfLiteral('r', valid, known, state)})`;
    const pattern =
      direction === 'dependents'
        ? `(other:Anchor)-[r:RELATES_TO* SHORTEST 1..${maxHops} ${hopFilter}]->(start:Anchor {elementId: $id})`
        : `(start:Anchor {elementId: $id})-[r:RELATES_TO* SHORTEST 1..${maxHops} ${hopFilter}]->(other:Anchor)`;
    return cachedPrepare(
      `MATCH p = ${pattern}
       WHERE other.elementId <> $id
       RETURN other.elementId AS id, list_transform(rels(p), x -> x.relationId) AS chain`,
    );
  }

  /** Live state rows, tracked directly from `rebuild`/`update` (see `LiveStateRow`): resolving a query's default state is bookkeeping, not one of the owner's listed graph traversals. */
  let states: LiveStateRow[] = [];

  function reset(): void {
    conn.querySync('MATCH (e:Element) DELETE e');
    conn.querySync('MATCH (r:Relation) DELETE r');
    conn.querySync('MATCH ()-[r:RELATES_TO]->() DELETE r');
    conn.querySync('MATCH (a:Anchor) DELETE a');
    states = [];
  }

  function writeElement(row: { source: string; content: string; validFrom: number; validTo: number | null; recordedFrom: number; recordedTo: number | null }): void {
    const parsed = JSON.parse(row.content) as ElementContent;
    conn.executeSync(mergeAnchor, { elementId: parsed.id });
    conn.executeSync(insertElement, {
      pk: rowKey(row.source, 'element', parsed.id, row.validFrom, row.recordedFrom),
      elementId: parsed.id,
      kind: parsed.kind,
      name: parsed.name ?? null,
      parentId: parsed.parent ?? null,
      ancestors: parsed.ancestors,
      states: parsed.states,
      validFrom: row.validFrom,
      validTo: row.validTo,
      recordedFrom: row.recordedFrom,
      recordedTo: row.recordedTo,
      source: row.source,
    });
  }

  function writeRelation(row: { source: string; content: string; validFrom: number; validTo: number | null; recordedFrom: number; recordedTo: number | null }): void {
    const parsed = JSON.parse(row.content) as RelationContent;
    const pk = rowKey(row.source, 'relation', parsed.id, row.validFrom, row.recordedFrom);
    conn.executeSync(mergeAnchor, { elementId: parsed.from });
    conn.executeSync(mergeAnchor, { elementId: parsed.to });
    conn.executeSync(insertRelation, {
      pk,
      relationId: parsed.id,
      fromId: parsed.from,
      toId: parsed.to,
      refines: parsed.refines ?? null,
      states: parsed.states,
      validFrom: row.validFrom,
      validTo: row.validTo,
      recordedFrom: row.recordedFrom,
      recordedTo: row.recordedTo,
      source: row.source,
    });
    // No `refines` on the edge: `dependents`/`dependencies` walk every
    // relation, refinements included, and never need to reason about which
    // relation refines which (only `view` does — it reads `refines` off
    // the `Relation` node table instead, in `viewRelationsQuery`), so the
    // edge itself never needs to carry it.
    conn.executeSync(insertEdge, {
      pk,
      fromId: parsed.from,
      toId: parsed.to,
      relationId: parsed.id,
      states: parsed.states,
      validFrom: row.validFrom,
      validTo: row.validTo,
      recordedFrom: row.recordedFrom,
      recordedTo: row.recordedTo,
      source: row.source,
    });
  }

  function writeState(row: { source: string; content: string; validFrom: number; validTo: number | null; recordedFrom: number; recordedTo: number | null }): void {
    const parsed = JSON.parse(row.content) as StateContent;
    states.push({ source: row.source, id: parsed.id, after: parsed.after, validFrom: row.validFrom, validTo: row.validTo, recordedFrom: row.recordedFrom, recordedTo: row.recordedTo });
  }

  // `update`'s own "remove" is a close, never a delete (see `closeElement`'s
  // own doc): every one of these only ever touches the one row that can
  // still be current for this identity (`recordedTo IS NULL`, or — for
  // `states`, held as a plain array rather than a LadybugDB table — the
  // in-memory equivalent below), so a row `rebuild` would have already
  // closed on an earlier pass is left alone rather than closed a second
  // time or matched by mistake.
  function removeElement(source: string, id: string, validFrom: number, recordedTo: number): void {
    conn.executeSync(closeElement, { source, id, validFrom, recordedTo });
  }

  function removeRelation(source: string, id: string, validFrom: number, recordedTo: number): void {
    conn.executeSync(closeEdge, { source, id, validFrom, recordedTo });
    conn.executeSync(closeRelation, { source, id, validFrom, recordedTo });
  }

  function removeState(source: string, id: string, validFrom: number, recordedTo: number): void {
    states = states.map((s) => (s.source === source && s.id === id && s.validFrom === validFrom && s.recordedTo === null ? { ...s, recordedTo } : s));
  }

  // Every row is loaded, current or not: a row the history has since
  // closed (`recordedTo` set) is still exactly what a query with a `known`
  // time before that closing must see (the `as-of` requirement's known
  // axis) — loading only what is current today would make every such
  // historical `known` query behave as if `known` were always "now",
  // silently dropping the very axis this capability exists to answer.
  function rebuild(assertions: readonly AssertionRecord[]): void {
    reset();
    for (const row of assertions) {
      if (row.kind === 'element') writeElement(row);
      else if (row.kind === 'relation') writeRelation(row);
      else if (row.kind === 'state') writeState(row);
    }
  }

  // A closed row keeps both time axes going forward, never dropped: a
  // `known` time before this `update` still needs the row it replaces, the
  // very `as-of` known-axis requirement `rebuild`'s own doc already argues
  // from (see `rebuild`) — deleting it outright the moment `store()`
  // reports it closed would silently make every such historical `known`
  // query behave as if `known` were always "now" through `update`, even
  // though `rebuild` from the same history answers it correctly (tried and
  // confirmed: exactly this mismatch, before `AssertionChange` carried its
  // own `recordedFrom`/`recordedTo`). Every write below now uses the real
  // recorded times `store()` reports (`change.recordedFrom`/`recordedTo`)
  // rather than a guess.
  function update(opened: readonly AssertionChange[], closed: readonly AssertionChange[]): void {
    for (const change of closed) {
      const recordedTo = change.recordedTo ?? change.recordedFrom;
      if (change.kind === 'element') removeElement(change.source, change.id, change.validFrom, recordedTo);
      else if (change.kind === 'relation') removeRelation(change.source, change.id, change.validFrom, recordedTo);
      else if (change.kind === 'state') removeState(change.source, change.id, change.validFrom, recordedTo);
    }
    for (const change of opened) {
      const row = { source: change.source, content: change.content, validFrom: change.validFrom, validTo: change.validTo, recordedFrom: change.recordedFrom, recordedTo: change.recordedTo };
      if (change.kind === 'element') writeElement(row);
      else if (change.kind === 'relation') writeRelation(row);
      else if (change.kind === 'state') writeState(row);
    }
  }

  /**
   * Resolves `{ valid, known, state }`: `valid`/`known` default to the
   * clock this engine was created with (`LadybugEngineOptions.clock`,
   * `Date.now()` when none was given — the same default `HistoryStore`
   * itself uses when no clock is injected). A caller passes `at` explicitly
   * to ask about a time other than "now"; the engine's own tests, like the
   * history's, inject a fake clock instead of relying on this fallback.
   */
  function resolveTime(at: QueryTime | undefined): { time?: ResolvedTime; error?: QueryError } {
    const valid = at?.valid ?? clock.now();
    const known = at?.known ?? clock.now();
    if (at?.state !== undefined) {
      // Every state id the compiler ever produces satisfies `SAFE_ID` (the
      // model schema's own `ID_PATTERN`); a caller-given state that does
      // not is refused here, as a `QueryError`, rather than reaching
      // `dependents`/`dependencies` and throwing when `filterOfLiteral`
      // builds its query text — an error value, never an exception
      // escaping the public interface.
      if (!SAFE_ID.test(at.state)) return { error: { message: `"${at.state}" is not a state id this model could ever declare`, id: at.state } };
      return { time: { valid, known, state: at.state } };
    }

    const visible = states.filter((s) => s.validFrom <= valid && (s.validTo === null || s.validTo > valid) && s.recordedFrom <= known && (s.recordedTo === null || s.recordedTo > known));
    if (visible.length === 0) return { time: { valid, known, state: 'as-is' } };
    const root = chainRoot(visible);
    if (root === undefined) {
      // Names the states the query could pass explicitly instead (`at.state`
      // above already shows the same query answers once one is named): the
      // distinct state ids visible at this time, deduped the same way
      // `chainRoot` itself deduped them before finding them not to form one
      // chain, sorted by code point like every other id list this package
      // orders.
      const candidates = dedupeStateRows(visible)
        .map((s) => s.id)
        .sort(byCodePoint);
      return {
        error: {
          message: `the state chains disagree at this time; a query with no explicit state cannot choose one — pass one of: ${candidates.join(', ')}`,
          time: valid,
          states: candidates,
        },
      };
    }
    return { time: { valid, known, state: root } };
  }

  // `LbugValue` (a query row's field type) never includes `undefined` —
  // only `null` stands for an absent value here — so `row.name`/`row.parent`
  // are checked against `null` alone.
  function toElementAnswer(row: { id: unknown; kind: unknown; name: unknown; parent: unknown }): ElementAnswer {
    const answer: ElementAnswer = { id: row.id as string, kind: row.kind as string };
    if (row.name !== null) answer.name = row.name as string;
    if (row.parent !== null) answer.parent = row.parent as string;
    return answer;
  }

  function elementExists(id: string, time: ResolvedTime): boolean {
    const rows = rowsOf(conn.executeSync(existsQuery, { id, valid: time.valid, known: time.known, state: time.state }));
    return rows.length > 0;
  }

  /**
   * Runs one query's body, turning any exception the native binding throws
   * (a resource exhaustion, a build-specific panic — see `rowsOf`'s and
   * `viewRelationsQuery`'s own docs for cases already tried and confirmed)
   * into a `QueryError` instead of letting it escape the public interface:
   * the `B1` guarantee that `children`/`view`/`dependents`/`dependencies`
   * always answer with a value, never a thrown exception, whatever
   * LadybugDB itself does underneath.
   */
  function safely<T extends { error?: QueryError }>(run: () => T): T {
    try {
      return run();
    } catch (err) {
      return { error: { message: `the query engine could not answer: ${err instanceof Error ? err.message : String(err)}` } } as T;
    }
  }

  function children(elementId: string, at?: QueryTime): ChildrenResult {
    return safely(() => {
      const { time, error } = resolveTime(at);
      if (error !== undefined) return { error };
      if (!elementExists(elementId, time!)) return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: time!.valid } };

      const rows = rowsOf(conn.executeSync(childrenQuery, { id: elementId, valid: time!.valid, known: time!.known, state: time!.state }));
      return { elements: rows.map((row) => toElementAnswer(row as never)) };
    });
  }

  function view(input: ViewInput, at?: QueryTime): ViewResult {
    return safely(() => {
      const { time, error } = resolveTime(at);
      if (error !== undefined) return { error };
      const t = time!;

      // Depth 0 means the scope alone (or the roots alone, unscoped);
      // depth n adds n levels below it (`ViewInput.depth`'s own doc). An
      // element's own ancestor-chain length already counts levels below
      // the root the same way (a root has 0 ancestors, its own children
      // have 1, ...), so subtracting the scope's own ancestor-chain length
      // — not one more than it, an earlier reading of this coordinator's
      // that counted the scope's own immediate children as depth 0 too,
      // wrongly showing one extra level under a scope — lines the origin
      // up on the scope itself: the scope's own `size(ancestors) -
      // scopeDepth` is then 0, always `<= depth` regardless of `depth`,
      // and each level below it adds exactly 1. Left at 0 when unscoped,
      // so a root (0 ancestors) is already `<= depth` at `depth: 0` the
      // same way.
      let scopeDepth = 0;
      let context: ViewContext | undefined;
      if (input.scope !== undefined) {
        if (!elementExists(input.scope, t)) return { error: { message: `"${input.scope}" does not exist at this time`, id: input.scope, time: t.valid } };
        const rows = rowsOf(conn.executeSync(scopeAncestorsQuery, { id: input.scope, valid: t.valid, known: t.known, state: t.state }));
        const scopeAncestors = (rows[0]?.ancestors as string[] | undefined) ?? [];
        scopeDepth = scopeAncestors.length;
        // Without a scope there is nothing outside, so `context` is only
        // ever honoured here; the answer then carries `neighbours`, and a
        // view asked without it keeps exactly its earlier shape.
        if (input.context === true) context = { scope: input.scope, scopeAncestors };
      }

      const hasScope = input.scope !== undefined;
      const shownRows = rowsOf(
        conn.executeSync(shownQuery, { valid: t.valid, known: t.known, state: t.state, scopeDepth, depth: input.depth, hasScope, scope: input.scope ?? '' }),
      );
      const elements = shownRows.map((row) => toElementAnswer(row as never));
      const shownIds = elements.map((e) => e.id);

      const relationRows = rowsOf(conn.executeSync(viewRelationsQuery(shownIds, context), { valid: t.valid, known: t.known, state: t.state }));
      const relations = drawnRelations(relationRows, context === undefined ? undefined : { scope: context.scope, shown: new Set(shownIds) });
      if (context === undefined) return { elements, relations };

      // Every end a crossing relation was drawn to that is not shown is a
      // neighbour. Each is an ancestor (or itself) of a relation's end that
      // exists at this time, but an ancestor declared by another source can
      // be absent then; that is an error naming it, never a neighbour
      // silently left out while a relation is still drawn to it.
      const shownSet = new Set(shownIds);
      const relationIdsByNeighbour = new Map<string, string[]>();
      for (const relation of relations) {
        for (const end of [relation.from, relation.to]) {
          if (!shownSet.has(end)) relationIdsByNeighbour.set(end, [...(relationIdsByNeighbour.get(end) ?? []), ...relation.relationIds]);
        }
      }
      const neighbourIds = [...relationIdsByNeighbour.keys()].sort(byCodePoint);
      const neighbours = rowsOf(conn.executeSync(elementsByIdQuery, { ids: neighbourIds, valid: t.valid, known: t.known, state: t.state })).map((row) => toElementAnswer(row as never));
      const found = new Set(neighbours.map((e) => e.id));
      const missing = neighbourIds.find((id) => !found.has(id));
      if (missing !== undefined) {
        const behind = [...relationIdsByNeighbour.get(missing)!].sort(byCodePoint).join(', ');
        return { error: { message: `"${missing}", the neighbour the relations ${behind} are drawn to or from, does not exist at this time`, id: missing, time: t.valid } };
      }
      return { elements, neighbours, relations };
    });
  }

  /** Compares two relation-id chains the same deterministic way as every other sort in this package: code point, entry by entry, a shorter chain that is a prefix of a longer one sorting first. */
  function compareChains(a: readonly string[], b: readonly string[]): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const cmp = byCodePoint(a[i]!, b[i]!);
      if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
  }

  function dependencyAnswer(elementId: string, options: DependenciesInput, at: QueryTime | undefined, direction: 'dependents' | 'dependencies'): DependenciesResult {
    return safely(() => {
      const { time, error } = resolveTime(at);
      if (error !== undefined) return { error };
      if (!elementExists(elementId, time!)) return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: time!.valid } };

      const maxHops = options.transitive === true ? Math.min(MAX_HOPS_CEILING, Math.max(1, options.maxHops ?? MAX_HOPS_CEILING)) : 1;
      const query = dependencyQuery(direction, maxHops, time!.valid, time!.known, time!.state);
      const rows = rowsOf(conn.executeSync(query, { id: elementId }));

      // `SHORTEST` already returns one row per reachable element (see
      // `dependencyQuery`'s own doc); `bestChainById` still folds by id and
      // keeps the lexicographically least chain on a tie, rather than
      // trusting that "one row per element" outright, so the answer never
      // depends on this build's own unspecified choice among equally short
      // paths even if more than one row for an element ever did surface.
      const bestChainById = new Map<string, string[]>();
      for (const row of rows) {
        const id = row.id as string;
        const chain = row.chain as string[];
        const existing = bestChainById.get(id);
        if (existing === undefined || compareChains(chain, existing) < 0) bestChainById.set(id, chain);
      }
      const elements = [...bestChainById.entries()]
        .sort(([a], [b]) => byCodePoint(a, b))
        .map(([id, chain]) => ({ id, chain }));
      return { elements };
    });
  }

  function dependents(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult {
    return dependencyAnswer(elementId, options, at, 'dependents');
  }

  function dependencies(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult {
    return dependencyAnswer(elementId, options, at, 'dependencies');
  }

  function close(): void {
    // This LadybugDB build exposes no way to release a `PreparedStatement`
    // on its own; dropping every reference here at least lets them (and
    // whatever native memory they hold) be collected once nothing outside
    // this closure can reach them any more, rather than living as long as
    // the process — the closest this cache can come to "closed in
    // `close()`" without a native call to make.
    preparedByText.clear();
    cacheSizeByEngine.delete(engine);
    conn.closeSync();
    db.closeSync();
  }

  const engine: QueryEngine = { children, view, dependents, dependencies, rebuild, update, close };
  cacheSizeByEngine.set(engine, () => preparedByText.size);
  return engine;
}

/**
 * The prepared-statement cache's own current size, for the one test that
 * needs to observe it staying bounded (`PREPARED_CACHE_LIMIT` — see
 * `cachedPrepare`'s own doc): not part of `QueryEngine`, and never
 * something the model, compiler or query logic itself reads — a bounded
 * cache's own size is an implementation detail of this one adapter, not a
 * capability this package's public interface has any reason to expose.
 */
const cacheSizeByEngine = new WeakMap<QueryEngine, () => number>();
export function preparedStatementCacheSizeForTests(engine: QueryEngine): number {
  return cacheSizeByEngine.get(engine)?.() ?? 0;
}
