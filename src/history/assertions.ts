import {
  SCHEMA_VERSION,
  type CompiledCategory,
  type CompiledElement,
  type CompiledEnvironment,
  type CompiledInterface,
  type CompiledModel,
  type CompiledRelation,
  type CompiledState,
  type CompiledZone,
} from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import type { Discrepancy, HistoryError } from './types.js';

/**
 * The seven kinds of assertion the history keeps, one per array
 * `compileModel` builds (see design.md, "From files to answers": each
 * element, relation, interface, zone membership, binding, environment and
 * state is one assertion of its source). Zone membership and bindings are
 * carried inside the element and relation they belong to
 * (`zonesByEnvironment`, `binding`/`bindingByEnvironment`), so they are
 * closed and opened together with that element or relation, never as
 * assertions of their own.
 */
export const ASSERTION_KINDS = ['element', 'interface', 'relation', 'category', 'zone', 'environment', 'state'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

/**
 * The kinds one source claims exclusively (the `sources` requirement): a
 * second source declaring an already-declared id of one of these kinds is
 * refused outright. Elements, interfaces and relations are the graph's own
 * nodes and edges, each source's exclusive claim.
 */
export const CLASHABLE_KINDS: readonly AssertionKind[] = ['element', 'interface', 'relation'];

/**
 * The kinds that are shared vocabulary rather than one source's exclusive
 * claim: a source that declares no states at all compiles the same default
 * id, `as-is` (see `compileStates`), and independent sources routinely
 * reuse zone, category and environment ids (`pci`, `personal`,
 * `production`) on purpose. The owner's rule (2026-09-24): nothing about a
 * shared id is ever refused — a connection is recorded, not rejected, on
 * the reading that two sources sharing an id simply have different
 * endpoints. Two sources declaring one of these ids differently is reported
 * as a `Discrepancy` on the union read instead (see `assembleCompiledModel`,
 * `ReadModel`).
 */
export const SHARED_KINDS: readonly AssertionKind[] = ['category', 'zone', 'environment', 'state'];

const KIND_TO_FIELD: Record<AssertionKind, keyof CompiledModel> = {
  element: 'elements',
  interface: 'interfaces',
  relation: 'relations',
  category: 'categories',
  zone: 'zones',
  environment: 'environments',
  state: 'states',
};

/** One source's claim about one entity: which kind, which id, its content as canonical JSON, and (when known) whose claim it is. */
export interface Assertion {
  kind: AssertionKind;
  id: string;
  content: string;
  source?: string;
}

/**
 * Decomposes a compiled model into one assertion per element, interface,
 * relation, category, zone, environment and state. `compileModel` already
 * builds every one of these objects with a fixed key order (see
 * `compile.ts`'s module doc and `serializeCompiledModel`), so
 * `JSON.stringify` of one entity alone already gives it canonical,
 * deterministic bytes — nothing here re-derives that order.
 */
export function assertionsOf(model: CompiledModel): Assertion[] {
  const assertions: Assertion[] = [];
  for (const kind of ASSERTION_KINDS) {
    const field = KIND_TO_FIELD[kind];
    for (const entity of model[field] as readonly { id: string }[]) {
      assertions.push({ kind, id: entity.id, content: JSON.stringify(entity) });
    }
  }
  return assertions;
}

/**
 * A `CompiledEnvironment`'s definition with `bindings` left out — the part
 * of an environment that is a plain shared-kind definition like a zone's or
 * a category's (identical across every source that shares the id, or
 * reported as a `Discrepancy` when it is not). `bindings` is never part of
 * this: it always carries every source's own values, per source, never
 * merged or compared byte for byte against another source's (see
 * `assembleEnvironments`).
 */
export function environmentDefinitionWithoutBindings(content: string): string {
  const parsed = JSON.parse(content) as CompiledEnvironment;
  const { bindings: _bindings, ...rest } = parsed;
  return JSON.stringify(rest);
}

/** One other source's definition of a shared id, kept alongside the primary one it differs from. */
export interface AlsoDefinedAs<T> {
  source: string;
  definition: T;
}

/**
 * A shared-kind entity (`category`, `zone` or `state`) as the union read
 * returns it: every source's definition is kept. When every source sharing
 * the id agrees, `alsoDefinedAs` is left out entirely and the entity is the
 * one, agreed definition, exactly as `CompiledModel` already shapes it. When
 * sources disagree, the entity is the primary definition (the one whose
 * earliest-sorted source, by code point, holds it) plus `alsoDefinedAs`: one
 * entry per other distinct definition, each attributed to its own
 * earliest-sorted source. Which definition is "primary" is otherwise
 * arbitrary — the whole point is that no source's definition is dropped,
 * and `discrepancies` (see `ReadResult`) always names every source
 * involved, not only the primary one.
 */
export type SharedEntity<T> = T & { alsoDefinedAs?: AlsoDefinedAs<T>[] };

/**
 * An environment's definition without `bindings`, as a plain shared-kind
 * definition.
 */
export type EnvironmentDefinition = Omit<CompiledEnvironment, 'bindings'>;

/**
 * A `CompiledEnvironment` as the union read returns it. Bindings belong to
 * their source (the owner's decision: "There is a connection, so we record
 * it; it means they have different endpoints"), so they are never merged
 * into one map the way `plainKind`'s shared kinds are: `bindingsBySource`
 * keys every source that binds at least one variable of this environment to
 * its own bindings, in full — two sources binding the same variable to
 * different values are both kept, neither lost. The rest of the
 * definition (`name`, and any future field besides `bindings`) still
 * follows the ordinary shared-kind rule: one agreed definition, or the
 * primary plus `alsoDefinedAs` when sources disagree.
 */
export interface ReadEnvironment extends SharedEntity<EnvironmentDefinition> {
  bindingsBySource?: Record<string, Record<string, string>>;
}

/**
 * The model a union (or single-source) read returns. Elements, interfaces
 * and relations stay each one source's exclusive claim, unchanged from
 * `CompiledModel` (item 5 of the owner's rule: a second source declaring
 * one over an overlapping valid span is still refused before a read could
 * ever see two of them). Categories, zones, environments and states are
 * shared vocabulary: identical definitions merge into one, as before, but a
 * disagreement is now kept (see `SharedEntity`, `ReadEnvironment`) rather
 * than refusing the whole read.
 */
export interface ReadModel {
  schemaVersion: typeof SCHEMA_VERSION;
  elements: CompiledElement[];
  interfaces: CompiledInterface[];
  relations: CompiledRelation[];
  categories: SharedEntity<CompiledCategory>[];
  zones: SharedEntity<CompiledZone>[];
  environments: ReadEnvironment[];
  states: SharedEntity<CompiledState>[];
}

/**
 * Rebuilds a flat list of assertions — one source's own, or several
 * sources' rows already known to satisfy the `sources` requirement's
 * exclusivity for `CLASHABLE_KINDS` — into a `ReadModel`. Each clashable
 * kind (`element`, `interface`, `relation`) has at most one source's row
 * per id by construction (a second source's store is refused before it
 * ever reaches this function); meeting two here regardless (data written
 * outside `store()`) is a real failure, reported in `errors`, since there
 * is no reading — no owner's rule — under which the union read could pick
 * one of two claimed owners for the same node or edge. Every shared kind
 * (`category`, `zone`, `environment`, `state`) is assembled instead: one
 * definition when every source sharing the id agrees, the primary
 * definition plus every other one in `alsoDefinedAs` when they do not — and
 * a `Discrepancy` recorording who disagrees, never an error (`errors` is for
 * `CLASHABLE_KINDS` violations only).
 */
export function assembleCompiledModel(rows: readonly Assertion[]): { model?: ReadModel; discrepancies: Discrepancy[]; errors: HistoryError[] } {
  const byKind = new Map<AssertionKind, Assertion[]>(ASSERTION_KINDS.map((kind) => [kind, []]));
  for (const row of rows) byKind.get(row.kind)!.push(row);

  const errors: HistoryError[] = [];
  const discrepancies: Discrepancy[] = [];

  const elements = exclusiveKind<CompiledElement>('element', byKind.get('element')!, errors);
  const interfaces = exclusiveKind<CompiledInterface>('interface', byKind.get('interface')!, errors);
  const relations = exclusiveKind<CompiledRelation>('relation', byKind.get('relation')!, errors);

  if (errors.length > 0) return { errors, discrepancies };

  const categories = sharedKind<CompiledCategory>('category', byKind.get('category')!, discrepancies);
  const zones = sharedKind<CompiledZone>('zone', byKind.get('zone')!, discrepancies);
  const states = sharedKind<CompiledState>('state', byKind.get('state')!, discrepancies);
  reportChainDiscrepancy(byKind.get('state')!, states, discrepancies);
  const environments = assembleEnvironments(byKind.get('environment')!, discrepancies);

  return {
    errors: [],
    discrepancies,
    model: {
      schemaVersion: SCHEMA_VERSION,
      elements,
      interfaces,
      relations,
      categories,
      zones,
      environments,
      states,
    },
  };
}

/**
 * Assembles one source's own rows into the plain `CompiledModel` it was
 * stored as — never a `ReadModel`: a single source can never disagree with
 * itself, so `bindingsBySource`/`alsoDefinedAs` never apply, and a
 * source-filtered read stays lossless, byte for byte, with what `store`
 * was given (the `lossless` requirement). Every kind is assembled with
 * `exclusiveKind`, shared kinds included: at most one row per id can ever
 * be current for one source at once (`store` never leaves two), so meeting
 * two here regardless (data written outside `store()`) is exactly as real a
 * failure as a `CLASHABLE_KINDS` clash is for the union read.
 */
export function assembleSourceModel(rows: readonly Assertion[]): { model?: CompiledModel; errors: HistoryError[] } {
  const byKind = new Map<AssertionKind, Assertion[]>(ASSERTION_KINDS.map((kind) => [kind, []]));
  for (const row of rows) byKind.get(row.kind)!.push(row);

  const errors: HistoryError[] = [];
  const elements = exclusiveKind<CompiledElement>('element', byKind.get('element')!, errors);
  const interfaces = exclusiveKind<CompiledInterface>('interface', byKind.get('interface')!, errors);
  const relations = exclusiveKind<CompiledRelation>('relation', byKind.get('relation')!, errors);
  const categories = exclusiveKind<CompiledCategory>('category', byKind.get('category')!, errors);
  const zones = exclusiveKind<CompiledZone>('zone', byKind.get('zone')!, errors);
  const environments = exclusiveKind<CompiledEnvironment>('environment', byKind.get('environment')!, errors);
  const states = exclusiveKind<CompiledState>('state', byKind.get('state')!, errors);

  if (errors.length > 0) return { errors };
  return { errors: [], model: { schemaVersion: SCHEMA_VERSION, elements, interfaces, relations, categories, zones, environments, states } };
}

/**
 * Assembles one clashable kind (`element`, `interface`, `relation`): a real
 * disagreement here is a safety net's finding, not the ordinary case — a
 * clash for these kinds is always refused before it reaches storage (see
 * `sqlite-history.ts`'s `store`) — so it is reported in `errors`, exactly
 * as before this rule change (only the shared kinds' handling moved from
 * refusing to recording a `Discrepancy`).
 */
function exclusiveKind<T extends { id: string }>(kind: AssertionKind, rows: readonly Assertion[], errors: HistoryError[]): T[] {
  const result: T[] = [];
  for (const group of groupById(rows)) {
    const distinctContents = new Set(group.map((row) => row.content));
    if (distinctContents.size > 1) {
      // Two distinct contents means at least two rows, so `second` is
      // always defined here; disagreement never arises from a group of one.
      const [first, second] = group as [Assertion, Assertion, ...Assertion[]];
      errors.push({
        message: `"${first.id}" is declared differently across sources for kind "${kind}"`,
        id: first.id,
        field: kind,
        source: second.source,
      });
      continue;
    }
    result.push(JSON.parse(group[0]!.content) as T);
  }
  return sortById(result);
}

/**
 * Assembles one shared kind (`category`, `zone` or `state`): sources
 * agreeing on an id's definition merge into the one, plain definition, as
 * `plainKind` always did; sources disagreeing keep every one of their
 * definitions (`SharedEntity.alsoDefinedAs`), with a `Discrepancy` recording
 * every source involved (`field` is the kind's own name, matching the
 * `field` a store-time clash used to carry for these kinds before this rule
 * changed refusal to recording).
 */
function sharedKind<T extends { id: string }>(kind: AssertionKind, rows: readonly Assertion[], discrepancies: Discrepancy[]): SharedEntity<T>[] {
  const result: SharedEntity<T>[] = [];
  for (const group of groupById(rows)) {
    const { entry, allSources } = mergeGroup<T>(group);
    if (allSources.length > 0) {
      discrepancies.push({ kind, id: group[0]!.id, sources: allSources, field: kind });
    }
    result.push(entry);
  }
  return sortById(result);
}

/**
 * Groups one id's rows by their distinct content, picks the definition of
 * the earliest-sorted (code point) source as primary, and returns it
 * together with every other distinct definition as `alsoDefinedAs` — or
 * just the primary, with `alsoDefinedAs` left out, when every row's content
 * agrees. `allSources` is every source in the group, sorted, but only
 * non-empty when there really was more than one distinct content: an empty
 * array there is the caller's signal that nothing disagreed, so no
 * `Discrepancy` is recorded.
 */
function mergeGroup<T>(group: readonly Assertion[]): { entry: SharedEntity<T>; allSources: string[] } {
  const byContent = new Map<string, string[]>();
  for (const row of group) {
    const sources = byContent.get(row.content);
    if (sources === undefined) byContent.set(row.content, [row.source!]);
    else sources.push(row.source!);
  }
  const contentGroups = [...byContent.entries()]
    .map(([content, sources]) => ({ content, sources: [...sources].sort(byCodePoint) }))
    .sort((a, b) => byCodePoint(a.sources[0]!, b.sources[0]!));

  const primary = contentGroups[0]!;
  const entry = JSON.parse(primary.content) as SharedEntity<T>;
  if (contentGroups.length === 1) return { entry, allSources: [] };

  entry.alsoDefinedAs = contentGroups.slice(1).map((group) => ({ source: group.sources[0]!, definition: JSON.parse(group.content) as T }));
  const allSources = [...new Set(group.map((row) => row.source!))].sort(byCodePoint);
  return { entry, allSources };
}

/**
 * Whether the union of every currently-visible state row still forms one
 * chain (see `isOneStateChain`), using each id's primary definition when
 * sources disagree on it (already recorded as its own `Discrepancy` by
 * `sharedKind`) — a source's own chain always validates on its own at
 * compile time (`computeStateOrder`), but the union several sources'
 * chains form together can still branch or cycle without any single id
 * disagreeing at all (two different sources naming two different states
 * "after" the same shared one). That no longer refuses the store or the
 * read (the owner's rule): it is recorded here as the one chain-wide
 * `Discrepancy` state can carry, `id` the sentinel `"*"` since it belongs
 * to no single state, `field: "order"`, `sources` every source that
 * asserts any currently-visible state.
 */
function reportChainDiscrepancy(rows: readonly Assertion[], states: readonly SharedEntity<CompiledState>[], discrepancies: Discrepancy[]): void {
  if (rows.length === 0) return;
  if (!isOneStateChain(states)) {
    const sources = [...new Set(rows.map((row) => row.source!))].sort(byCodePoint);
    discrepancies.push({ kind: 'state', id: '*', sources, field: 'order' });
  }
}

/**
 * Merges every source's rows for one environment id into one
 * `ReadEnvironment`: the definition besides `bindings` follows the ordinary
 * shared-kind rule (`mergeGroup`) — one agreed definition, or the primary
 * plus every other in `alsoDefinedAs` when sources disagree, with a
 * `Discrepancy` (`field: "environment"`) recording who. `bindings` is never
 * part of that comparison: it is kept per source in `bindingsBySource`, one
 * entry per source that binds at least one variable, in full. Two sources
 * binding the same variable to different values is not refused either any
 * more — both values are kept, one per source — but it is still worth
 * knowing about, so it is recorded as its own `Discrepancy`
 * (`field: <variable name>`), one per variable that disagrees.
 */
function assembleEnvironments(rows: readonly Assertion[], discrepancies: Discrepancy[]): ReadEnvironment[] {
  const result: ReadEnvironment[] = [];
  for (const group of groupById(rows)) {
    const id = group[0]!.id;
    const definitionRows = group.map((row) => ({ ...row, content: environmentDefinitionWithoutBindings(row.content) }));
    const { entry, allSources } = mergeGroup<EnvironmentDefinition>(definitionRows);
    if (allSources.length > 0) {
      discrepancies.push({ kind: 'environment', id, sources: allSources, field: 'environment' });
    }

    const bindingsBySource: Record<string, Record<string, string>> = {};
    const bindingSources = new Map<string, string[]>(); // variable name -> the sources that bind it, in the order seen
    for (const row of group) {
      const parsed = JSON.parse(row.content) as CompiledEnvironment;
      if (parsed.bindings === undefined || Object.keys(parsed.bindings).length === 0) continue;
      bindingsBySource[row.source!] = Object.fromEntries(sortedKeys(parsed.bindings).map((key) => [key, parsed.bindings![key]!]));
      for (const key of Object.keys(parsed.bindings)) {
        const sources = bindingSources.get(key);
        if (sources === undefined) bindingSources.set(key, [row.source!]);
        else sources.push(row.source!);
      }
    }

    for (const [key, sources] of bindingSources) {
      const values = new Set(sources.map((source) => bindingsBySource[source]![key]));
      if (values.size > 1) {
        discrepancies.push({ kind: 'environment', id, sources: [...new Set(sources)].sort(byCodePoint), field: key });
      }
    }

    const readEnvironment: ReadEnvironment = { ...entry };
    if (Object.keys(bindingsBySource).length > 0) {
      readEnvironment.bindingsBySource = sortedByKeyOf(bindingsBySource);
    }
    result.push(readEnvironment);
  }
  return sortById(result);
}

function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort(byCodePoint);
}

