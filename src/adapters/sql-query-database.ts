import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssertionChange, AssertionRecord, Clock } from '../history/types.js';
import { isOneStateChain } from '../history/assertions.js';
import { byCodePoint } from '../model/order.js';
import { createOperationGate } from '../query/operation-gate.js';
import type {
  AsyncQueryDatabase,
  AsyncQueryEngine,
  ChildrenResult,
  DependenciesInput,
  DependenciesResult,
  ElementAnswer,
  QueryError,
  QuerySnapshot,
  QueryTime,
  ViewInput,
  ViewRelation,
  ViewResult,
} from '../query/types.js';
import type { SqlExecutor, SqlQueryDriver } from '../query/sql-driver.js';

const MAX_HOPS_CEILING = 30;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS query_elements (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    parent TEXT,
    ancestors TEXT[] NOT NULL,
    states TEXT[] NOT NULL,
    valid_from DOUBLE PRECISION NOT NULL,
    valid_to DOUBLE PRECISION,
    recorded_from DOUBLE PRECISION NOT NULL,
    recorded_to DOUBLE PRECISION,
    PRIMARY KEY (source, id, valid_from, recorded_from)
  )`,
  `CREATE INDEX IF NOT EXISTS query_elements_source_time ON query_elements
    (source, valid_from, valid_to, recorded_from, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS query_elements_source_parent ON query_elements (source, parent)`,
  `CREATE TABLE IF NOT EXISTS query_relations (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    refines TEXT,
    states TEXT[] NOT NULL,
    valid_from DOUBLE PRECISION NOT NULL,
    valid_to DOUBLE PRECISION,
    recorded_from DOUBLE PRECISION NOT NULL,
    recorded_to DOUBLE PRECISION,
    PRIMARY KEY (source, id, valid_from, recorded_from)
  )`,
  `CREATE INDEX IF NOT EXISTS query_relations_source_from_time ON query_relations
    (source, from_id, valid_from, valid_to, recorded_from, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS query_relations_source_to_time ON query_relations
    (source, to_id, valid_from, valid_to, recorded_from, recorded_to)`,
  `CREATE TABLE IF NOT EXISTS query_states (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    after_id TEXT,
    valid_from DOUBLE PRECISION NOT NULL,
    valid_to DOUBLE PRECISION,
    recorded_from DOUBLE PRECISION NOT NULL,
    recorded_to DOUBLE PRECISION,
    PRIMARY KEY (source, id, valid_from, recorded_from)
  )`,
  `CREATE INDEX IF NOT EXISTS query_states_source_time ON query_states
    (source, valid_from, valid_to, recorded_from, recorded_to)`,
] as const;

export interface SqlQueryDatabaseOptions {
  /** Supplies the default `valid` and `known` time for queries. */
  clock?: Clock;
}

interface ElementContent {
  id: string;
  kind: string;
  name?: string | null;
  parent?: string | null;
  ancestors: string[];
  states: string[];
}

interface RelationContent {
  id: string;
  from: string;
  to: string;
  refines?: string | null;
  states: string[];
}

interface StateContent {
  id: string;
  after?: string | null;
}

interface PreparedRows {
  elements: unknown[][];
  relations: unknown[][];
  states: unknown[][];
}

interface ElementRow extends Record<string, unknown> {
  source: string;
  id: string;
  kind: string;
  name: string | null;
  parent: string | null;
  ancestors: string[];
  states: string[];
}

interface RelationRow extends Record<string, unknown> {
  source: string;
  id: string;
  from_id: string;
  to_id: string;
  refines: string | null;
  states: string[];
}

interface StateRow extends Record<string, unknown> {
  id: string;
  after_id: string | null;
}

interface ResolvedTime {
  valid: number;
  known: number;
  state: string;
}

interface LiveState {
  id: string;
  after?: string;
}

interface ViewContext {
  scope: string;
  scopeAncestors: string[];
}

interface DrawableRelation {
  relationId: string;
  refines: string | null;
  fromId: string;
  toId: string;
  endsShown: boolean;
  ownFrom: string;
  ownTo: string;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`the query projection requires ${field} to be a string`);
  return value;
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`the query projection requires ${field} to be a string when present`);
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`the query projection requires ${field} to be a list of strings`);
  }
  return value;
}

function parseContent<T extends { id: string }>(record: AssertionRecord | AssertionChange): T {
  const parsed: unknown = JSON.parse(record.content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the ${record.kind} assertion "${record.id}" is not a JSON object`);
  }
  const content = parsed as Record<string, unknown>;
  if (content.id !== record.id) throw new Error(`the ${record.kind} assertion id "${record.id}" does not match its content id`);
  return content as T;
}

