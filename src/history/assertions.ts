import { SCHEMA_VERSION, type CompiledModel } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';

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

const KIND_TO_FIELD: Record<AssertionKind, keyof CompiledModel> = {
  element: 'elements',
  interface: 'interfaces',
  relation: 'relations',
  category: 'categories',
  zone: 'zones',
  environment: 'environments',
  state: 'states',
};

/** One source's claim about one entity: which kind, which id, and its content as canonical JSON. */
export interface Assertion {
  kind: AssertionKind;
  id: string;
  content: string;
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
 * Rebuilds a compiled model from a flat list of assertions — the inverse of
 * `assertionsOf`, used to answer a `read`. Each kind's entities are
 * deduplicated by id (reading the union of every source can otherwise hand
 * back the same id twice, once per source that happens to assert it — see
 * the `sources` requirement, where a category, zone, environment or state
 * id, unlike an element's, is shared vocabulary rather than one source's
 * exclusive claim, so more than one source legitimately asserts it) and
 * then sorted by id, code point order, the same order `compileModel`
 * produces. `JSON.parse` of an entity's own canonical text restores it with
 * its original key order, so a `read` at a stored commit's exact time
 * reproduces the stored model byte for byte (see the lossless requirement).
 */
export function assembleCompiledModel(rows: readonly Assertion[]): CompiledModel {
  const byKind = new Map<AssertionKind, Assertion[]>(ASSERTION_KINDS.map((kind) => [kind, []]));
  for (const row of rows) byKind.get(row.kind)!.push(row);

  const entitiesOf = <T>(kind: AssertionKind): T[] =>
    dedupeById(byKind.get(kind)!)
      .sort((a, b) => byCodePoint(a.id, b.id))
      .map((row) => JSON.parse(row.content) as T);

  return {
    schemaVersion: SCHEMA_VERSION,
    elements: entitiesOf('element'),
    interfaces: entitiesOf('interface'),
    relations: entitiesOf('relation'),
    categories: entitiesOf('category'),
    zones: entitiesOf('zone'),
    environments: entitiesOf('environment'),
    states: entitiesOf('state'),
  } as CompiledModel;
}

/**
 * Keeps one assertion per id: the one with the code-point-smallest content,
 * so the pick never depends on which source was read first. Two sources
 * sharing a vocabulary id in agreement (the common case: the same default
 * state, the same well-known zone) hand back identical content and the
 * choice is moot; sharing it in disagreement still yields one definite,
 * repeatable answer rather than one that depends on read order.
 */
function dedupeById(rows: readonly Assertion[]): Assertion[] {
  const byId = new Map<string, Assertion>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing === undefined || byCodePoint(row.content, existing.content) < 0) byId.set(row.id, row);
  }
  return [...byId.values()];
}
