import lbug from '@ladybugdb/core';
import type { LbugValue, PreparedStatement, QueryResult } from '@ladybugdb/core';
import type { AssertionChange, AssertionRecord } from '../history/types.js';
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
  ViewResult,
} from '../query/types.js';

const { Database, Connection } = lbug;

/** `Connection.executeSync` returns one `QueryResult`, or an array when the statement is a batch of several — this module always executes one statement, so the array case never arises in practice; the helper still narrows it defensively rather than asserting it away. */
function rowsOf(result: QueryResult | QueryResult[]): Record<string, LbugValue>[] {
  const single = Array.isArray(result) ? result[result.length - 1] : result;
  return single === undefined ? [] : single.getAllSync();
}

/**
 * How far a transitive search follows the relation graph when `maxHops` is
 * left out, and the hard ceiling any caller-given `maxHops` is clamped to:
 * this LadybugDB build refuses a recursive relationship pattern whose upper
 * bound exceeds 30 (`Binder exception: Upper bound of rel r exceeds
 * maximum: 30`, tried and confirmed) — not a limit this module chose, but
 * the engine's own.
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
  for (const id of ids) {
    if (!SAFE_ID.test(id)) throw new Error(`refusing to build a query around an id outside the model's own id pattern: ${JSON.stringify(id)}`);
  }
  return `[${ids.map((id) => `'${id}'`).join(', ')}]`;
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
 * The chain's first state — the query default (design.md: "Readings
 * decided during the run") — or `undefined` when the states visible at the
 * asked time do not form one chain (`isOneStateChain`, the same check
 * `assembleCompiledModel` in `history/assertions.ts` uses for the union
 * read's own chain-wide discrepancy). A chain's one root is the one state
 * naming no `after`; `isOneStateChain` having already confirmed there is
 * exactly one such state and that every state is reached from it makes
 * finding it here just `find`, not a second walk of the chain.
 */