function preparedRows(records: readonly (AssertionRecord | AssertionChange)[]): PreparedRows {
  const result: PreparedRows = { elements: [], relations: [], states: [] };
  for (const record of records) {
    if (record.kind === 'element') {
      const content = parseContent<ElementContent>(record);
      result.elements.push([
        record.source,
        record.id,
        readString(content.kind, 'element.kind'),
        readOptionalString(content.name, 'element.name'),
        readOptionalString(content.parent, 'element.parent'),
        readStringArray(content.ancestors, 'element.ancestors'),
        readStringArray(content.states, 'element.states'),
        record.validFrom,
        record.validTo,
        record.recordedFrom,
        record.recordedTo,
      ]);
    } else if (record.kind === 'relation') {
      const content = parseContent<RelationContent>(record);
      result.relations.push([
        record.source,
        record.id,
        readString(content.from, 'relation.from'),
        readString(content.to, 'relation.to'),
        readOptionalString(content.refines, 'relation.refines'),
        readStringArray(content.states, 'relation.states'),
        record.validFrom,
        record.validTo,
        record.recordedFrom,
        record.recordedTo,
      ]);
    } else if (record.kind === 'state') {
      const content = parseContent<StateContent>(record);
      result.states.push([
        record.source,
        record.id,
        readOptionalString(content.after, 'state.after'),
        record.validFrom,
        record.validTo,
        record.recordedFrom,
        record.recordedTo,
      ]);
    }
  }
  return result;
}