/** A record's own keys rebuilt in code-point order, so the assembled result never depends on which source was seen first. */
function sortedByKeyOf<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort(byCodePoint)) sorted[key] = record[key]!;
  return sorted;
}

/** Groups assertions by id, preserving the order ids first appear in. */
function groupById(rows: readonly Assertion[]): Assertion[][] {
  const byId = new Map<string, Assertion[]>();
  for (const row of rows) {
    const group = byId.get(row.id);
    if (group === undefined) byId.set(row.id, [row]);
    else group.push(row);
  }
  return [...byId.values()];
}

function sortById<T extends { id: string }>(entities: readonly T[]): T[] {
  return [...entities].sort((a, b) => byCodePoint(a.id, b.id));
}

/**
 * Whether a set of states (one source's own, or several sources' union) forms
 * exactly one chain: one state with no `after`, every other state named by
 * exactly one `after`, no state left unreached and no cycle. Each source's
 * own chain is already validated this way before it can be compiled (see
 * `computeStateOrder`); this re-checks the *union* several sources' states
 * would form, since two independently valid chains can still disagree about
 * what comes after their shared root.
 */
export function isOneStateChain(states: readonly { id: string; after?: string }[]): boolean {
  if (states.length <= 1) return true;

  // `followers` maps an "after" target to the one state naming it. A
  // dangling reference (naming an id outside `states`) or two states
  // sharing one target both leave at least one state unreached by the walk
  // below, from the one, sole root: neither needs its own check, since the
  // walk's own count of what it reached — the last line — already catches
  // both, the same way it catches a state joined to no root at all.
  const followers = new Map<string, string>();
  let roots = 0;
  for (const state of states) {
    if (state.after === undefined) roots++;
    else followers.set(state.after, state.id);
  }
  if (roots !== 1) return false;

  const root = states.find((s) => s.after === undefined)!;
  const visited = new Set<string>([root.id]);
  let current = root.id;
  while (followers.has(current)) {
    const next = followers.get(current)!;
    if (visited.has(next)) return false; // a cycle: without this, the walk above would never end
    visited.add(next);
    current = next;
  }
  return visited.size === states.length;
}
