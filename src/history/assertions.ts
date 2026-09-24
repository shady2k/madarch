import { SCHEMA_VERSION, type CompiledEnvironment, type CompiledModel } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import type { HistoryError } from './types.js';

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
 * nodes and edges (see the glossary's "Graph"), each source's exclusive
 * claim.
 */
export const CLASHABLE_KINDS: readonly AssertionKind[] = ['element', 'interface', 'relation'];

/**
 * The kinds that are shared vocabulary rather than one source's exclusive
 * claim: a source that declares no states at all compiles the same default
 * id, `as-is` (see `compileStates`), and independent sources routinely
 * reuse zone, category and environment ids (`pci`, `personal`,
 * `production`) on purpose. A second source declaring one of these ids does
 * not clash; it must agree with what is already declared (see
 * `SHARED_MERGE_RULE` and `checkSharedVocabularyConflicts`), except
 * `environment`, whose `bindings` merge variable by variable.
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
 * of an environment two sources must still agree on byte for byte, since
 * only `bindings` is allowed to merge variable by variable (the `sources`
 * requirement's environment exception).
 */
export function environmentDefinitionWithoutBindings(content: string): string {
  const parsed = JSON.parse(content) as CompiledEnvironment;
  const { bindings: _bindings, ...rest } = parsed;
  return JSON.stringify(rest);
}

/**
 * Rebuilds a flat list of assertions — one source's own, or several
 * sources' rows already known to satisfy the `sources` requirement — into a
 * compiled model. Each clashable kind (`element`, `interface`, `relation`)
 * has at most one source's row per id by construction (a second source's
 * store is refused before it ever reaches this function). Each shared kind
 * (`category`, `zone`, `state`) may have one row per source sharing an id,
 * always agreeing byte for byte (a disagreement is refused at store time);
 * `environment` rows sharing an id are merged, their `bindings` unioned
 * variable by variable.
 *
 * This function is the last line of defence the `sources` requirement
 * names: "the union read never picks silently" — if it ever meets two
 * different definitions of a shared id (elements, interfaces and relations
 * cannot: a clash there is refused before it is written), or two sources'
 * bindings disagree on one variable's value, it reports an error instead of
 * guessing, naming the id, the disagreeing field, and both sources when
 * they are known.
 */
export function assembleCompiledModel(rows: readonly Assertion[]): { model?: CompiledModel; errors: HistoryError[] } {
  const byKind = new Map<AssertionKind, Assertion[]>(ASSERTION_KINDS.map((kind) => [kind, []]));
  for (const row of rows) byKind.get(row.kind)!.push(row);

  const errors: HistoryError[] = [];

  const plainKind = <T extends { id: string }>(kind: AssertionKind): T[] => {
    const result: T[] = [];
    for (const group of groupById(byKind.get(kind)!)) {
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
  };

  const categories = plainKind<CompiledModel['categories'][number]>('category');
  const zones = plainKind<CompiledModel['zones'][number]>('zone');
  const states = plainKind<CompiledModel['states'][number]>('state');
  const environments = assembleEnvironments(byKind.get('environment')!, errors);
  const elements = plainKind<CompiledModel['elements'][number]>('element');
  const interfaces = plainKind<CompiledModel['interfaces'][number]>('interface');
  const relations = plainKind<CompiledModel['relations'][number]>('relation');

  if (errors.length > 0) return { errors };

  return {
    errors: [],
    model: {
      schemaVersion: SCHEMA_VERSION,
      elements,
      interfaces,
      relations,
      categories,
      zones,
      environments,
      states,
    } as CompiledModel,
  };
}

/**
 * Merges every source's rows for one environment id into one
 * `CompiledEnvironment`: the definition besides `bindings` must already
 * agree (checked, and refused, at store time — this is the same safety net
 * `plainKind` applies), and `bindings` is the union of every source's
 * variables. Two sources binding the same variable to different values is a
 * conflict `checkSharedVocabularyConflicts` already refuses before it can
 * be written; met here regardless, it is reported rather than resolved by
 * picking one source's value over the other's.
 */
function assembleEnvironments(rows: readonly Assertion[], errors: HistoryError[]): CompiledEnvironment[] {
  const result: CompiledEnvironment[] = [];
  for (const group of groupById(rows)) {
    const id = group[0]!.id;
    const withoutBindings = new Set(group.map((row) => environmentDefinitionWithoutBindings(row.content)));
    if (withoutBindings.size > 1) {
      // Two distinct definitions means at least two rows in this group.
      const [, second] = group as [Assertion, Assertion, ...Assertion[]];
      errors.push({ message: `environment "${id}" is declared differently across sources`, id, field: 'environment', source: second.source });
      continue;
    }
    const merged: CompiledEnvironment = JSON.parse(withoutBindings.values().next().value as string) as CompiledEnvironment;
    const bindings: Record<string, string> = {};
    for (const row of group) {
      const parsed = JSON.parse(row.content) as CompiledEnvironment;
      for (const [key, value] of Object.entries(parsed.bindings ?? {})) {
        if (bindings[key] !== undefined && bindings[key] !== value) {
          errors.push({ message: `environment "${id}" binds "${key}" differently across sources`, id, field: key, source: row.source });
          continue;
        }
        bindings[key] = value;
      }
    }
    if (Object.keys(bindings).length > 0) {
      merged.bindings = Object.fromEntries(sortedByCodePointKeys(bindings).map((key) => [key, bindings[key]!]));
    }
    result.push(merged);
  }
  return sortById(result);
}

function sortedByCodePointKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort(byCodePoint);
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

function sortById<T extends { id: string }>(entities: T[]): T[] {
  return [...entities].sort((a, b) => byCodePoint(a.id, b.id));
}

/**
 * Whether a set of states (one source's own, or several agreeing sources'
 * union) forms exactly one chain: one state with no `after`, every other
 * state named by exactly one `after`, no state left unreached and no cycle.
 * Each source's own chain is already validated this way before it can be
 * compiled (see `computeStateOrder`); this re-checks the *union* a store
 * would produce, since two independently valid chains can still disagree
 * about what comes after their shared root.
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