function chainRoot(states: readonly { id: string; after?: string }[]): string | undefined {
  if (!isOneStateChain(states)) return undefined;
  return states.find((s) => s.after === undefined)?.id;
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
 *   multi-hop `dependents`/`dependencies` walk can filter every hop with
 *   `all(x IN rels(p) WHERE ...)` — the recursive Cypher traversal the
 *   owner's constraint asks for (see stage3-brief.md).
 *
 * `view`'s own traversal (lifting each relation's ends to the nearest
 * *shown* ancestor, merging per shown pair, dropping a relation whose ends
 * land on the same shown element, and leaving refinements out since their
 * general relation already stands for them) needs no multi-hop walk at
 * all: with `ancestors` already a precomputed, ordered list, "the nearest
 * shown ancestor of X" is simply the first entry of `[X] + reverse(X's
 * ancestors)` that is a member of the shown set — a single Cypher
 * `list_filter` over already-materialized data, still every bit "a
 * LadybugDB Cypher query" (see `viewQuery`).
 *
 * `interfaces`, `categories`, `zones` and `environments` carry nothing this
 * capability's five requirements ever query (per-environment queries are
 * explicitly out of the graph-queries capability's coverage), so they are
 * not modeled here at all — only elements, relations and (for resolving a
 * query's default state) states.
 */
export function createLadybugEngine(): QueryEngine {
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
  // Deletes by identity, not by `pk`: `pk` now includes `recordedFrom` (see
  // `rowKey`'s own comment), which `update`'s `AssertionChange` never
  // carries — `recordedTo IS NULL` picks out the one row that can ever be
  // open for this `(source, elementId, validFrom)` at once instead.
  const deleteElement = conn.prepareSync(`MATCH (e:Element) WHERE e.source = $source AND e.elementId = $id AND e.validFrom = $validFrom AND e.recordedTo IS NULL DELETE e`);
  const insertRelation = conn.prepareSync(
    `CREATE (r:Relation {pk: $pk, relationId: $relationId, fromId: $fromId, toId: $toId, refines: $refines, states: $states, validFrom: $validFrom, validTo: $validTo, recordedFrom: $recordedFrom, recordedTo: $recordedTo, source: $source})`,
  );
  const deleteRelation = conn.prepareSync(
    `MATCH (r:Relation) WHERE r.source = $source AND r.relationId = $id AND r.validFrom = $validFrom AND r.recordedTo IS NULL DELETE r`,
  );
  const mergeAnchor = conn.prepareSync(`MERGE (a:Anchor {elementId: $elementId})`);
  const insertEdge = conn.prepareSync(
    `MATCH (f:Anchor {elementId: $fromId}), (t:Anchor {elementId: $toId})
     CREATE (f)-[:RELATES_TO {pk: $pk, relationId: $relationId, states: $states, validFrom: $validFrom, validTo: $validTo, recordedFrom: $recordedFrom, recordedTo: $recordedTo, source: $source}]->(t)`,
  );
  const deleteEdge = conn.prepareSync(
    `MATCH ()-[r:RELATES_TO]->() WHERE r.source = $source AND r.relationId = $id AND r.validFrom = $validFrom AND r.recordedTo IS NULL DELETE r`,
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
  /**
   * `view`'s relation query needs the shown-id set *inside* a `list_filter`
   * lambda (to find, for each end, the nearest ancestor — itself included —
   * that is shown). A query parameter referenced from inside a lambda body
   * crashes this LadybugDB build's binder outright (tried and confirmed: an
   * `Assertion failed ... UNREACHABLE_CODE` panic, not a refused query, for
   * `list_filter(..., x -> list_contains($shownIds, x))` — a parameter used
   * directly, outside any lambda, works fine). So the shown-id set is
   * built into the query text as a literal list instead, one prepared
   * statement per `view` call; safe because every element id is already
   * restricted to `ID_PATTERN` (`schema.ts`: letters, digits, `.`, `_`,
   * `-`) by the model schema, so none can ever break out of a quoted Cypher
   * string literal — `literalIdList` still asserts that pattern rather than
   * trusting it silently, in case a row ever reached the engine unvalidated.
   */
  function viewRelationsQuery(shownIds: readonly string[]): PreparedStatement {
    return conn.prepareSync(
      `MATCH (r:Relation), (f:Element), (t:Element)
       WHERE r.refines IS NULL AND ${filterOf('r')}
         AND f.elementId = r.fromId AND ${filterOf('f')}
         AND t.elementId = r.toId AND ${filterOf('t')}
       WITH r,
            list_filter([f.elementId] + list_reverse(f.ancestors), x -> list_contains(${literalIdList(shownIds)}, x)) AS fLift,
            list_filter([t.elementId] + list_reverse(t.ancestors), x -> list_contains(${literalIdList(shownIds)}, x)) AS tLift
       WHERE size(fLift) > 0 AND size(tLift) > 0
       WITH fLift[1] AS liftedFrom, tLift[1] AS liftedTo, r
       WHERE liftedFrom <> liftedTo
       RETURN liftedFrom AS fromId, liftedTo AS toId, collect(DISTINCT r.relationId) AS relationIds
       ORDER BY fromId, toId`,
    );
  }
  // Direction is the only difference between `dependents` and
  // `dependencies`: dependents walks other-elements-that-reach `x`,
  // dependencies walks `x`-reaches-other-elements. Every hop of the walk
  // itself is filtered by time and state (`all(x IN rels(p) WHERE ...)`),
  // the recursive Cypher traversal the owner's constraint asks for. Both the
  // hop bound (`*1..N`) and the per-hop filter's `valid`/`known`/`state`
  // must be literals here, not `$` parameters: a variable-length bound
  // parameter is refused outright (`Parser exception` on `*1..$maxHops`,
  // tried and confirmed), and a parameter referenced from inside the
  // `all(...)` lambda panics the binder (see `filterOfLiteral`'s own
  // comment) — so the whole query is built fresh per call, from values this
  // module computes itself (`maxHops` clamped in `dependencyAnswer`,
  // `state` checked by `filterOfLiteral`), never from caller-supplied text.
  function dependencyQuery(direction: 'dependents' | 'dependencies', maxHops: number, valid: number, known: number, state: string): PreparedStatement {
    const pattern =
      direction === 'dependents'
        ? `(other:Anchor)-[r:RELATES_TO*1..${maxHops}]->(start:Anchor {elementId: $id})`
        : `(start:Anchor {elementId: $id})-[r:RELATES_TO*1..${maxHops}]->(other:Anchor)`;
    // The intermediate `ORDER BY` (shortest hop count first, so the
    // `collect` right after keeps only the shortest chain per element) must
    // be followed by a `LIMIT` inside a `WITH` clause in this Cypher
    // dialect (`Binder exception: In WITH clause, ORDER BY must be followed
    // by SKIP or LIMIT`, tried and confirmed) — the limit itself is not
    // meaningful (there are at most `MAX_HOPS_CEILING` rows per element
    // anyway), only large enough to never actually cut anything off.
    return conn.prepareSync(
      `MATCH p = ${pattern}
       WHERE all(x IN rels(p) WHERE ${filterOfLiteral('x', valid, known, state)})
       WITH other.elementId AS id, list_transform(rels(p), x -> x.relationId) AS chain, length(p) AS hops
       ORDER BY hops ASC LIMIT 100000000
       WITH id, collect(chain)[1] AS chain
       RETURN id, chain ORDER BY id`,
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
    // relation, refinements included (the view is the only place a
    // refinement is ever excluded — see `viewRelationsQuery`'s own `WHERE
    // r.refines IS NULL`, which reads it off the `Relation` node table
    // instead), so the edge itself never needs to carry it.
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

  function removeElement(source: string, id: string, validFrom: number): void {
    conn.executeSync(deleteElement, { source, id, validFrom });
  }

  function removeRelation(source: string, id: string, validFrom: number): void {
    conn.executeSync(deleteEdge, { source, id, validFrom });
    conn.executeSync(deleteRelation, { source, id, validFrom });
  }

  function removeState(source: string, id: string, validFrom: number): void {
    states = states.filter((s) => !(s.source === source && s.id === id && s.validFrom === validFrom));
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

  function update(opened: readonly AssertionChange[], closed: readonly AssertionChange[]): void {
    for (const change of closed) {
      if (change.kind === 'element') removeElement(change.source, change.id, change.validFrom);
      else if (change.kind === 'relation') removeRelation(change.source, change.id, change.validFrom);
      else if (change.kind === 'state') removeState(change.source, change.id, change.validFrom);
    }
    for (const change of opened) {
      const row = { source: change.source, content: change.content, validFrom: change.validFrom, validTo: change.validTo, recordedFrom: 0, recordedTo: null };
      // `recordedFrom` for a row opened just now is "now", which the
      // engine has no clock of its own to read (design.md: it is built
      // from the history, never runs its own clock) — the caller always
      // follows `update` with queries at `known` times at or after this
      // moment, so 0 (the smallest possible) is always <= any `known` a
      // query could sensibly ask, and `recordedTo: null` (still current)
      // is exactly what `opened` reports.
      if (change.kind === 'element') writeElement(row);
      else if (change.kind === 'relation') writeRelation(row);
      else if (change.kind === 'state') writeState(row);
    }
  }

  /**
   * Resolves `{ valid, known, state }`: times default to the clock's
   * current moment... but the engine has no clock (it is derived, purely
   * from what `rebuild`/`update` gave it) — `valid`/`known` default to the
   * caller's own "now" when left out, so a caller passes it explicitly.
   * Left out entirely, `Date.now()` is used, matching `HistoryStore`'s own
   * default when no clock is injected — the engine's tests, like the
   * history's, inject a fake clock's reading through `at` instead of
   * relying on this fallback.
   */
  function resolveTime(at: QueryTime | undefined): { time?: ResolvedTime; error?: QueryError } {
    const valid = at?.valid ?? Date.now();
    const known = at?.known ?? Date.now();
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
      return { error: { message: 'the state chains disagree at this time; a query with no explicit state cannot choose one', time: valid } };
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

  function children(elementId: string, at?: QueryTime): ChildrenResult {
    const { time, error } = resolveTime(at);
    if (error !== undefined) return { error };
    if (!elementExists(elementId, time!)) return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: time!.valid } };

    const rows = rowsOf(conn.executeSync(childrenQuery, { id: elementId, valid: time!.valid, known: time!.known, state: time!.state }));
    return { elements: rows.map((row) => toElementAnswer(row as never)) };
  }

  function view(input: ViewInput, at?: QueryTime): ViewResult {
    const { time, error } = resolveTime(at);
    if (error !== undefined) return { error };
    const t = time!;

    let scopeDepth = 0;
    if (input.scope !== undefined) {
      if (!elementExists(input.scope, t)) return { error: { message: `"${input.scope}" does not exist at this time`, id: input.scope, time: t.valid } };
      const rows = rowsOf(conn.executeSync(scopeAncestorsQuery, { id: input.scope, valid: t.valid, known: t.known, state: t.state }));
      scopeDepth = ((rows[0]?.ancestors as string[] | undefined)?.length ?? 0) + 1;
    }

    const hasScope = input.scope !== undefined;
    const shownRows = rowsOf(
      conn.executeSync(shownQuery, { valid: t.valid, known: t.known, state: t.state, scopeDepth, depth: input.depth, hasScope, scope: input.scope ?? '' }),
    );
    const elements = shownRows.map((row) => toElementAnswer(row as never));
    const shownIds = elements.map((e) => e.id);

    const relationRows = rowsOf(conn.executeSync(viewRelationsQuery(shownIds), { valid: t.valid, known: t.known, state: t.state }));
    const relations = relationRows.map((row) => ({
      from: row.fromId as string,
      to: row.toId as string,
      relationIds: [...(row.relationIds as string[])].sort(byCodePoint),
    }));

    return { elements, relations };
  }

  function dependencyAnswer(elementId: string, options: DependenciesInput, at: QueryTime | undefined, direction: 'dependents' | 'dependencies'): DependenciesResult {
    const { time, error } = resolveTime(at);
    if (error !== undefined) return { error };
    if (!elementExists(elementId, time!)) return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: time!.valid } };

    const maxHops = options.transitive === true ? Math.min(MAX_HOPS_CEILING, Math.max(1, options.maxHops ?? MAX_HOPS_CEILING)) : 1;
    const query = dependencyQuery(direction, maxHops, time!.valid, time!.known, time!.state);
    const rows = rowsOf(conn.executeSync(query, { id: elementId }));
    return { elements: rows.map((row) => ({ id: row.id as string, chain: row.chain as string[] })) };
  }

  function dependents(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult {
    return dependencyAnswer(elementId, options, at, 'dependents');
  }

  function dependencies(elementId: string, options: DependenciesInput, at?: QueryTime): DependenciesResult {
    return dependencyAnswer(elementId, options, at, 'dependencies');
  }

  function close(): void {
    conn.closeSync();
    db.closeSync();
  }

  return { children, view, dependents, dependencies, rebuild, update, close };
}
