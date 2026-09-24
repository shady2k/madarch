import type { Element, Environment } from './schema.js';

/**
 * The one place that works out an element's zones — inherited from its
 * parent, then its own (or, in one environment, that environment's) add,
 * exclude or replace. Used by `validate.ts` (which turns an invalid exclude
 * or an environment change to an absent element into a `ModelError`) and by
 * `compile.ts` (which assumes the model is already valid and only needs the
 * resulting sets).
 */

export interface ZoneChangeLike {
  add?: readonly string[];
  exclude?: readonly string[];
  replace?: readonly string[];
}

export interface ZonesResolution {
  zones: string[];
  /** Indexes into `exclude` naming a zone the base set did not contain. */
  invalidExcludeIndexes: number[];
}

/** Applies one `zones` change (add, exclude or replace) to a base set of zone ids. */
export function applyZonesChange(base: readonly string[], change: ZoneChangeLike | undefined): ZonesResolution {
  if (change?.replace !== undefined) return { zones: [...change.replace], invalidExcludeIndexes: [] };

  let zones = [...base];
  for (const zoneId of change?.add ?? []) {
    if (!zones.includes(zoneId)) zones.push(zoneId);
  }
  const invalidExcludeIndexes: number[] = [];
  (change?.exclude ?? []).forEach((zoneId, index) => {
    if (!zones.includes(zoneId)) invalidExcludeIndexes.push(index);
    zones = zones.filter((existing) => existing !== zoneId);
  });
  return { zones, invalidExcludeIndexes };
}

export interface GeneralZonesResult {
  /** Each element's zones in general (not in any one environment). */
  zonesById: Map<string, string[]>;
  /** Elements whose own `zones.exclude` named a zone they were not in, by index. */
  invalidExcludes: Map<string, number[]>;
}

/**
 * Each element's zones in general: inherited from its parent, then its own
 * add, exclude or replace. Safe to assume `parent` is cycle-free.
 */
export function resolveGeneralZones(elements: readonly Element[]): GeneralZonesResult {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const zonesById = new Map<string, string[]>();
  const invalidExcludes = new Map<string, number[]>();

  const resolve = (id: string): string[] => {
    const cached = zonesById.get(id);
    if (cached) return cached;
    const element = byId.get(id);
    // Not one of `elements`: can only happen when the model has an
    // unrelated error elsewhere (validate.ts's reference check still knows
    // `id` — from another file that failed its own schema — but this
    // function only ever sees the elements that *did* parse). The model
    // will not compile regardless, so there is nothing meaningful to
    // resolve; stopping the chain here, as if it had no zones, just keeps
    // this safe rather than crashing on a lookup that cannot succeed.
    if (!element) {
      zonesById.set(id, []);
      return [];
    }
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    const { zones, invalidExcludeIndexes } = applyZonesChange(parentZones, element.zones);
    if (invalidExcludeIndexes.length > 0) invalidExcludes.set(id, invalidExcludeIndexes);
    zonesById.set(id, zones);
    return zones;
  };

  for (const element of elements) resolve(element.id);
  return { zonesById, invalidExcludes };
}

export interface EnvironmentZonesResult {
  /** Each element's zones in this one environment. */
  zonesById: Map<string, string[]>;
  /** Elements whose exclude, in this environment, named a zone they were not in there, by index. */
  invalidExcludes: Map<string, number[]>;
  /**
   * Elements whose *own* (not per-environment) `zones.exclude` named a zone
   * they were not in *in this environment*, by index into that own
   * `exclude` array — distinct from `invalidExcludes`, which is about the
   * environment's own change. This can happen even when the same exclude is
   * perfectly valid in general: an ancestor's zone can already have been
   * removed earlier, by this same environment, so a descendant's own
   * exclude of it is excluding a zone it never had here.
   */
  ownInvalidExcludes: Map<string, number[]>;
  /** Elements this environment changes the zones of although the element does not exist in it. */
  absentElementIds: Set<string>;
}

/**
 * Each element's zones in one environment: the same inheritance as the
 * general zones, but starting from the ancestor's zones *in this
 * environment*, so that an environment's change to an element is inherited
 * by its descendants too, then applying the environment's own change to
 * this element, if any — refusing (via `invalidExcludes`/`ownInvalidExcludes`/
 * `absentElementIds`) every mistake an element's own `zones` (general or, in
 * this environment, the element's own exclude becoming invalid because of an
 * ancestor's environment-specific change) or an environment's own change can
 * make: excluding a zone the element is not in there, and changing the zones
 * of an element that does not exist in this environment at all.
 */
export function resolveZonesInEnvironment(
  elements: readonly Element[],
  environment: Environment,
  presentElementIds: ReadonlySet<string>,
): EnvironmentZonesResult {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const zonesById = new Map<string, string[]>();
  const invalidExcludes = new Map<string, number[]>();
  const ownInvalidExcludes = new Map<string, number[]>();
  const absentElementIds = new Set<string>();

  const resolve = (id: string): string[] => {
    const cached = zonesById.get(id);
    if (cached) return cached;
    const element = byId.get(id);
    // See the identical guard in `resolveGeneralZones`.
    if (!element) {
      zonesById.set(id, []);
      return [];
    }
    const parentZones = element.parent !== undefined ? resolve(element.parent) : [];
    const own = applyZonesChange(parentZones, element.zones);
    let zones = own.zones;
    if (own.invalidExcludeIndexes.length > 0) ownInvalidExcludes.set(id, own.invalidExcludeIndexes);

    const envChange = environment.zones?.[id];
    if (envChange !== undefined) {
      if (!presentElementIds.has(id)) {
        absentElementIds.add(id);
      } else {
        const { zones: changed, invalidExcludeIndexes } = applyZonesChange(zones, {
          add: envChange.add,
          exclude: envChange.exclude,
        });
        zones = changed;
        if (invalidExcludeIndexes.length > 0) invalidExcludes.set(id, invalidExcludeIndexes);
      }
    }

    zonesById.set(id, zones);
    return zones;
  };

  for (const element of elements) resolve(element.id);
  return { zonesById, invalidExcludes, ownInvalidExcludes, absentElementIds };
}