async function insertRows(executor: SqlExecutor, table: string, columns: readonly string[], rows: readonly unknown[][]): Promise<void> {
  const chunkSize = Math.floor(60_000 / columns.length);
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    }).join(', ')})`);
    await executor.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
  }
}

function dedupeStateRows(states: readonly LiveState[]): LiveState[] {
  const seen = new Map<string, LiveState>();
  for (const state of states) {
    const key = `${state.id}\u0000${state.after ?? ''}`;
    if (!seen.has(key)) seen.set(key, state);
  }
  return [...seen.values()];
}

function stateChainRoot(states: readonly LiveState[]): string | undefined {
  const unique = dedupeStateRows(states);
  if (!isOneStateChain(unique)) return undefined;
  return unique.find((state) => state.after === undefined)?.id;
}

function compareChains(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const compared = byCodePoint(a[i]!, b[i]!);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

function answerElement(row: Pick<ElementRow, 'id' | 'kind' | 'name' | 'parent'>): ElementAnswer {
  const result: ElementAnswer = { id: row.id, kind: row.kind };
  if (row.name !== null) result.name = row.name;
  if (row.parent !== null) result.parent = row.parent;
  return result;
}

function activeFilter(alias: string, validParam: string, knownParam: string): string {
  return `${alias}.valid_from <= ${validParam} AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${validParam}) AND ${alias}.recorded_from <= ${knownParam} AND (${alias}.recorded_to IS NULL OR ${alias}.recorded_to > ${knownParam})`;
}

function drawnRelations(rows: readonly DrawableRelation[], context?: { scope: string; shown: ReadonlySet<string> }): ViewRelation[] {
  const byId = new Map(rows.map((row) => [row.relationId, row]));
  const replaced = new Set<string>();
  if (context !== undefined) {
    const below = (id: string): boolean => id !== context.scope && context.shown.has(id);
    for (const row of rows) {
      const general = row.refines === null ? undefined : byId.get(row.refines);
      if (general === undefined) continue;
      if ((general.fromId === context.scope && below(row.ownFrom)) || (general.toId === context.scope && below(row.ownTo))) {
        replaced.add(general.relationId);
      }
    }
  }
  const drawable = (id: string): boolean => byId.has(id) && !replaced.has(id);
  const pairs = new Map<string, ViewRelation>();
  for (const row of rows) {
    if (replaced.has(row.relationId)) continue;
    if (row.refines !== null && !row.endsShown && drawable(row.refines)) continue;
    const key = JSON.stringify([row.fromId, row.toId]);
    const pair = pairs.get(key) ?? { from: row.fromId, to: row.toId, relationIds: [] };
    if (!pair.relationIds.includes(row.relationId)) pair.relationIds.push(row.relationId);
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to))
    .map((pair) => ({ from: pair.from, to: pair.to, relationIds: pair.relationIds.sort(byCodePoint) }));
}

function sourceTable(kind: string): { table: string; idColumn: string } | undefined {
  if (kind === 'element') return { table: 'query_elements', idColumn: 'id' };
  if (kind === 'relation') return { table: 'query_relations', idColumn: 'id' };
  if (kind === 'state') return { table: 'query_states', idColumn: 'id' };
  return undefined;
}

function assertRecordScope(record: AssertionRecord | AssertionChange, sources: ReadonlySet<string>): void {
  if (!sources.has(record.source)) throw new Error(`assertion source "${record.source}" is outside this graph query scope`);
}

export async function createSqlQueryDatabase(driver: SqlQueryDriver, options: SqlQueryDatabaseOptions = {}): Promise<AsyncQueryDatabase> {
  try {
    await driver.transaction('write', async (executor) => {
      for (const statement of SCHEMA) await executor.query(statement);
    });
  } catch (error) {
    await driver.close().catch(() => {});
    throw error;
  }

  const clock = options.clock ?? { now: () => Date.now() };
  const gate = createOperationGate({ allowConcurrentSnapshots: driver.allowConcurrentSnapshots });
  const snapshotContext = new AsyncLocalStorage<object>();
  const ownerToken = {};
  let ownerClosing = false;
  let ownerClosed = false;
  let ownerClosePromise: Promise<void> | undefined;
  const scopes = new Set<{ ownerClosed(): void }>();

  function ensureOutsideSnapshot(): void {
    if (snapshotContext.getStore() === ownerToken) {
      throw new Error('do not call the query engine from inside withSnapshot; use the supplied snapshot reader');
    }
  }

  function ensureOwnerOpen(): void {
    if (ownerClosing || ownerClosed) throw new Error('the query database is closed');
  }

  function makeEngine(sourceInput: readonly string[]): AsyncQueryEngine {
    ensureOwnerOpen();
    const sources = [...new Set(sourceInput)].sort(byCodePoint);
    const sourceSet = new Set(sources);
    const active = new Set<Promise<unknown>>();
    let scopeClosing = false;
    let scopeClosed = false;
    let scopeClosePromise: Promise<void> | undefined;

    function ensureScopeOpen(): void {
      ensureOwnerOpen();
      if (scopeClosing || scopeClosed) throw new Error('the query engine is closed');
    }

    function track<T>(work: () => Promise<T>): Promise<T> {
      const promise = work();
      active.add(promise);
      void promise.then(() => active.delete(promise), () => active.delete(promise));
      return promise;
    }

    async function replaceSources(executor: SqlExecutor): Promise<void> {
      if (sources.length === 0) return;
      await executor.query('DELETE FROM query_elements WHERE source = ANY($1::text[])', [sources]);
      await executor.query('DELETE FROM query_relations WHERE source = ANY($1::text[])', [sources]);
      await executor.query('DELETE FROM query_states WHERE source = ANY($1::text[])', [sources]);
    }

    async function insertPrepared(executor: SqlExecutor, rows: PreparedRows): Promise<void> {
      await insertRows(executor, 'query_elements', ['source', 'id', 'kind', 'name', 'parent', 'ancestors', 'states', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to'], rows.elements);
      await insertRows(executor, 'query_relations', ['source', 'id', 'from_id', 'to_id', 'refines', 'states', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to'], rows.relations);
      await insertRows(executor, 'query_states', ['source', 'id', 'after_id', 'valid_from', 'valid_to', 'recorded_from', 'recorded_to'], rows.states);
    }

    async function closeChanges(executor: SqlExecutor, changes: readonly AssertionChange[]): Promise<void> {
      for (const change of changes) {
        assertRecordScope(change, sourceSet);
        const target = sourceTable(change.kind);
        if (target === undefined) continue;
        if (change.recordedTo === null) throw new Error(`closed ${change.kind} assertion "${change.id}" has no recordedTo time`);
        const changed = await executor.query<{ id: string }>(
          `UPDATE ${target.table} SET recorded_to = $1 WHERE source = $2 AND ${target.idColumn} = $3 AND valid_from = $4 AND recorded_from = $5 AND recorded_to IS NULL RETURNING ${target.idColumn} AS id`,
          [change.recordedTo, change.source, change.id, change.validFrom, change.recordedFrom],
        );
        if (changed.rows.length !== 1) {
          throw new Error(`cannot close ${change.kind} assertion "${change.id}" for source "${change.source}" at validFrom ${change.validFrom} and recordedFrom ${change.recordedFrom}`);
        }
      }
    }

    async function openChanges(executor: SqlExecutor, changes: readonly AssertionChange[]): Promise<void> {
      for (const change of changes) assertRecordScope(change, sourceSet);
      await insertPrepared(executor, preparedRows(changes));
    }

    async function selectStates(executor: SqlExecutor, valid: number, known: number): Promise<LiveState[]> {
      const rows = await executor.query<StateRow>(
        `SELECT id, after_id FROM query_states s WHERE s.source = ANY($1::text[]) AND ${activeFilter('s', '$2', '$3')}`,
        [sources, valid, known],
      );
      return rows.rows.map((row) => ({ id: row.id, ...(row.after_id === null ? {} : { after: row.after_id }) }));
    }

    async function resolveTime(executor: SqlExecutor, at?: QueryTime): Promise<{ time?: ResolvedTime; askedValid: number; error?: QueryError }> {
      const askedValid = at?.valid ?? clock.now();
      const valid = askedValid;
      const known = at?.known ?? clock.now();
      if (at?.state !== undefined) {
        if (!SAFE_ID.test(at.state)) return { askedValid, error: { message: `"${at.state}" is not a state id this model could ever declare`, id: at.state } };
        return { askedValid, time: { valid, known, state: at.state } };
      }
      const visible = await selectStates(executor, valid, known);
      if (visible.length === 0) return { askedValid, time: { valid, known, state: 'as-is' } };
      const root = stateChainRoot(visible);
      if (root === undefined) {
        const candidates = dedupeStateRows(visible).map((state) => state.id).sort(byCodePoint);
        return {
          askedValid,
          error: {
            message: `the state chains disagree at this time; a query with no explicit state cannot choose one — pass one of: ${candidates.join(', ')}`,
            time: askedValid,
            states: candidates,
          },
        };
      }
      return { askedValid, time: { valid, known, state: root } };
    }

    async function elementExists(executor: SqlExecutor, id: string, time: ResolvedTime): Promise<boolean> {
      const result = await executor.query<{ found: number }>(
        `SELECT 1 AS found FROM query_elements e WHERE e.source = ANY($1::text[]) AND e.id = $2 AND ${activeFilter('e', '$3', '$4')} AND $5 = ANY(e.states) LIMIT 1`,
        [sources, id, time.valid, time.known, time.state],
      );
      return result.rows.length > 0;
    }

    async function activeElements(executor: SqlExecutor, time: ResolvedTime): Promise<ElementRow[]> {
      const result = await executor.query<ElementRow>(
        `SELECT source, id, kind, name, parent, ancestors, states FROM query_elements e WHERE e.source = ANY($1::text[]) AND ${activeFilter('e', '$2', '$3')} AND $4 = ANY(e.states) ORDER BY e.id COLLATE "C"`,
        [sources, time.valid, time.known, time.state],
      );
      return result.rows;
    }

    async function activeRelations(executor: SqlExecutor, time: ResolvedTime): Promise<RelationRow[]> {
      const result = await executor.query<RelationRow>(
        `SELECT source, id, from_id, to_id, refines, states FROM query_relations r WHERE r.source = ANY($1::text[]) AND ${activeFilter('r', '$2', '$3')} AND $4 = ANY(r.states) ORDER BY r.id COLLATE "C"`,
        [sources, time.valid, time.known, time.state],
      );
      return result.rows;
    }

    function reader(executor: SqlExecutor): QuerySnapshot {
      let snapshotActive = true;
      function ensureSnapshotActive(): void {
        if (!snapshotActive) throw new Error('the query snapshot has ended');
      }

      async function children(elementId: string, at?: QueryTime): Promise<ChildrenResult> {
        ensureSnapshotActive();
        const resolved = await resolveTime(executor, at);
        if (resolved.error !== undefined) return { error: resolved.error };
        const time = resolved.time!;
        if (!await elementExists(executor, elementId, time)) {
          return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: resolved.askedValid } };
        }
        const result = await executor.query<ElementRow>(
          `SELECT id, kind, name, parent FROM query_elements e WHERE e.source = ANY($1::text[]) AND e.parent = $2 AND ${activeFilter('e', '$3', '$4')} AND $5 = ANY(e.states) ORDER BY e.id COLLATE "C"`,
          [sources, elementId, time.valid, time.known, time.state],
        );
        return { elements: result.rows.map(answerElement) };
      }

      async function view(input: ViewInput, at?: QueryTime): Promise<ViewResult> {
        ensureSnapshotActive();
        const resolved = await resolveTime(executor, at);
        if (resolved.error !== undefined) return { error: resolved.error };
        const time = resolved.time!;
        const all = await activeElements(executor, time);
        let scopeDepth = 0;
        let context: ViewContext | undefined;
        let scopeRow: ElementRow | undefined;
        if (input.scope !== undefined) {
          if (!await elementExists(executor, input.scope, time)) {
            return { error: { message: `"${input.scope}" does not exist at this time`, id: input.scope, time: resolved.askedValid } };
          }
          scopeRow = all.find((row) => row.id === input.scope);
          if (scopeRow === undefined) {
            return { error: { message: `"${input.scope}" does not exist at this time`, id: input.scope, time: resolved.askedValid } };
          }
          scopeDepth = scopeRow.ancestors.length;
          if (input.context === true) context = { scope: input.scope, scopeAncestors: scopeRow.ancestors };
        }

        const shown = all.filter((row) => {
          if (input.scope === undefined) return row.ancestors.length <= input.depth;
          if (row.id !== input.scope && !row.ancestors.includes(input.scope)) return false;
          return row.ancestors.length - scopeDepth <= input.depth;
        });
        const unsafeId = [...shown.map((row) => row.id), ...(context?.scopeAncestors ?? [])].find((id) => !SAFE_ID.test(id));
        if (unsafeId !== undefined) {
          return { error: { message: `the query engine could not answer: refusing to build a query around an id outside the model's own id pattern: ${JSON.stringify(unsafeId)}` } };
        }
        const elements = shown.map(answerElement);
        const shownIds = new Set(elements.map((element) => element.id));
        const byElementId = new Map(all.map((row) => [row.id, row]));
        const drawRows: DrawableRelation[] = [];

        for (const relation of await activeRelations(executor, time)) {
          const from = byElementId.get(relation.from_id);
          const to = byElementId.get(relation.to_id);
          if (from === undefined || to === undefined) continue;
          if (context !== undefined) {
            const fromInside = from.id === context.scope || from.ancestors.includes(context.scope);
            const toInside = to.id === context.scope || to.ancestors.includes(context.scope);
            if (!fromInside && !toInside) continue;
          }
          const lift = (element: ElementRow): string[] => {
            const nearestShown = [element.id, ...[...element.ancestors].reverse()].filter((id) => shownIds.has(id));
            if (context === undefined) return nearestShown;
            const inside = element.id === context.scope || element.ancestors.includes(context.scope);
            if (inside) return nearestShown;
            return [...element.ancestors, element.id].filter((id) => !context!.scopeAncestors.includes(id)).concat(element.id);
          };
          const fromLift = lift(from);
          const toLift = lift(to);
          if (fromLift.length === 0 || toLift.length === 0) continue;
          const fromId = fromLift[0]!;
          const toId = toLift[0]!;
          if (fromId === toId) continue;
          drawRows.push({
            relationId: relation.id,
            refines: relation.refines,
            fromId,
            toId,
            endsShown: fromId === from.id && toId === to.id,
            ownFrom: relation.from_id,
            ownTo: relation.to_id,
          });
        }

        const relations = drawnRelations(drawRows, context === undefined ? undefined : { scope: context.scope, shown: shownIds });
        if (context === undefined) return { elements, relations };

        const relationIdsByNeighbour = new Map<string, string[]>();
        for (const relation of relations) {
          for (const end of [relation.from, relation.to]) {
            if (!shownIds.has(end)) relationIdsByNeighbour.set(end, [...(relationIdsByNeighbour.get(end) ?? []), ...relation.relationIds]);
          }
        }
        const neighbourIds = [...relationIdsByNeighbour.keys()].sort(byCodePoint);
        const neighbours: ElementAnswer[] = [];
        for (const id of neighbourIds) {
          const row = byElementId.get(id);
          if (row === undefined) {
            const behind = [...relationIdsByNeighbour.get(id)!].sort(byCodePoint).join(', ');
            return { error: { message: `"${id}", the neighbour the relations ${behind} are drawn to or from, does not exist at this time`, id, time: resolved.askedValid } };
          }
          neighbours.push(answerElement(row));
        }
        return { elements, neighbours, relations };
      }

      async function dependencyAnswer(
        elementId: string,
        options: DependenciesInput,
        at: QueryTime | undefined,
        direction: 'dependents' | 'dependencies',
      ): Promise<DependenciesResult> {
        ensureSnapshotActive();
        const resolved = await resolveTime(executor, at);
        if (resolved.error !== undefined) return { error: resolved.error };
        const time = resolved.time!;
        if (!await elementExists(executor, elementId, time)) {
          return { error: { message: `"${elementId}" does not exist at this time`, id: elementId, time: resolved.askedValid } };
        }
        const maxHops = options.transitive === true ? Math.min(MAX_HOPS_CEILING, Math.max(1, options.maxHops ?? MAX_HOPS_CEILING)) : 1;
        const origin = direction === 'dependencies' ? 'from_id' : 'to_id';
        const destination = direction === 'dependencies' ? 'to_id' : 'from_id';
        const query = `WITH RECURSIVE visible_edges AS (
          SELECT id AS relation_id, ${origin} AS origin_id, ${destination} AS destination_id
          FROM query_relations r
          WHERE r.source = ANY($1::text[]) AND ${activeFilter('r', '$2', '$3')} AND $4 = ANY(r.states)
        ), walk(node_id, depth) AS (
          SELECT $5::text, 0
          UNION
          SELECT edge.destination_id, walk.depth + 1
          FROM walk JOIN visible_edges edge ON edge.origin_id = walk.node_id
          WHERE walk.depth < $6
        ), distances AS (
          SELECT node_id, MIN(depth) AS depth FROM walk GROUP BY node_id
        )
        SELECT edge.origin_id, edge.destination_id, edge.relation_id, origin_distance.depth AS depth
        FROM visible_edges edge
        JOIN distances origin_distance ON origin_distance.node_id = edge.origin_id
        JOIN distances destination_distance ON destination_distance.node_id = edge.destination_id AND destination_distance.depth = origin_distance.depth + 1
        ORDER BY origin_distance.depth, edge.origin_id COLLATE "C", edge.destination_id COLLATE "C", edge.relation_id COLLATE "C"`;
        const result = await executor.query<{ origin_id: string; destination_id: string; relation_id: string; depth: number }>(
          query,
          [sources, time.valid, time.known, time.state, elementId, maxHops],
        );
        const bestChains = new Map<string, string[]>([[elementId, []]]);
        let depth = 0;
        while (depth < maxHops) {
          const edges = result.rows.filter((row) => row.depth === depth);
          if (edges.length === 0) break;
          for (const edge of edges) {
            const prefix = bestChains.get(edge.origin_id);
            if (prefix === undefined) continue;
            // Dependents return their relation chain from the dependent back to the queried start.
            const candidate = direction === 'dependents' ? [edge.relation_id, ...prefix] : [...prefix, edge.relation_id];
            const previous = bestChains.get(edge.destination_id);
            if (previous === undefined || compareChains(candidate, previous) < 0) bestChains.set(edge.destination_id, candidate);
          }
          depth++;
        }
        const elements = [...bestChains.entries()]
          .filter(([id]) => id !== elementId)
          .sort(([a], [b]) => byCodePoint(a, b))
          .map(([id, chain]) => ({ id, chain }));
        return { elements };
      }

      const snapshot: QuerySnapshot = {
        children,
        view,
        dependents: (elementId, options, at) => dependencyAnswer(elementId, options, at, 'dependents'),
        dependencies: (elementId, options, at) => dependencyAnswer(elementId, options, at, 'dependencies'),
      };
      Object.defineProperty(snapshot, 'end', { value: () => { snapshotActive = false; }, enumerable: false });
      return snapshot;
    }

    const withSnapshot = <T>(work: (snapshot: QuerySnapshot) => Promise<T>): Promise<T> => {
      try {
        ensureOutsideSnapshot();
        ensureScopeOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      return track(() => gate.snapshot(() => driver.transaction('snapshot', async (executor) => {
        const current = reader(executor) as QuerySnapshot & { end(): void };
        try {
          return await snapshotContext.run(ownerToken, () => work(current));
        } finally {
          current.end();
        }
      })));
    };

    const scopeEntry = { ownerClosed: () => { scopeClosing = true; scopeClosed = true; } };
    scopes.add(scopeEntry);

    const engine: AsyncQueryEngine = {
      children: (elementId, at) => withSnapshot((snapshot) => snapshot.children(elementId, at)),
      view: (input, at) => withSnapshot((snapshot) => snapshot.view(input, at)),
      dependents: (elementId, queryOptions, at) => withSnapshot((snapshot) => snapshot.dependents(elementId, queryOptions, at)),
      dependencies: (elementId, queryOptions, at) => withSnapshot((snapshot) => snapshot.dependencies(elementId, queryOptions, at)),
      withSnapshot,
      rebuild: (assertions: readonly AssertionRecord[]) => {
        try {
          ensureOutsideSnapshot();
          ensureScopeOpen();
          for (const assertion of assertions) assertRecordScope(assertion, sourceSet);
          const rows = preparedRows(assertions);
          return track(() => gate.write(() => driver.transaction('write', async (executor) => {
            await replaceSources(executor);
            await insertPrepared(executor, rows);
          })));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      update: (opened: readonly AssertionChange[], closed: readonly AssertionChange[]) => {
        try {
          ensureOutsideSnapshot();
          ensureScopeOpen();
          for (const change of [...opened, ...closed]) assertRecordScope(change, sourceSet);
          const openedRows = preparedRows(opened);
          return track(() => gate.write(() => driver.transaction('write', async (executor) => {
            await closeChanges(executor, closed);
            await insertPrepared(executor, openedRows);
          })));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      close: () => {
        try {
          ensureOutsideSnapshot();
        } catch (error) {
          return Promise.reject(error);
        }
        if (scopeClosePromise !== undefined) return scopeClosePromise;
        if (scopeClosed) return Promise.resolve();
        scopeClosing = true;
        scopeClosePromise = (async () => {
          await Promise.allSettled([...active]);
          scopeClosed = true;
          scopes.delete(scopeEntry);
        })();
        return scopeClosePromise;
      },
    };

    return engine;
  }

  const database: AsyncQueryDatabase = {
    forSources: (sources) => makeEngine(sources),
    close: () => {
      try {
        ensureOutsideSnapshot();
      } catch (error) {
        return Promise.reject(error);
      }
      if (ownerClosePromise !== undefined) return ownerClosePromise;
      if (ownerClosed) return Promise.resolve();
      ownerClosing = true;
      ownerClosePromise = gate.write(async () => {
        for (const scope of scopes) scope.ownerClosed();
        scopes.clear();
        try {
          await driver.close();
        } finally {
          ownerClosed = true;
        }
      });
      return ownerClosePromise;
    },
  };
  return database;
}
