import type { Element, Relation } from './schema.js';

/**
 * Where an element or a relation exists: which environments, and which
 * states. Presence is inherited — an element exists in an environment and a
 * state only where its parent does — narrowed by its own `environments`,
 * `since` and `until`; a relation exists where both its ends exist, narrowed
 * by its own `since`/`until`, and (if it refines another relation) further
 * narrowed by the refined relation's presence, never widened. Used by
 * `validate.ts` to refuse an element or relation that exists nowhere, and by
 * `compile.ts` to fill in each element's and relation's `environments` and
 * `states`.
 *
 * The ids here are always real, declared ids. A model with no environments
 * at all is a special case handled by the caller (`formatEnvironments`):
 * every element is then trivially unrestricted, since an `environments`
 * field could only narrow to an id that exists — and with none declared,
 * none does.
 */
export interface Presence {
  environmentIds: string[];
  stateIds: string[];
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return a.filter((value) => bSet.has(value));
}

/**
 * The chain positions an element or relation occupies: `since` is inclusive,
 * `until` is exclusive. Safe to assume `stateOrder` is the valid chain and
 * `since`/`until` (when given) name states in it.
 */
export function computeStatesRange(since: string | undefined, until: string | undefined, stateOrder: readonly string[]): string[] {
  const sinceIndex = since !== undefined ? stateOrder.indexOf(since) : 0;
  const untilIndex = until !== undefined ? stateOrder.indexOf(until) : stateOrder.length;
  if (sinceIndex < 0 || untilIndex < 0) return [...stateOrder];
  return stateOrder.slice(sinceIndex, untilIndex);
}

/**
 * Each element's presence, inherited from its parent and narrowed by its
 * own fields. Safe to assume `parent` is cycle-free.
 */
export function computeElementPresence(
  elements: readonly Element[],
  environmentIds: readonly string[],
  stateOrder: readonly string[],
): Map<string, Presence> {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const cache = new Map<string, Presence>();

  const resolve = (id: string): Presence => {
    const cached = cache.get(id);
    if (cached) return cached;
    const element = byId.get(id);
    // Not one of `elements`: only possible when the model has an unrelated
    // error elsewhere (see the identical guard in `zones.ts`'s
    // `resolveGeneralZones`) — the model will not compile regardless, so
    // this stops the chain here rather than crashing on a lookup that
    // cannot succeed.
    if (!element) {
      const result: Presence = { environmentIds: [], stateIds: [] };
      cache.set(id, result);
      return result;
    }
    const parent: Presence =
      element.parent !== undefined ? resolve(element.parent) : { environmentIds: [...environmentIds], stateIds: [...stateOrder] };

    const own = element.environments;
    const environmentsHere = own !== undefined ? intersect(parent.environmentIds, own) : parent.environmentIds;
    const ownStates = computeStatesRange(element.since, element.until, stateOrder);
    const statesHere = intersect(parent.stateIds, ownStates);

    const result: Presence = { environmentIds: environmentsHere, stateIds: statesHere };
    cache.set(id, result);
    return result;
  };

  for (const element of elements) resolve(element.id);
  return cache;
}

/**
 * Each relation's presence: where both its ends exist, narrowed by its own
 * `since`/`until` and, if it refines another relation, by that relation's
 * presence too. Safe to assume `refines` is cycle-free.
 */
export function computeRelationPresence(
  relations: readonly Relation[],
  elementPresence: ReadonlyMap<string, Presence>,
  stateOrder: readonly string[],
): Map<string, Presence> {
  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const cache = new Map<string, Presence>();

  const resolve = (id: string): Presence => {
    const cached = cache.get(id);
    if (cached) return cached;
    const relation = byId.get(id)!;

    const from = elementPresence.get(relation.from) ?? { environmentIds: [], stateIds: [] };
    const to = elementPresence.get(relation.to) ?? { environmentIds: [], stateIds: [] };
    const ownStates = computeStatesRange(relation.since, relation.until, stateOrder);

    let environmentIds = intersect(from.environmentIds, to.environmentIds);
    let stateIds = intersect(intersect(from.stateIds, to.stateIds), ownStates);

    if (relation.refines !== undefined && byId.has(relation.refines)) {
      const refined = resolve(relation.refines);
      environmentIds = intersect(environmentIds, refined.environmentIds);
      stateIds = intersect(stateIds, refined.stateIds);
    }

    const result: Presence = { environmentIds, stateIds };
    cache.set(id, result);
    return result;
  };

  for (const relation of relations) resolve(relation.id);
  return cache;
}

/**
 * Formats a presence's environment ids for the compiled model: the actual
 * sorted ids, unless the model declares no environments at all, in which
 * case every element and relation is trivially unrestricted (see the module
 * doc), and that is written as the single sentinel id `"*"` rather than an
 * empty list — so a reader can never confuse "every environment" (a model
 * with none declared) with "no environment" (refused before compilation can
 * ever produce it).
 */
export function formatEnvironments(ids: readonly string[], allEnvironmentIds: readonly string[], sortFn: (values: readonly string[]) => string[]): string[] {
  if (allEnvironmentIds.length === 0) return ['*'];
  return sortFn(ids);
}
